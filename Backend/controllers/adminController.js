'use strict';

const crypto    = require('crypto');
const Tenant    = require('../models/tenant');
const TenantSubscription = require('../models/tenantSubscription');
const RoyaltyConfig = require('../models/royaltyConfig');
const emailUtil = require('../utils/email');   // ← whole module, not destructured
const logger    = require('../utils/logger');
const { seedTenantRoles } = require('../utils/seedTenantRoles');
const { escapeRegex } = require('../utils/validation');
const { invalidateAccountAccess } = require('../utils/accountAccess');
const { revokeAllForTenant } = require('../services/apiKey.service');

/*
 * Tenant Management. Every route here is mounted under /api/admin behind
 * protect + requireSuperAdmin (routes/index.js), so only the organisation
 * Super Admin account reaches these handlers. createTenant is the ONLY place
 * in the system that creates a tenant account.
 */

/**
 * Loads the store tenant a Tenant Management action targets. The Super Admin
 * account and team members (sub-users) are not tenants: they are refused
 * here, so e.g. the status endpoint can no longer disable the Super Admin
 * (locking the organisation out) or act on another tenant's staff.
 * Returns the document, or null after sending the error response.
 */
const loadStoreTenant = async (req, res, select = '') => {
  const tenant = await Tenant.findOne({ tenantId: req.params.tenantId }).select(select);
  if (!tenant) {
    res.status(404).json({ success: false, message: 'Tenant not found.' });
    return null;
  }
  if (tenant.role === 'superadmin') {
    res.status(403).json({
      success: false, code: 'FORBIDDEN',
      message: 'The organisation Super Admin account cannot be managed from Tenant Management.',
    });
    return null;
  }
  if (tenant.isSubUser) {
    res.status(403).json({
      success: false, code: 'FORBIDDEN',
      message: 'This is a team member, not a tenant. Team members are managed from their tenant’s Roles & Permissions.',
    });
    return null;
  }
  return tenant;
};

/** Signs a tenant and every member of its team out (all refresh tokens). */
const revokeTenantSessions = async (tenant) => {
  const team = await Tenant.find({ parentTenantId: tenant.tenantId, isSubUser: true }).select('_id').lean();
  await Tenant.updateMany(
    { $or: [{ _id: tenant._id }, { parentTenantId: tenant.tenantId, isSubUser: true }] },
    { $set: { refreshTokens: [] } },
  );
  invalidateAccountAccess([tenant._id, ...team.map(m => m._id)]);
};

const generateTenantId = () =>
  'T-' + crypto.randomBytes(4).toString('hex').toUpperCase();

const safeTenant = (t) => ({
  id          : t._id,
  tenantId    : t.tenantId,
  firstName   : t.firstName,
  lastName    : t.lastName,
  email       : t.email,
  phone       : t.phone,
  businessName: t.businessName,
  city        : t.city,
  currency    : t.currency,
  role        : t.role,
  isActive    : t.isActive,
  isSubUser   : t.isSubUser ?? false,
  setupStep   : t.setupStep,
  createdAt   : t.createdAt,
  razorpay    : { isConfigured: t.razorpay?.isConfigured ?? false },
  crm         : { isConfigured: t.crm?.isConfigured ?? false },
});

// ── POST /api/admin/tenants ───────────────────────────────────────────────────
exports.createTenant = async (req, res, next) => {
  try {
    const {
      firstName, lastName, email, phone,
      businessName, city, currency = 'INR',
    } = req.body;

    const existing = await Tenant.findOne({ email: String(email).toLowerCase() });
    if (existing) {
      return res.status(409).json({
        success: false,
        code   : 'EMAIL_EXISTS',
        message: 'An account with this email already exists.',
      });
    }

    const rawPassword = crypto.randomBytes(12).toString('base64').slice(0, 16) + '@1Aa';
    const tenantId    = generateTenantId();

    const tenant = await Tenant.create({
      firstName, lastName, email, phone,
      businessName, city, currency,
      tenantId,
      role           : 'tenant',
      isActive       : true,
      isEmailVerified: true,
      setupStep      : 'business',
      password       : rawPassword,
    });

    await seedTenantRoles(tenant.tenantId);

    // ── Send welcome email — non-fatal ────────────────────────────────────────
    try {
      // Guard: verify the function exists before calling to get a clear error
      if (typeof emailUtil.sendWelcomeEmail !== 'function') {
        throw new Error(`sendWelcomeEmail is not exported. Available: [${Object.keys(emailUtil).join(', ')}]`);
      }
      await emailUtil.sendWelcomeEmail(tenant, rawPassword);
    } catch (mailErr) {
      logger.error(`[Admin] Welcome email failed for ${email}: ${mailErr.message}`);
    }

    logger.info(`[Admin] Tenant created: ${email} (${tenantId}) by superadmin ${req.user.email}`);

    return res.status(201).json({
      success: true,
      message: `Tenant account created. Credentials sent to ${email}.`,
      data   : safeTenant(tenant),
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/admin/tenants ────────────────────────────────────────────────────
exports.listTenants = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    // Store tenants only — excludes the superadmin account and sub-users.
    const filter = {
      role      : 'tenant',
      isSubUser : { $ne: true },
    };

    if (req.query.search) {
      const re  = new RegExp(escapeRegex(req.query.search), 'i');
      filter.$or = [
        { email: re }, { firstName: re }, { lastName: re }, { businessName: re },
      ];
    }
    if (req.query.active !== undefined) {
      filter.isActive = req.query.active === 'true';
    }

    const [tenants, total] = await Promise.all([
      Tenant.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Tenant.countDocuments(filter),
    ]);

    return res.json({
      success   : true,
      data      : tenants.map(safeTenant),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/admin/tenants/:tenantId ─────────────────────────────────────────
exports.getTenant = async (req, res, next) => {
  try {
    const tenant = await loadStoreTenant(req, res);
    if (!tenant) return;
    return res.json({ success: true, data: safeTenant(tenant) });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/admin/tenants/:tenantId/status ─────────────────────────────────
exports.setTenantStatus = async (req, res, next) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(422).json({ success: false, message: '`isActive` must be a boolean.' });
    }

    const tenant = await loadStoreTenant(req, res);
    if (!tenant) return;

    tenant.isActive = isActive;
    await tenant.save();

    // Disabling takes effect now, not when tokens expire: the tenant and its
    // whole team are signed out, and protect/refresh/login refuse them
    // (utils/accountAccess.js) until the tenant is enabled again.
    if (!isActive) await revokeTenantSessions(tenant);
    else invalidateAccountAccess();

    logger.info(`[Admin] Tenant ${tenant.tenantId} isActive → ${isActive} by superadmin ${req.user.sub}`);
    return res.json({
      success: true,
      message: `Tenant ${isActive ? 'enabled' : 'disabled'} successfully.`,
      data   : safeTenant(tenant),
    });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/admin/tenants/:tenantId ────────────────────────────────────────
exports.updateTenant = async (req, res, next) => {
  try {
    const tenant = await loadStoreTenant(req, res);
    if (!tenant) return;

    // Profile fields only — role, tenantId, isSubUser etc. are never taken
    // from the request body.
    const {
      firstName, lastName, email, phone, businessName, city, currency,
    } = req.body;

    if (email && email.toLowerCase() !== tenant.email) {
      const existing = await Tenant.findOne({ email: email.toLowerCase(), _id: { $ne: tenant._id } });
      if (existing) {
        return res.status(409).json({ success: false, code: 'EMAIL_EXISTS', message: 'Another account already uses this email.' });
      }
      tenant.email = email.toLowerCase();
    }

    if (firstName !== undefined) tenant.firstName = firstName;
    if (lastName !== undefined) tenant.lastName = lastName;
    if (phone !== undefined) tenant.phone = phone;
    if (tenant.role === 'tenant') {
      if (businessName !== undefined) tenant.businessName = businessName;
      if (city !== undefined) tenant.city = city;
      if (currency !== undefined) tenant.currency = currency;
    }

    await tenant.save();

    logger.info(`[Admin] Tenant ${tenant.tenantId} profile updated by ${req.user.email}`);
    return res.json({
      success: true,
      message: 'Account updated successfully.',
      data   : safeTenant(tenant),
    });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/admin/tenants/:tenantId ───────────────────────────────────────
exports.deleteTenant = async (req, res, next) => {
  try {
    const tenant = await loadStoreTenant(req, res);
    if (!tenant) return;

    await revokeTenantSessions(tenant);
    // Integration API keys stop working with the tenant (kept as revoked history).
    await revokeAllForTenant(tenant._id, { actorId: req.user.sub, reason: 'tenant_deleted' });
    await Tenant.deleteMany({ parentTenantId: tenant.tenantId, isSubUser: true });
    await TenantSubscription.deleteOne({ tenantId: tenant.tenantId });
    await RoyaltyConfig.deleteOne({ tenantId: tenant.tenantId });
    await Tenant.deleteOne({ _id: tenant._id });
    invalidateAccountAccess();

    logger.info(`[Admin] Tenant ${tenant.email} (${tenant.tenantId}) deleted by ${req.user.email}`);
    return res.json({
      success: true,
      message: 'Tenant deleted successfully.',
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/admin/tenants/:tenantId/reset-password ─────────────────────────
exports.resetTenantPassword = async (req, res, next) => {
  try {
    const tenant = await loadStoreTenant(req, res, '+password');
    if (!tenant) return;

    const rawPassword    = crypto.randomBytes(12).toString('base64').slice(0, 16) + '@1Aa';
    tenant.password      = rawPassword;
    tenant.refreshTokens = [];        // invalidate all existing sessions
    await tenant.save();

    try {
      if (typeof emailUtil.sendWelcomeEmail !== 'function') {
        throw new Error(`sendWelcomeEmail is not exported. Available: [${Object.keys(emailUtil).join(', ')}]`);
      }
      await emailUtil.sendWelcomeEmail(tenant, rawPassword);
    } catch (mailErr) {
      logger.error(`[Admin] Reset email failed for ${tenant.email}: ${mailErr.message}`);
    }

    logger.info(`[Admin] Password reset for ${tenant.email} by ${req.user.email}`);
    return res.json({
      success: true,
      message: `New credentials sent to ${tenant.email}.`,
    });
  } catch (err) {
    next(err);
  }
};