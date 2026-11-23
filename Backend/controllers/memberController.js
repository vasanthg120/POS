'use strict';

const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Tenant   = require('../models/tenant');
const RbacRole = require('../models/rbacRole');
const {
  sendSubUserInviteEmail,
  sendMemberAssignedEmail,
} = require('../utils/email');
const logger   = require('../utils/logger');
const { escapeRegex } = require('../utils/validation');
const { stripReservedPermissions, invalidateAccountAccess } = require('../utils/accountAccess');

// ── Temp password generator (Node 14+ compatible) ─────────────────────────────
const randomChar = (str) => str[crypto.randomBytes(1)[0] % str.length];

const generateTempPassword = () => {
  const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower   = 'abcdefghjkmnpqrstuvwxyz';
  const digits  = '0123456789';
  const special = '@$!%*?&';

  const chars = [
    randomChar(upper),  randomChar(upper),
    randomChar(lower),  randomChar(lower),
    randomChar(digits), randomChar(digits),
    randomChar(special),
    randomChar(lower),  randomChar(lower),
    randomChar(lower),  randomChar(lower),
  ];

  // Fisher-Yates shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
};

// ── Safe projection ───────────────────────────────────────────────────────────
const safeMember = (u) => ({
  id             : u._id,
  tenantId       : u.tenantId,
  parentTenantId : u.parentTenantId,
  rbacRoleId     : u.rbacRoleId,
  rbacRoleName   : u.rbacRoleName,
  firstName      : u.firstName,
  lastName       : u.lastName,
  email          : u.email,
  phone          : u.phone,
  isSubUser      : u.isSubUser,
  subUserStatus  : u.subUserStatus,
  invitedAt      : u.invitedAt,
  lastLogin      : u.lastLogin,
  createdAt      : u.createdAt,
});

/*
 * Team members (sub-users) are always role 'tenant' and get their access
 * from their RBAC role. Tenant Management ('tenants') is never part of that
 * access — for any team, including the Super Admin's own staff. It is
 * stripped when roles are saved (rbacController / models/rbacRole.js) and
 * again when permissions are put into a login token (authController).
 */

// ── GET /api/tenant/members ───────────────────────────────────────────────────
exports.listMembers = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const filter = { parentTenantId: tenantId, isSubUser: true };

    if (req.query.roleId) filter.rbacRoleId    = req.query.roleId;
    if (req.query.status) filter.subUserStatus = req.query.status;
    if (req.query.q?.trim()) {
      const re = new RegExp(escapeRegex(req.query.q.trim()), 'i');
      filter.$or = [{ firstName: re }, { lastName: re }, { email: re }];
    }

    const members = await Tenant
      .find(filter)
      .sort({ createdAt: -1 })
      .select('-password -refreshTokens -loginAttempts -lockUntil -emailVerifyToken -passwordResetToken');

    return res.json({ success: true, data: members.map(safeMember), total: members.length });
  } catch (err) { next(err); }
};

// ── POST /api/tenant/members/invite ───────────────────────────────────────────
exports.inviteMember = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const { email, firstName, lastName, phone, roleId } = req.body;

    // Validate role belongs to this tenant
    const role = await RbacRole.findOne({ _id: roleId, tenantId });
    if (!role) return res.status(404).json({ success: false, message: 'Role not found.' });

    // Defence-in-depth for legacy data: Tenant Management never comes with a role.
    role.permissions = stripReservedPermissions(role.permissions);

    // Block if already a member of this tenant
    const existing = await Tenant.findOne({ email: email.toLowerCase(), parentTenantId: tenantId });
    if (existing) {
      return res.status(409).json({
        success: false,
        code   : 'ALREADY_MEMBER',
        message: 'This email is already a member of your team.',
      });
    }

    // Generate temp password
    const tempPasswordRaw = generateTempPassword();

    // Generate unique tenantId for the sub-user
    const slugBase    = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    const subTenantId = `sub-${slugBase}-${uuidv4().split('-')[0]}`;

    const member = new Tenant({
      firstName      : firstName?.trim() ?? '',
      lastName       : lastName?.trim()  ?? '',
      email          : email.toLowerCase(),
      phone          : phone?.trim()     ?? '',
      tenantId       : subTenantId,
      role           : 'tenant',
      isActive       : true,
      isEmailVerified: true,
      setupStep      : 'complete',
      password       : tempPasswordRaw,   // pre-save hook hashes it

      // Sub-user fields
      isSubUser      : true,
      parentTenantId : tenantId,
      rbacRoleId     : role._id,
      rbacRoleName   : role.name,
      subUserStatus  : 'active',
      invitedBy      : req.user.id,
      invitedAt      : new Date(),
    });

    await member.save();
    await RbacRole.findByIdAndUpdate(role._id, { $inc: { memberCount: 1 } });

    try {
      await sendSubUserInviteEmail(member, tempPasswordRaw, role.name, req.user);
    } catch (mailErr) {
      logger.error(`[Member] Invite email failed for ${email}: ${mailErr.message}`);
    }

    logger.info(`[Member] ${email} invited to tenant ${tenantId} as "${role.name}" by ${req.user.email}`);
    return res.status(201).json({
      success: true,
      message: `Invitation sent to ${email}. They will receive their temporary password by email.`,
      data   : safeMember(member),
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'This email already exists in the system.' });
    }
    next(err);
  }
};

// ── POST /api/tenant/members/assign ──────────────────────────────────────────
exports.assignExistingMember = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const { email, roleId } = req.body;

    const role = await RbacRole.findOne({ _id: roleId, tenantId });
    if (!role) return res.status(404).json({ success: false, message: 'Role not found.' });

    // Defence-in-depth for legacy data: Tenant Management never comes with a role.
    role.permissions = stripReservedPermissions(role.permissions);

    // Must already have a registered account
    const existing = await Tenant.findOne({ email: email.toLowerCase(), isSubUser: false });
    if (!existing) {
      return res.status(404).json({
        success: false,
        code   : 'USER_NOT_FOUND',
        message: 'No registered account found with this email. Use "Invite" to send them a new account invite.',
      });
    }

    // The organisation Super Admin is the top-level account — it can never be
    // pulled into a tenant's team as a member.
    if (existing.role === 'superadmin') {
      return res.status(403).json({
        success: false,
        code   : 'FORBIDDEN',
        message: 'The organisation Super Admin account cannot be added to a team.',
      });
    }

    // Block self-assignment
    if (existing.tenantId === tenantId) {
      return res.status(400).json({ success: false, message: 'You cannot assign yourself as a team member.' });
    }

    // Block if already a member
    const alreadyMember = await Tenant.findOne({
      email          : email.toLowerCase(),
      parentTenantId : tenantId,
      isSubUser      : true,
    });
    if (alreadyMember) {
      return res.status(409).json({ success: false, message: 'This user is already a member of your team.' });
    }

    const slugBase    = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    const subTenantId = `sub-${slugBase}-${uuidv4().split('-')[0]}`;

    // Generate a temp password so the sub-user record satisfies the schema
    const tempPasswordRaw = generateTempPassword();

    const member = await Tenant.create({
      firstName      : existing.firstName,
      lastName       : existing.lastName,
      email          : email.toLowerCase(),
      phone          : existing.phone ?? '',
      tenantId       : subTenantId,
      role           : 'tenant',
      isActive       : true,
      isEmailVerified: true,
      setupStep      : 'complete',
      password       : tempPasswordRaw,

      // Sub-user fields — immediately active
      isSubUser      : true,
      parentTenantId : tenantId,
      rbacRoleId     : role._id,
      rbacRoleName   : role.name,
      subUserStatus  : 'active',
      invitedBy      : req.user.id,
      invitedAt      : new Date(),
    });

    await RbacRole.findByIdAndUpdate(role._id, { $inc: { memberCount: 1 } });

    try {
      await sendMemberAssignedEmail(existing, role.name, req.user);
    } catch (mailErr) {
      logger.error(`[Member] Assign email failed for ${email}: ${mailErr.message}`);
    }

    logger.info(`[Member] Existing user ${email} assigned to tenant ${tenantId} as "${role.name}"`);
    return res.status(201).json({
      success: true,
      message: `${email} added to your team as ${role.name}.`,
      data   : safeMember(member),
    });
  } catch (err) { next(err); }
};

// ── PATCH /api/tenant/members/:id/role ───────────────────────────────────────
exports.reassignRole = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const { roleId }   = req.body;

    const [member, newRole] = await Promise.all([
      Tenant.findOne({ _id: req.params.id, parentTenantId: tenantId, isSubUser: true }),
      RbacRole.findOne({ _id: roleId, tenantId }),
    ]);

    if (!member)  return res.status(404).json({ success: false, message: 'Member not found.' });
    if (!newRole) return res.status(404).json({ success: false, message: 'Role not found.' });

    const oldRoleId     = member.rbacRoleId;
    member.rbacRoleId   = newRole._id;
    member.rbacRoleName = newRole.name;
    await member.save();

    await Promise.all([
      RbacRole.findByIdAndUpdate(oldRoleId,   { $inc: { memberCount: -1 } }),
      RbacRole.findByIdAndUpdate(newRole._id, { $inc: { memberCount:  1 } }),
    ]);

    logger.info(`[Member] ${member.email} reassigned to "${newRole.name}" by ${req.user.email}`);
    return res.json({
      success: true,
      message: `Role updated to "${newRole.name}".`,
      data   : safeMember(member),
    });
  } catch (err) { next(err); }
};

// ── PATCH /api/tenant/members/:id/status ─────────────────────────────────────
exports.setStatus = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const { status }   = req.body;

    if (!['active', 'suspended'].includes(status)) {
      return res.status(422).json({ success: false, message: '`status` must be "active" or "suspended".' });
    }

    const member = await Tenant.findOne({ _id: req.params.id, parentTenantId: tenantId, isSubUser: true });
    if (!member) return res.status(404).json({ success: false, message: 'Member not found.' });

    member.subUserStatus = status;
    await member.save();
    invalidateAccountAccess(member._id);

    logger.info(`[Member] ${member.email} → ${status} by ${req.user.email}`);
    return res.json({
      success: true,
      message: `Member ${status === 'active' ? 'reactivated' : 'suspended'}.`,
      data   : safeMember(member),
    });
  } catch (err) { next(err); }
};

// ── DELETE /api/tenant/members/:id ───────────────────────────────────────────
exports.removeMember = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const member = await Tenant.findOne({ _id: req.params.id, parentTenantId: tenantId, isSubUser: true });
    if (!member) return res.status(404).json({ success: false, message: 'Member not found.' });

    await Tenant.deleteOne({ _id: member._id });
    invalidateAccountAccess(member._id);
    await RbacRole.findByIdAndUpdate(member.rbacRoleId, { $inc: { memberCount: -1 } });

    logger.info(`[Member] ${member.email} removed from tenant ${tenantId} by ${req.user.email}`);
    return res.json({ success: true, message: `${member.email} removed from team.` });
  } catch (err) { next(err); }
};

// ── POST /api/tenant/members/:id/resend-invite ────────────────────────────────
exports.resendInvite = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const member = await Tenant
      .findOne({ _id: req.params.id, parentTenantId: tenantId, isSubUser: true })
      .select('+password');

    if (!member) return res.status(404).json({ success: false, message: 'Member not found.' });

    // Generate a fresh temp password
    const tempPasswordRaw = generateTempPassword();
    member.password = tempPasswordRaw;   // pre-save hook hashes it
    await member.save();

    try {
      await sendSubUserInviteEmail(member, tempPasswordRaw, member.rbacRoleName, req.user);
    } catch (mailErr) {
      logger.error(`[Member] Resend invite failed for ${member.email}: ${mailErr.message}`);
    }

    logger.info(`[Member] Fresh temp password sent to ${member.email} by ${req.user.email}`);
    return res.json({ success: true, message: `New temporary password sent to ${member.email}.` });
  } catch (err) { next(err); }
};