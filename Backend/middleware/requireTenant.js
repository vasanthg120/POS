'use strict';

// Roles that are allowed to access tenant-scoped routes.
// Add sub-roles here as you introduce them, OR switch to the
// tenantId-presence check below (recommended).
const TENANT_ROLES = new Set(['tenant', 'superadmin']);

const requireTenant = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      code   : 'NOT_AUTHENTICATED',
      message: 'Authentication required.',
    });
  }

  // ✅ Prefer checking tenantId presence over hard-coded role strings.
  // Any valid JWT with a tenantId belongs to a tenant context.
  if (!req.user.tenantId) {
    return res.status(403).json({
      success: false,
      code   : 'FORBIDDEN',
      message: 'Tenant access required.',
    });
  }

  next();
};

module.exports = requireTenant;