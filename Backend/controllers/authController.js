'use strict';

const crypto = require('crypto');
const Tenant = require('../models/tenant');
const jwt = require('../utils/jwt');
const email = require('../utils/email');
const logger = require('../utils/logger');
const {
  stripReservedPermissions, accountAccessProblem, invalidateAccountAccess,
} = require('../utils/accountAccess');

// ── Cookie helper ─────────────────────────────────────────────────────────────
const setRefreshCookie = (res, token) => {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api/auth/refresh',
  });
};

// ── Generate unique payment page slug ─────────────────────────────────────────
const generateSlug = async (businessName, city) => {
  const base = `${city || 'pay'}-${businessName || 'store'}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  let slug = base;
  let count = 0;
  while (await Tenant.exists({ paymentPageSlug: slug })) {
    slug = `${base}-${++count}`;
  }
  return slug;
};

// ── No self-registration ─────────────────────────────────────────────────────
// Tenants are created ONLY by the organisation Super Admin through
// POST /api/admin/tenants (adminController.createTenant). The old public
// `register` handler that let anyone create a tenant account has been removed.

// ── Builds the tenant payload returned to Angular on login ────────────────────
const buildLoginTenantPayload = async (tenant) => {
  if (tenant.isSubUser && tenant.parentTenantId) {
    const parent = await Tenant.findOne({ tenantId: tenant.parentTenantId });
    if (parent) {
      return {
        ...sanitizeTenant(parent),
        id: tenant._id,
        tenantId: tenant.tenantId,
        firstName: tenant.firstName,
        lastName: tenant.lastName,
        email: tenant.email,
        phone: tenant.phone,
        role: tenant.role,
      };
    }
    logger.warn(`[Login] Sub-user ${tenant.email} has no resolvable parent tenant (${tenant.parentTenantId})`);
  }
  return sanitizeTenant(tenant);
};

// ── LOGIN ─────────────────────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { email: rawEmail, password } = req.body;
    const ip = req.ip || req.headers['x-forwarded-for'];
    const userAgent = req.headers['user-agent'];

    const tenant = await Tenant
      .findOne({ email: rawEmail.toLowerCase() })
      .select('+password +loginAttempts +lockUntil +refreshTokens +isEmailVerified +isActive +billingSuspended +isSubUser +parentTenantId +rbacRoleId +rbacRoleName +subUserStatus')
      .populate('rbacRoleId', 'permissions');

    if (!tenant) {
      return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
    }

    if (tenant.isSubUser && tenant.subUserStatus === 'suspended') {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_SUSPENDED',
        message: 'Your access has been suspended. Contact your team administrator.',
      });
    }

    if (tenant.isLocked) {
      const remaining = Math.ceil((tenant.lockUntil - Date.now()) / 60000);
      return res.status(423).json({ success: false, code: 'ACCOUNT_LOCKED', message: `Account locked. Try again in ${remaining} minute(s).` });
    }

    const match = await tenant.comparePassword(password);
    if (!match) {
      await tenant.incLoginAttempts();
      return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
    }

    if (!tenant.isEmailVerified) {
      return res.status(403).json({ success: false, code: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email before logging in.' });
    }

    // Disabled / billing-suspended accounts — and team members whose tenant is
    // disabled or suspended (that used to be missed: a disabled tenant's staff
    // could still sign in).
    const accessProblem = await accountAccessProblem(tenant);
    if (accessProblem) {
      return res.status(accessProblem.status).json({
        success: false, code: accessProblem.code, message: accessProblem.message,
      });
    }
    invalidateAccountAccess(tenant._id);

    await Tenant.findByIdAndUpdate(tenant._id, {
      loginAttempts: 0,
      $unset: { lockUntil: 1 },
      lastLogin: new Date(),
      lastLoginIP: ip,
    });

    // ── Resolve parent tenant's MongoDB _id for sub-users ──────────────────
    // This is stored in the JWT so the auth middleware can point req.user.id
    // at the parent document — making every Tenant.findById(req.user.id) call
    // in controllers resolve Razorpay/CRM/settings from the correct document.
    let effectiveTenantObjId = String(tenant._id);

    if (tenant.isSubUser && tenant.parentTenantId) {
      const parentDoc = await Tenant
        .findOne({ tenantId: tenant.parentTenantId })
        .select('_id');
      if (parentDoc) {
        effectiveTenantObjId = String(parentDoc._id);
      } else {
        logger.warn(`[Login] Sub-user ${tenant.email}: parent tenant "${tenant.parentTenantId}" not found`);
      }
    }

    const payload = buildPayload(tenant, effectiveTenantObjId);
    const accessToken = jwt.generateAccessToken(payload);
    const refreshToken = jwt.generateRefreshToken(payload);

    await Tenant.findByIdAndUpdate(tenant._id, {
      $push: { refreshTokens: { $each: [{ token: refreshToken, userAgent, ip }], $slice: -5 } },
    });

    setRefreshCookie(res, refreshToken);
    logger.info(`[Login] ${tenant.email}`);

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      accessToken,
      expiresIn: process.env.JWT_EXPIRES_IN || '15m',
      user: {
        id: tenant._id,
        firstName: tenant.firstName,
        lastName: tenant.lastName,
        email: tenant.email,
        role: tenant.role,
        tenantId: tenant.tenantId,
        businessName: tenant.businessName,
        city: tenant.city,
        currency: tenant.currency,
        setupStep: tenant.setupStep,
        paymentPageUrl: tenant.paymentPageUrl,
        paymentPageSlug: tenant.paymentPageSlug,
        isSubUser: tenant.isSubUser ?? false,
        parentTenantId: tenant.parentTenantId ?? null,
        rbacRoleId: tenant.rbacRoleId?._id ?? tenant.rbacRoleId ?? null,
        rbacRoleName: tenant.rbacRoleName ?? null,
        subUserStatus: tenant.subUserStatus ?? null,
        permissions: tenant.isSubUser
          ? stripReservedPermissions(tenant.rbacRoleId?.permissions)
          : [],
      },
      tenant: await buildLoginTenantPayload(tenant),
    });
  } catch (err) {
    logger.error(`[Login] ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ── VERIFY EMAIL ──────────────────────────────────────────────────────────────
exports.verifyEmail = async (req, res) => {
  try {
    const hashed = crypto.createHash('sha256').update(req.query.token).digest('hex');
    const tenant = await Tenant.findOne({
      emailVerifyToken: hashed,
      emailVerifyExpires: { $gt: Date.now() },
    }).select('+emailVerifyToken +emailVerifyExpires');

    if (!tenant) {
      return res.status(400).json({ success: false, code: 'INVALID_TOKEN', message: 'Verification link is invalid or expired.' });
    }

    tenant.isEmailVerified = true;
    tenant.emailVerifyToken = undefined;
    tenant.emailVerifyExpires = undefined;
    await tenant.save({ validateBeforeSave: false });

    logger.info(`[VerifyEmail] ${tenant.email}`);
    return res.status(200).json({ success: true, message: 'Email verified! You can now log in.' });
  } catch (err) {
    logger.error(`[VerifyEmail] ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ── RESEND VERIFICATION ───────────────────────────────────────────────────────
exports.resendVerification = async (req, res) => {
  const ok = { success: true, message: 'If that email exists and is unverified, a new link has been sent.' };
  try {
    const tenant = await Tenant.findOne({ email: req.body.email.toLowerCase() })
      .select('+isEmailVerified +emailVerifyToken +emailVerifyExpires');

    if (!tenant || tenant.isEmailVerified) return res.status(200).json(ok);

    const token = tenant.createEmailVerifyToken();
    await tenant.save({ validateBeforeSave: false });

    await email.sendVerificationEmail(tenant, token);

    return res.status(200).json(ok);
  } catch (err) {
    logger.error(`[ResendVerify] ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to resend.' });
  }
};

// ── FORGOT PASSWORD ───────────────────────────────────────────────────────────
exports.forgotPassword = async (req, res) => {
  const ok = { success: true, message: 'If that email exists, a reset link has been sent.' };
  try {
    const tenant = await Tenant.findOne({ email: req.body.email.toLowerCase() });
    if (!tenant) return res.status(200).json(ok);

    const token = tenant.createPasswordResetToken();
    await tenant.save({ validateBeforeSave: false });

    try {
      await email.sendPasswordResetEmail(tenant, token);
    } catch (e) {
      tenant.passwordResetToken = undefined;
      tenant.passwordResetExpires = undefined;
      await tenant.save({ validateBeforeSave: false });
      return res.status(500).json({ success: false, message: 'Failed to send reset email.' });
    }

    logger.info(`[ForgotPassword] ${tenant.email}`);
    return res.status(200).json(ok);
  } catch (err) {
    logger.error(`[ForgotPassword] ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ── RESET PASSWORD ────────────────────────────────────────────────────────────
exports.resetPassword = async (req, res) => {
  try {
    const hashed = crypto.createHash('sha256').update(req.body.token).digest('hex');
    const tenant = await Tenant.findOne({
      passwordResetToken: hashed,
      passwordResetExpires: { $gt: Date.now() },
    }).select('+passwordResetToken +passwordResetExpires');

    if (!tenant) {
      return res.status(400).json({ success: false, code: 'INVALID_TOKEN', message: 'Reset token is invalid or expired.' });
    }

    tenant.password = req.body.password;
    tenant.passwordResetToken = undefined;
    tenant.passwordResetExpires = undefined;
    tenant.loginAttempts = 0;
    tenant.lockUntil = undefined;
    tenant.refreshTokens = [];
    await tenant.save();

    email.sendPasswordChangedEmail(tenant).catch(e => logger.error(e.message));
    logger.info(`[ResetPassword] ${tenant.email}`);

    return res.status(200).json({ success: true, message: 'Password reset successful. Please log in.' });
  } catch (err) {
    logger.error(`[ResetPassword] ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ── REFRESH TOKEN ─────────────────────────────────────────────────────────────
exports.refresh = async (req, res) => {
  try {
    const token = req.cookies?.refreshToken;
    if (!token) return res.status(401).json({ success: false, message: 'No refresh token.' });

    let payload;
    try { payload = jwt.verifyRefreshToken(token); }
    catch { return res.status(401).json({ success: false, message: 'Invalid or expired refresh token.' }); }

    const tenant = await Tenant
      .findById(payload.sub)
      .select('+refreshTokens')
      .populate('rbacRoleId', 'permissions');

    if (!tenant) return res.status(401).json({ success: false, message: 'User not found.' });

    const stored = tenant.refreshTokens.find(t => t.token === token);
    if (!stored) {
      await Tenant.findByIdAndUpdate(tenant._id, { refreshTokens: [] });
      return res.status(401).json({ success: false, message: 'Token reuse detected. Please log in again.' });
    }

    // Re-check the account before minting new tokens. Refresh used to skip
    // this, so a tenant disabled in Tenant Management stayed signed in
    // indefinitely by refreshing every 15 minutes.
    const accessProblem = await accountAccessProblem(tenant);
    if (accessProblem) {
      await Tenant.findByIdAndUpdate(tenant._id, { $pull: { refreshTokens: { token } } });
      res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
      return res.status(accessProblem.status).json({
        success: false, code: accessProblem.code, message: accessProblem.message,
      });
    }

    // Re-resolve parent _id in case it changed
    let effectiveTenantObjId = String(tenant._id);
    if (tenant.isSubUser && tenant.parentTenantId) {
      const parentDoc = await Tenant.findOne({ tenantId: tenant.parentTenantId }).select('_id');
      if (parentDoc) effectiveTenantObjId = String(parentDoc._id);
    }

    const newPayload = buildPayload(tenant, effectiveTenantObjId);
    const newRefresh = jwt.generateRefreshToken(newPayload);
    const newAccess = jwt.generateAccessToken(newPayload);

    await Tenant.findByIdAndUpdate(tenant._id, {
      $pull: { refreshTokens: { token } },
      $push: { refreshTokens: { $each: [{ token: newRefresh, ip: req.ip, userAgent: req.headers['user-agent'] }], $slice: -5 } },
    });

    setRefreshCookie(res, newRefresh);
    return res.status(200).json({
      success: true,
      accessToken: newAccess,
      expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    });
  } catch (err) {
    logger.error(`[Refresh] ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ── LOGOUT ────────────────────────────────────────────────────────────────────
exports.logout = async (req, res) => {
  try {
    const token = req.cookies?.refreshToken;
    if (token && req.user) {
      await Tenant.findByIdAndUpdate(req.user.sub, { $pull: { refreshTokens: { token } } });
    }
    res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
    return res.status(200).json({ success: true, message: 'Logged out.' });
  } catch (err) {
    logger.error(`[Logout] ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ── ME ────────────────────────────────────────────────────────────────────────
exports.me = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.sub);
    if (!tenant) return res.status(404).json({ success: false, message: 'User not found.' });
    return res.status(200).json({ success: true, data: sanitizeTenant(tenant) });
  } catch (err) {
    logger.error(`[Me] ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ── Dev: instant verify ───────────────────────────────────────────────────────
exports.devVerifyAccount = async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ success: false });
  try {
    const t = await Tenant.findOne({ email: req.body.email.toLowerCase() }).select('+isEmailVerified');
    if (!t) return res.status(404).json({ success: false, message: 'Not found.' });
    t.isEmailVerified = true;
    t.emailVerifyToken = undefined;
    t.emailVerifyExpires = undefined;
    await t.save({ validateBeforeSave: false });
    return res.status(200).json({ success: true, message: `${t.email} is now verified.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const buildPayUrl = (slug) => {
  const domain = process.env.PAY_DOMAIN || process.env.APP_DOMAIN || 'localhost:4200';
  return `https://${domain}/pay/${slug}`;
};

/**
 * Builds the JWT payload.
 *
 * @param {object} tenant         - The Tenant mongoose document (sub-user or primary)
 * @param {string} parentObjId    - The MongoDB _id (as string) of the parent tenant.
 *                                  For primary tenants this is the same as tenant._id.
 *                                  For sub-users this is the parent's _id, resolved at
 *                                  login time so controllers can call
 *                                  Tenant.findById(req.user.id) and always get the
 *                                  document that holds Razorpay/CRM/settings.
 */
const buildPayload = (tenant, parentObjId = null) => ({
  sub: tenant._id,
  email: tenant.email,
  role: tenant.role,
  tenantId: tenant.tenantId,
  // Controllers use req.user.id → always the parent's _id
  effectiveTenantObjId: parentObjId ?? String(tenant._id),
  // Controllers use req.user.tenantId → always the parent's tenantId string
  effectiveTenantId: tenant.isSubUser
    ? tenant.parentTenantId
    : tenant.tenantId,
  firstName: tenant.firstName,
  lastName: tenant.lastName,
  isSubUser: tenant.isSubUser ?? false,
  parentTenantId: tenant.parentTenantId ?? null,
  rbacRoleId: tenant.rbacRoleId?._id ?? tenant.rbacRoleId ?? null,
  rbacRoleName: tenant.rbacRoleName ?? null,
  subUserStatus: tenant.subUserStatus ?? null,
  // Tenant Management is never carried in a token: reserved keys are stripped
  // even if a legacy role document still holds them.
  permissions: tenant.isSubUser
    ? stripReservedPermissions(tenant.rbacRoleId?.permissions)
    : [],
});

const sanitizeTenant = (t) => ({
  id: t._id,
  tenantId: t.tenantId,
  firstName: t.firstName,
  lastName: t.lastName,
  email: t.email,
  phone: t.phone,
  businessName: t.businessName,
  businessAddress: t.businessAddress,
  city: t.city,
  currency: t.currency,
  gstNumber: t.gstNumber,
  timezone: t.timezone,
  role: t.role,
  setupStep: t.setupStep,
  paymentPageUrl: t.paymentPageUrl,
  paymentPageSlug: t.paymentPageSlug,
  razorpay: { isConfigured: t.razorpay?.isConfigured || false },
  crm: { isConfigured: t.crm?.isConfigured || false, provider: t.crm?.provider },
  createdAt: t.createdAt,
});

module.exports.sanitizeTenant = sanitizeTenant;
module.exports.buildPayUrl = buildPayUrl;
module.exports.generateSlug = generateSlug;