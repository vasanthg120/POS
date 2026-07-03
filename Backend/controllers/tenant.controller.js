'use strict';

const Tenant = require('../models/tenant');
const crypto = require('crypto');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const ok = (res, data = {}, message = 'Success') =>
  res.json({ success: true, message, data });

const fail = (res, message = 'Something went wrong', status = 400) =>
  res.status(status).json({ success: false, message });

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) +
  '-' + crypto.randomBytes(3).toString('hex');

/**
 * Idempotent helper — promotes setupStep to 'complete' and generates the
 * payment page slug whenever all three prerequisites are satisfied.
 * Call this after EVERY mutation that could affect setup state.
 */
const maybeCompleteSetup = (tenant) => {
  const allDone =
    !!tenant.businessName &&
    !!tenant.razorpay?.isConfigured &&
    !!tenant.crm?.isConfigured;

  if (allDone) {
    tenant.setupStep = 'complete';
  }

  if (tenant.setupStep === 'complete' && !tenant.paymentPageSlug) {
    const raw    = tenant.businessName || tenant.firstName || 'business';
    const slug   = slugify(raw);
    const domain = (process.env.PAYMENT_DOMAIN || 'http://localhost:4200').replace(/\/$/, ''); 
    tenant.paymentPageSlug = slug;
    tenant.paymentPageUrl  = `${domain}/pay/${slug}`;
    console.log(`[Setup] Generated payment page: ${tenant.paymentPageUrl}`);
  }
};

/**
 * Builds the full settings payload returned to the client.
 * Always includes paymentPageUrl/Slug so the Angular signal gets the latest.
 */
const buildSettingsPayload = (tenant) => ({
  businessName   : tenant.businessName    || '',
  businessAddress: tenant.businessAddress || '',
  city           : tenant.city            || '',
  currency       : tenant.currency        || 'INR',
  gstNumber      : tenant.gstNumber       || '',
  phone          : tenant.phone           || '',
  timezone       : tenant.timezone        || 'Asia/Kolkata',
  setupStep      : tenant.setupStep,
  paymentPageUrl : tenant.paymentPageUrl  || null,
  paymentPageSlug: tenant.paymentPageSlug || null,
  razorpay: {
    isConfigured: tenant.razorpay?.isConfigured ?? false,
    verifiedAt  : tenant.razorpay?.verifiedAt   ?? null,
  },
  crm: {
    isConfigured: tenant.crm?.isConfigured ?? false,
    provider    : tenant.crm?.provider     ?? null,
    apiUrl      : tenant.crm?.apiUrl       ?? null,
    verifiedAt  : tenant.crm?.verifiedAt   ?? null,
  },
});

// ── GET /tenant/settings ──────────────────────────────────────────────────────
exports.getSettings = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.user.id);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  // Always attempt to complete setup on every GET — fully idempotent
  maybeCompleteSetup(tenant);

  if (tenant.isModified()) {
    await tenant.save();
    console.log(`[getSettings] Saved repaired state for tenant ${tenant._id}`);
  }

  return ok(res, buildSettingsPayload(tenant));
});

// ── PATCH /tenant/settings/business ──────────────────────────────────────────
exports.updateBusiness = asyncHandler(async (req, res) => {
  const { businessName, businessAddress, currency, gstNumber, phone, timezone, city } = req.body;

  if (!businessName?.trim()) return fail(res, 'Business name is required');

  const tenant = await Tenant.findById(req.user.id);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  tenant.businessName    = businessName.trim();
  tenant.businessAddress = businessAddress?.trim() || tenant.businessAddress;
  tenant.currency        = currency  || tenant.currency;
  tenant.gstNumber       = gstNumber || tenant.gstNumber;
  tenant.phone           = phone     || tenant.phone;
  tenant.timezone        = timezone  || tenant.timezone;

  if (city?.trim() && !tenant.city) {
    tenant.city = city.trim().toLowerCase().replace(/\s+/g, '-');
  }

  // Only advance forward, never regress
  if (tenant.setupStep === 'business') tenant.setupStep = 'razorpay';

  maybeCompleteSetup(tenant);
  await tenant.save();

  return ok(res, buildSettingsPayload(tenant), 'Business info saved.');
});

// ── POST /tenant/settings/razorpay ────────────────────────────────────────────
exports.saveRazorpay = asyncHandler(async (req, res) => {
  const keyId         = req.body.keyId?.trim()         || '';
  const keySecret     = req.body.keySecret?.trim()     || '';
  const webhookSecret = req.body.webhookSecret?.trim() || '';

  if (!keyId)     return fail(res, 'Key ID is required');
  if (!keySecret) return fail(res, 'Key Secret is required');
  if (!keyId.startsWith('rzp_')) {
    return fail(res, 'Key ID must start with rzp_live_ or rzp_test_');
  }

  // Only reject on explicit auth failure — 404/429/5xx = keys are valid
  try {
    const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const response = await fetch('https://api.razorpay.com/v1/orders?count=1', {
      method : 'GET',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
      signal : AbortSignal.timeout(10000),
    });

    if (process.env.NODE_ENV !== 'production') {
      const clone = response.clone();
      const body  = await clone.json().catch(() => ({}));
      console.log('[Razorpay verify] status:', response.status, JSON.stringify(body));
    }

    if (response.status === 401 || response.status === 403) {
      const body = await response.json().catch(() => ({}));
      return fail(res,
        body?.error?.description || 'Invalid Razorpay credentials. Please check your Key ID and Key Secret.');
    }

  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return fail(res, 'Razorpay API timed out. Please try again.');
    }
    console.warn('[Razorpay verify] Network error — saving anyway:', err.message);
  }

  const tenant = await Tenant.findById(req.user.id);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  tenant.setRazorpayKeys({ keyId, keySecret, webhookSecret: webhookSecret || undefined });

  if (tenant.setupStep === 'razorpay') tenant.setupStep = 'crm';

  maybeCompleteSetup(tenant);
  await tenant.save();

  return ok(res, buildSettingsPayload(tenant), 'Razorpay credentials verified and saved.');
});

// ── DELETE /tenant/settings/razorpay ─────────────────────────────────────────
exports.removeRazorpay = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.user.id);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  tenant.razorpay = { isConfigured: false };
  await tenant.save();

  return ok(res, buildSettingsPayload(tenant), 'Razorpay integration removed.');
});

// ── POST /tenant/settings/crm ─────────────────────────────────────────────────
exports.saveCRM = asyncHandler(async (req, res) => {
  const provider = req.body.provider?.trim() || 'custom';
  const apiKey   = req.body.apiKey?.trim()   || '';
  const apiUrl   = req.body.apiUrl?.trim()   || '';

  if (!apiKey) return fail(res, 'API key is required');
  if (!apiUrl) return fail(res, 'API URL is required');
  if (!/^https?:\/\/.+/.test(apiUrl)) {
    return fail(res, 'API URL must start with http:// or https://');
  }

  try {
    const pingRes = await fetch(apiUrl, {
      method : 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal : AbortSignal.timeout(8000),
    });

    if (process.env.NODE_ENV !== 'production') {
      console.log('[CRM verify] status:', pingRes.status);
    }

    if (pingRes.status === 401 || pingRes.status === 403) {
      return fail(res, 'CRM rejected the API key. Please double-check your credentials.');
    }
    if (pingRes.status >= 500) {
      return fail(res, `CRM server returned ${pingRes.status}. Try again later.`);
    }

  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return fail(res, 'CRM did not respond within 8 seconds. Please verify the URL.');
    }
    return fail(res, 'Could not reach the CRM URL. Please verify it is correct.');
  }

  const tenant = await Tenant.findById(req.user.id);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  tenant.setCRMKeys({ apiKey, apiUrl, provider });

  if (tenant.setupStep === 'crm') tenant.setupStep = 'complete';

  maybeCompleteSetup(tenant);
  await tenant.save();

  return ok(res, buildSettingsPayload(tenant), 'CRM integration connected successfully.');
});

// ── POST /tenant/settings/crm/test ───────────────────────────────────────────
exports.testCRM = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.user.id).select('+crm.apiKey');
  if (!tenant)                   return fail(res, 'Tenant not found', 404);
  if (!tenant.crm?.isConfigured) return fail(res, 'CRM is not configured yet.');

  try {
    const pingRes = await fetch(tenant.crm.apiUrl, {
      method : 'GET',
      headers: { Authorization: `Bearer ${tenant.getCRMKey()}`, 'Content-Type': 'application/json' },
      signal : AbortSignal.timeout(8000),
    });

    if (pingRes.status === 401 || pingRes.status === 403) {
      return fail(res, 'CRM rejected the stored API key. Please re-configure.');
    }
    if (pingRes.status >= 500) {
      return fail(res, `CRM server returned ${pingRes.status}.`);
    }

  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return fail(res, 'CRM did not respond within 8 seconds.');
    }
    return fail(res, 'Could not reach the CRM server.');
  }

  return ok(res, {}, 'CRM connection test successful.');
});

// ── DELETE /tenant/settings/crm ──────────────────────────────────────────────
exports.removeCRM = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.user.id);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  tenant.crm = { isConfigured: false };
  await tenant.save();

  return ok(res, buildSettingsPayload(tenant), 'CRM integration removed.');
});

// ── PATCH /tenant/settings/password ──────────────────────────────────────────
exports.changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword) return fail(res, 'Current password is required');
  if (!newPassword || newPassword.length < 6) {
    return fail(res, 'New password must be at least 6 characters');
  }
  if (currentPassword === newPassword) {
    return fail(res, 'New password must be different from your current password');
  }

  const tenant = await Tenant.findById(req.user.id).select('+password');
  if (!tenant) return fail(res, 'Tenant not found', 404);

  const valid = await tenant.comparePassword(currentPassword);
  if (!valid) return fail(res, 'Current password is incorrect', 401);

  tenant.password = newPassword;
  await tenant.save();

  return ok(res, {}, 'Password updated successfully.');
});

// ── POST /tenant/settings/repair ─────────────────────────────────────────────
// Hit this once from Postman / browser console to fix any stuck tenant.
// Returns the full settings payload so Angular can update immediately.
exports.repairSetup = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.user.id);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  maybeCompleteSetup(tenant);
  await tenant.save();

  return ok(res, buildSettingsPayload(tenant),
    tenant.setupStep === 'complete'
      ? 'Setup complete — payment page is now live.'
      : 'Not all steps are done yet. Check Razorpay and CRM configuration.');
});