'use strict';

/**
 * requirePermission(pageKey, action)
 *
 * Enforces RBAC page/action permissions for sub-users.
 *
 * Primary tenants and superadmins (isSubUser === false) always pass — they
 * own their tenant and are not restricted by role permissions.
 *
 * Sub-users must have the given `pageKey` in their JWT `permissions` array
 * with the requested `action` (defaults to 'view').
 *
 * Must run AFTER `protect` (which populates req.user from the JWT).
 */
const requirePermission = (pageKey, action = 'view') => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      code   : 'NOT_AUTHENTICATED',
      message: 'Authentication required.',
    });
  }

  // Primary tenant / superadmin — full access to their own tenant.
  if (!req.user.isSubUser) return next();

  const perms   = req.user.permissions || [];
  const granted = perms
    .find(p => p.pageKey === pageKey)
    ?.actions?.includes(action);

  if (!granted) {
    return res.status(403).json({
      success: false,
      code   : 'FORBIDDEN',
      message: `You do not have permission to ${action} ${pageKey}.`,
    });
  }

  return next();
};

/**
 * requireAnyPermission([pageKeys], action)
 *
 * Same rules as requirePermission, but passes if the sub-user has the given
 * action on ANY of the listed pages. Use this for endpoints that legitimately
 * back more than one RBAC page (e.g. a shared quotes list backing both the
 * Quotations and Tracking pages) so granting either page doesn't lock the
 * other one out of data it also needs.
 */
const requireAnyPermission = (pageKeys, action = 'view') => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      code   : 'NOT_AUTHENTICATED',
      message: 'Authentication required.',
    });
  }

  if (!req.user.isSubUser) return next();

  const perms   = req.user.permissions || [];
  const granted = pageKeys.some(pageKey =>
    perms.find(p => p.pageKey === pageKey)?.actions?.includes(action)
  );

  if (!granted) {
    return res.status(403).json({
      success: false,
      code   : 'FORBIDDEN',
      message: `You do not have permission to ${action} ${pageKeys.join(' or ')}.`,
    });
  }

  return next();
};

module.exports = requirePermission;
module.exports.requireAnyPermission = requireAnyPermission;
