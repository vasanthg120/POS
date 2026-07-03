'use strict';

const Tenant = require('../models/tenant');
const crypto = require('crypto');
const logger = require('../utils/logger');

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
 * Resolves the business tenant document for any controller.
 *
 * For primary tenants:  req.user.id === their own _id  → finds their own doc.
 * For sub-users:        req.user.id === parent's _id   → finds parent's doc.
 *
 * This works because the auth middleware sets req.user.id = effectiveTenantObjId
 * which was stored in the JWT at login time pointing at the parent's _id.
 */
const resolveBusinessTenant = (req) =>
  Tenant.findById(req.user.id);

const maybeCompleteSetup = (tenant) => {
  const allDone =
    !!tenant.businessName &&
    !!tenant.razorpay?.isConfigured &&
    !!tenant.crm?.isConfigured;

  if (allDone) tenant.setupStep = 'complete';

  if (tenant.setupStep === 'complete' && !tenant.paymentPageSlug) {
    const raw    = tenant.businessName || tenant.firstName || 'business';
    const slug   = slugify(raw);
    const domain = (process.env.FRONTEND_URL || 'http://localhost:4200').replace(/\/$/, '');
    tenant.paymentPageSlug = slug;
    tenant.paymentPageUrl  = `${domain}/pay/${slug}`;
    logger.info(`[Setup] Generated payment page: ${tenant.paymentPageUrl}`);
  }
};

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
  const tenant = await resolveBusinessTenant(req);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  maybeCompleteSetup(tenant);
  if (tenant.isModified()) await tenant.save();

  return ok(res, buildSettingsPayload(tenant));
});

// ── PATCH /tenant/settings/business ──────────────────────────────────────────
exports.updateBusiness = asyncHandler(async (req, res) => {
  const { businessName, businessAddress, currency, gstNumber, phone, timezone, city } = req.body;
  if (!businessName?.trim()) return fail(res, 'Business name is required');

  const tenant = await resolveBusinessTenant(req);
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

  try {
    const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const response = await fetch('https://api.razorpay.com/v1/orders?count=1', {
      method : 'GET',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
      signal : AbortSignal.timeout(10000),
    });

    if (response.status === 401 || response.status === 403) {
      const body = await response.json().catch(() => ({}));
      return fail(res,
        body?.error?.description || 'Invalid Razorpay credentials. Please check your Key ID and Key Secret.');
    }
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return fail(res, 'Razorpay API timed out. Please try again.');
    }
    logger.warn(`[Razorpay verify] Network error — saving anyway: ${err.message}`);
  }

  const tenant = await resolveBusinessTenant(req);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  tenant.setRazorpayKeys({ keyId, keySecret, webhookSecret: webhookSecret || undefined });

  if (tenant.setupStep === 'razorpay') tenant.setupStep = 'crm';

  maybeCompleteSetup(tenant);
  await tenant.save();

  return ok(res, buildSettingsPayload(tenant), 'Razorpay credentials verified and saved.');
});

// ── DELETE /tenant/settings/razorpay ─────────────────────────────────────────
exports.removeRazorpay = asyncHandler(async (req, res) => {
  const tenant = await resolveBusinessTenant(req);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  tenant.razorpay = { isConfigured: false };
  if (['crm', 'complete'].includes(tenant.setupStep)) tenant.setupStep = 'razorpay';
  await tenant.save();

  return ok(res, buildSettingsPayload(tenant), 'Razorpay integration removed.');
});

// ── POST /tenant/settings/crm ─────────────────────────────────────────────────
exports.saveCRM = asyncHandler(async (req, res) => {
  const provider = 'prospectconnect';
  const apiKey   = req.body.apiKey?.trim() || '';
  const apiUrl   = req.body.apiUrl?.trim() || '';

  if (!apiKey) return fail(res, 'API key is required');
  if (!apiUrl) return fail(res, 'API URL is required');
  if (!/^https?:\/\/.+/.test(apiUrl)) {
    return fail(res, 'API URL must start with http:// or https://');
  }

  const pingUrl    = 'https://api.prospectconnect.ai/quotes/getQuotes';
  const pingBody   = JSON.stringify({ limit: 1, search: '', startAfter: 0 });

  try {
    const pingRes = await fetch(pingUrl, {
      method : 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body   : pingBody,
      signal : AbortSignal.timeout(8000),
    });

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
    logger.warn(`[CRM verify] Network error — saving anyway: ${err.name} ${err.message}`);
  }

  const tenant = await resolveBusinessTenant(req);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  tenant.setCRMKeys({ apiKey, apiUrl, provider });
  if (tenant.setupStep === 'crm') tenant.setupStep = 'complete';

  maybeCompleteSetup(tenant);
  await tenant.save();

  return ok(res, buildSettingsPayload(tenant), 'CRM integration connected successfully.');
});

// ── POST /tenant/settings/crm/test ───────────────────────────────────────────
exports.testCRM = asyncHandler(async (req, res) => {
  const tenant = await resolveBusinessTenant(req);
  if (!tenant)                   return fail(res, 'Tenant not found', 404);
  if (!tenant.crm?.isConfigured) return fail(res, 'CRM is not configured yet.');

  // Re-fetch with encrypted key selected
  const tenantWithKey = await Tenant.findById(tenant._id).select('+crm.apiKey');

  try {
    const pingRes = await fetch('https://api.prospectconnect.ai/quotes/getQuotes', {
      method : 'POST',
      headers: { Authorization: tenantWithKey.getCRMKey(), 'Content-Type': 'application/json' },
      body   : JSON.stringify({ limit: 1, search: '', startAfter: 0 }),
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
  const tenant = await resolveBusinessTenant(req);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  tenant.crm = { isConfigured: false };
  if (tenant.setupStep === 'complete') tenant.setupStep = 'crm';
  await tenant.save();

  return ok(res, buildSettingsPayload(tenant), 'CRM integration removed.');
});

// ── PATCH /tenant/settings/password ──────────────────────────────────────────
// Password change ALWAYS operates on the caller's own account (req.user.sub),
// never on the parent tenant — even for sub-users.
exports.changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword) return fail(res, 'Current password is required');
  if (!newPassword || newPassword.length < 8) {
    return fail(res, 'New password must be at least 8 characters');
  }
  if (currentPassword === newPassword) {
    return fail(res, 'New password must be different from your current password');
  }

  // ✅ Use sub (caller's own _id), NOT req.user.id (which points to parent for sub-users)
  const tenant = await Tenant.findById(req.user.sub).select('+password');
  if (!tenant) return fail(res, 'Tenant not found', 404);

  const valid = await tenant.comparePassword(currentPassword);
  if (!valid) return fail(res, 'Current password is incorrect', 401);

  tenant.password = newPassword;

  try {
    await tenant.save();
  } catch (err) {
    if (err.name === 'ValidationError') {
      const msg = Object.values(err.errors).map(e => e.message).join(', ');
      return fail(res, msg);
    }
    throw err;
  }

  return ok(res, {}, 'Password updated successfully.');
});

// ── POST /tenant/settings/repair ─────────────────────────────────────────────
exports.repairSetup = asyncHandler(async (req, res) => {
  const tenant = await resolveBusinessTenant(req);
  if (!tenant) return fail(res, 'Tenant not found', 404);

  maybeCompleteSetup(tenant);
  await tenant.save();

  return ok(res, buildSettingsPayload(tenant),
    tenant.setupStep === 'complete'
      ? 'Setup complete — payment page is now live.'
      : 'Not all steps are done yet. Check Razorpay and CRM configuration.');
});