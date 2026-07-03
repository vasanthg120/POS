'use strict';

const jwt    = require('../utils/jwt');
const logger = require('../utils/logger');
const Tenant = require('../models/tenant');

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
    };

    // Check suspension on every request for sub-users
    if (payload.isSubUser) {
      const member = await Tenant
        .findById(payload.sub)
        .select('subUserStatus isSubUser');

      if (!member || member.subUserStatus === 'suspended') {
        return res.status(403).json({
          success: false,
          code   : 'ACCOUNT_SUSPENDED',
          message: 'Your access has been suspended. Contact your administrator.',
        });
      }
    }

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