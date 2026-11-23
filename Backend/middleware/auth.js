'use strict';

const jwt    = require('../utils/jwt');
const logger = require('../utils/logger');
const { checkAccountAccess, stripReservedPermissions } = require('../utils/accountAccess');

const protect = async (req, res, next) => {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        code   : 'NO_TOKEN',
        message: 'Access denied. No token provided.',
      });
    }

    const token = auth.split(' ')[1];
    let payload;
    try {
      payload = jwt.verifyAccessToken(token);
    } catch (err) {
      const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
      return res.status(401).json({
        success: false,
        code,
        message: code === 'TOKEN_EXPIRED'
          ? 'Session expired. Please log in again.'
          : 'Invalid token.',
      });
    }

    req.user = {
      ...payload,

      // sub  → caller's own _id (used for member-scoped ops, e.g. password change)
      // id   → parent's _id for sub-users; own _id for primary tenants.
      //        Every Tenant.findById(req.user.id) in controllers now resolves the
      //        document that actually holds Razorpay / CRM / settings data.
      id: payload.effectiveTenantObjId ?? String(payload.sub),

      // tenantId → parent's tenantId string for sub-users, own for primaries.
      //            Used by RBAC / member controllers to scope DB queries.
      tenantId: payload.effectiveTenantId ?? payload.tenantId,

      // Reserved keys (Tenant Management) are never honoured from a token,
      // even one issued before they were made ungrantable.
      permissions: stripReservedPermissions(payload.permissions),
    };

    // Account state on every request: deleted / disabled / billing-suspended
    // accounts, suspended team members, and team members whose tenant was
    // disabled are refused even while their access token is still valid.
    // (This used to check sub-user suspension only, so a tenant disabled in
    // Tenant Management kept working until it chose to log out.)
    const { account, problem } = await checkAccountAccess(payload.sub);
    if (problem) {
      return res.status(problem.status).json({ success: false, code: problem.code, message: problem.message });
    }
    req.account = account;

    next();
  } catch (err) {
    logger.error(`[AuthMiddleware] ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      code   : 'FORBIDDEN',
      message: 'Insufficient permissions.',
    });
  }
  next();
};

module.exports = { protect, requireRole };