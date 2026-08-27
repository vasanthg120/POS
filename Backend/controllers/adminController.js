'use strict';

const crypto    = require('crypto');
const Tenant    = require('../models/tenant');
const TenantSubscription = require('../models/tenantSubscription');
const RoyaltyConfig = require('../models/royaltyConfig');
const emailUtil = require('../utils/email');   // ← whole module, not destructured
const logger    = require('../utils/logger');
const { seedTenantRoles } = require('../utils/seedTenantRoles');

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

    const existing = await Tenant.findOne({ email });
    if (existing) {
      return res.status(409).json({
        success: false,
        code   : 'EMAIL_EXISTS',
        message: 'A tenant with this email already exists.',
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
      const re  = new RegExp(req.query.search, 'i');
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
    const tenant = await Tenant.findOne({ tenantId: req.params.tenantId });
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found.' });
    }
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

    const tenant = await Tenant.findOneAndUpdate(
      { tenantId: req.params.tenantId },
      { isActive },
      { new: true },
    );
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found.' });
    }

    logger.info(`[Admin] Tenant ${tenant.email} isActive → ${isActive} by ${req.user.email}`);
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
    const tenant = await Tenant.findOne({ tenantId: req.params.tenantId });
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found.' });
    }
    if (tenant.role === 'superadmin') {
      return res.status(403).json({ success: false, message: 'The platform superadmin account cannot be edited here.' });
    }

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
    const tenant = await Tenant.findOne({ tenantId: req.params.tenantId });
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found.' });
    }
    if (tenant.role === 'superadmin') {
      return res.status(403).json({ success: false, message: 'The platform superadmin account cannot be deleted.' });
    }

    await Tenant.deleteMany({ parentTenantId: tenant.tenantId, isSubUser: true });
    await TenantSubscription.deleteOne({ tenantId: tenant.tenantId });
    await RoyaltyConfig.deleteOne({ tenantId: tenant.tenantId });
    await Tenant.deleteOne({ _id: tenant._id });

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
    const tenant = await Tenant.findOne({ tenantId: req.params.tenantId }).select('+password');
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found.' });
    }

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