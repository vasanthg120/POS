'use strict';

const RbacRole     = require('../models/rbacRole');
const RbacAuditLog = require('../models/rbacAuditLog');
const logger       = require('../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

const safeRole = (r) => ({
  id         : r._id,
  name       : r.name,
  slug       : r.slug,
  description: r.description,
  color      : r.color,
  isSystem   : r.isSystem,
  permissions: r.permissions,
  memberCount: r.memberCount,
  createdAt  : r.createdAt,
  updatedAt  : r.updatedAt,
});

const safeAudit = (r) => ({
  id           : r._id,
  roleId       : r.roleId,
  roleName     : r.roleName,
  actorName    : r.actorName,
  actorInitials: r.actorInitials,
  actorColor   : r.actorColor,
  action       : r.action,
  detail       : r.detail,
  createdAt    : r.createdAt,
});

const audit = async ({ tenantId, roleId, roleName, user, action, detail, changes }) => {
  const initials = `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase() || 'SA';
  await RbacAuditLog.create({
    tenantId, roleId, roleName,
    actorId      : user.id,
    actorName    : `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email,
    actorInitials: initials,
    action, detail, changes,
  }).catch(e => logger.error(`[RBAC Audit] ${e.message}`));
};

/**
 * Strip page keys that the caller is not allowed to grant.
 *
 * Rules:
 *  - Superadmin  → can grant ANY page key including 'tenants'.
 *  - Tenant owner → can grant everything EXCEPT 'tenants' (Add Tenant).
 *    Even if a crafted request sends it, it is silently removed here
 *    so it is never persisted to the role document.
 */
const filterPermissionsForCaller = (permissions, callerRole) => {
  if (!Array.isArray(permissions)) return [];
  if (callerRole === 'superadmin') return permissions;

  // Tenant context — 'tenants' page must never appear in a tenant-owned role
  return permissions.filter(p => p.pageKey !== 'tenants');
};

// ── GET /api/tenant/rbac/roles ────────────────────────────────────────────────
exports.listRoles = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const filter = { tenantId };
    if (req.query.q?.trim()) {
      const re = new RegExp(req.query.q.trim(), 'i');
      filter.$or = [{ name: re }, { description: re }];
    }
    const roles = await RbacRole.find(filter).sort({ isSystem: -1, createdAt: 1 });
    return res.json({ success: true, data: roles.map(safeRole), total: roles.length });
  } catch (err) { next(err); }
};

// ── POST /api/tenant/rbac/roles ───────────────────────────────────────────────
exports.createRole = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const callerRole   = req.user.role; // 'superadmin' | 'tenant'
    const { name, description, color, permissions } = req.body;

    // Strip 'tenants' page key for tenant callers — server-side authoritative guard
    const safePermissions = filterPermissionsForCaller(permissions, callerRole);

    let slug = slugify(name);
    if (await RbacRole.exists({ tenantId, slug })) slug = `${slug}-${Date.now()}`;

    const role = await RbacRole.create({
      tenantId, slug,
      name       : name.trim(),
      description: description?.trim() ?? '',
      color      : color ?? '#1e40af',
      isSystem   : false,
      permissions: safePermissions,
      createdBy  : req.user.id,
    });

    await audit({
      tenantId, roleId: role._id, roleName: role.name, user: req.user,
      action: 'created',
      detail: `Role "${role.name}" created with ${role.permissions.length} page permissions`,
    });

    logger.info(`[RBAC] Role "${role.name}" created for tenant ${tenantId}`);
    return res.status(201).json({ success: true, message: `Role "${role.name}" created.`, data: safeRole(role) });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: 'A role with this name already exists.' });
    next(err);
  }
};

// ── GET /api/tenant/rbac/roles/:id ───────────────────────────────────────────
exports.getRole = async (req, res, next) => {
  try {
    const role = await RbacRole.findOne({ _id: req.params.id, tenantId: req.user.tenantId });
    if (!role) return res.status(404).json({ success: false, message: 'Role not found.' });
    return res.json({ success: true, data: safeRole(role) });
  } catch (err) { next(err); }
};

// ── PATCH /api/tenant/rbac/roles/:id ─────────────────────────────────────────
exports.updateRole = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const callerRole   = req.user.role; // 'superadmin' | 'tenant'

    const role = await RbacRole.findOne({ _id: req.params.id, tenantId });
    if (!role) return res.status(404).json({ success: false, message: 'Role not found.' });

    const { name, description, color, permissions } = req.body;
    const changes = {};

    if (name && name.trim() !== role.name) {
      changes.name = { from: role.name, to: name.trim() };
      role.name = name.trim();
      role.slug = slugify(name);
    }
    if (description !== undefined && description !== role.description) {
      changes.description = true;
      role.description = description.trim();
    }
    if (color && color !== role.color) {
      changes.color = { from: role.color, to: color };
      role.color = color;
    }
    if (permissions) {
      // Strip 'tenants' page key for tenant callers — server-side authoritative guard
      const safePermissions = filterPermissionsForCaller(permissions, callerRole);
      changes.permissionCount = safePermissions.length;
      role.permissions = safePermissions;
    }

    await role.save();

    await audit({
      tenantId, roleId: role._id, roleName: role.name, user: req.user,
      action: changes.permissionCount !== undefined ? 'permissions_changed' : 'updated',
      detail: `Role "${role.name}" was updated`,
      changes,
    });

    return res.json({ success: true, message: `Role "${role.name}" updated.`, data: safeRole(role) });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: 'A role with this name already exists.' });
    next(err);
  }
};

// ── DELETE /api/tenant/rbac/roles/:id ────────────────────────────────────────
exports.deleteRole = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const role = await RbacRole.findOne({ _id: req.params.id, tenantId });
    if (!role) return res.status(404).json({ success: false, message: 'Role not found.' });
    if (role.isSystem) return res.status(403).json({ success: false, message: 'System roles cannot be deleted.' });
    if (role.memberCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete a role with ${role.memberCount} active member(s). Reassign them first.`,
      });
    }

    const roleName = role.name;
    await RbacRole.deleteOne({ _id: role._id });

    await audit({ tenantId, roleId: role._id, roleName, user: req.user, action: 'deleted', detail: `Role "${roleName}" permanently deleted` });
    logger.info(`[RBAC] Role "${roleName}" deleted by ${req.user.email}`);

    return res.json({ success: true, message: `Role "${roleName}" deleted.` });
  } catch (err) { next(err); }
};

// ── POST /api/tenant/rbac/roles/:id/duplicate ────────────────────────────────
exports.duplicateRole = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const callerRole   = req.user.role; // 'superadmin' | 'tenant'

    const original = await RbacRole.findOne({ _id: req.params.id, tenantId });
    if (!original) return res.status(404).json({ success: false, message: 'Role not found.' });

    // When duplicating, also strip 'tenants' from the copy if the caller is a tenant.
    // This handles the edge case where a legacy role has 'tenants' persisted and a
    // tenant tries to duplicate it — the copy should not inherit that permission.
    const safePermissions = filterPermissionsForCaller(
      original.permissions.map(p => ({ pageKey: p.pageKey, actions: [...p.actions] })),
      callerRole,
    );

    const copy = await RbacRole.create({
      tenantId,
      name       : `${original.name} (Copy)`,
      slug       : `${original.slug}-copy-${Date.now()}`,
      description: original.description,
      color      : original.color,
      isSystem   : false,
      permissions: safePermissions,
      memberCount: 0,
      createdBy  : req.user.id,
    });

    await audit({
      tenantId, roleId: copy._id, roleName: copy.name, user: req.user,
      action: 'duplicated',
      detail: `Duplicated from "${original.name}"`,
    });

    return res.status(201).json({ success: true, message: `Role duplicated as "${copy.name}".`, data: safeRole(copy) });
  } catch (err) { next(err); }
};

// ── GET /api/tenant/rbac/roles/:id/audit ─────────────────────────────────────
exports.getRoleAuditLog = async (req, res, next) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const logs  = await RbacAuditLog
      .find({ tenantId: req.user.tenantId, roleId: req.params.id })
      .sort({ createdAt: -1 }).limit(limit);
    return res.json({ success: true, data: logs.map(safeAudit) });
  } catch (err) { next(err); }
};

// ── GET /api/tenant/rbac/audit ────────────────────────────────────────────────
exports.getAuditLog = async (req, res, next) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const logs  = await RbacAuditLog
      .find({ tenantId: req.user.tenantId })
      .sort({ createdAt: -1 }).limit(limit);
    return res.json({ success: true, data: logs.map(safeAudit) });
  } catch (err) { next(err); }
};