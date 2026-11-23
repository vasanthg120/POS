'use strict';

const Tenant = require('../models/tenant');
const logger = require('../utils/logger');

/**
 * Gate for everything under /api/admin — Tenant Management (create, edit,
 * disable, delete, reset password), cross-tenant monitoring, billing.
 *
 * Only the organisation Super Admin account passes: role 'superadmin' in the
 * token AND in the database, not a sub-user, and active. Team members the
 * Super Admin invites (sub-users, always role 'tenant') never pass, whatever
 * RBAC permissions they hold.
 *
 * The database check means a token that still says "superadmin" stops
 * working the moment the account is changed or removed, instead of when the
 * token expires. It reads fresh (no cache): admin calls are infrequent and
 * this is the platform's highest-privilege gate.
 *
 * Must run AFTER `protect`.
 */
const requireSuperAdmin = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      code   : 'NOT_AUTHENTICATED',
      message: 'Authentication required.',
    });
  }

  const deny = (reason) => {
    // Account id + tenantId only — no email/PII in the log line.
    logger.warn(`[Access] Super Admin route denied: ${req.method} ${req.originalUrl}`
      + ` account=${req.user.sub} tenantId=${req.user.tenantId} role=${req.user.role}`
      + ` subUser=${!!req.user.isSubUser} reason=${reason}`);
    return res.status(403).json({
      success: false,
      code   : 'FORBIDDEN',
      message: 'Only the organisation Super Admin can access this.',
    });
  };

  if (req.user.role !== 'superadmin') return deny('role');
  if (req.user.isSubUser) return deny('sub-user');

  try {
    const account = await Tenant.findById(req.user.sub).select('role isSubUser isActive').lean();
    if (!account) return deny('account-missing');
    if (account.role !== 'superadmin') return deny('account-role');
    if (account.isSubUser) return deny('account-sub-user');
    if (account.isActive === false) return deny('account-disabled');
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = requireSuperAdmin;
