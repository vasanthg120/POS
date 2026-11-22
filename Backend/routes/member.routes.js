'use strict';

const express    = require('express');
const { body, param, query } = require('express-validator');
const ctrl          = require('../controllers/memberController');
const { protect }   = require('../middleware/auth');
const requireTenant = require('../middleware/requireTenant');
const requirePermission = require('../middleware/requirePermission');
// Shared runner: its 422 carries a `message` (this file's own runner sent
// none, so the UI could only show "Invite failed.").
const { validate, phoneRule, personNameRule, emailRule } = require('../middleware/validate');

const router = express.Router();

const mongoId = () => param('id').isMongoId().withMessage('Invalid member ID.');

// All routes require auth + tenant context
router.use(protect, requireTenant);

// ── List members (filter by roleId or status) ─────────────────────────────────
router.get('/', requirePermission('rbac', 'view'), [
  query('roleId').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid role filter.'),
  query('status').optional({ values: 'falsy' })
    .isIn(['active', 'suspended']).withMessage('Status filter must be "active" or "suspended".'),
], validate, ctrl.listMembers);

// ── Invite a new user (temp password emailed) ─────────────────────────────────
router.post('/invite', requirePermission('rbac', 'edit'), [
  emailRule('email'),
  body('roleId').isMongoId().withMessage('Choose a role for this member.'),
  personNameRule('firstName', 'First name', { required: false }),
  personNameRule('lastName', 'Last name', { required: false }),
  // Was 7–15 characters here but 7–20 in the invite form, so longer numbers
  // passed the form and then failed here.
  phoneRule('phone'),
], validate, ctrl.inviteMember);

// ── Assign an already-registered user ────────────────────────────────────────
router.post('/assign', requirePermission('rbac', 'edit'), [
  emailRule('email'),
  body('roleId').isMongoId().withMessage('Choose a role for this member.'),
], validate, ctrl.assignExistingMember);

// ── Reassign role ─────────────────────────────────────────────────────────────
router.patch('/:id/role', requirePermission('rbac', 'edit'), [
  mongoId(),
  body('roleId').isMongoId().withMessage('Choose a role for this member.'),
], validate, ctrl.reassignRole);

// ── Suspend or reactivate ─────────────────────────────────────────────────────
router.patch('/:id/status', requirePermission('rbac', 'edit'), [
  mongoId(),
  body('status').isIn(['active', 'suspended']).withMessage('Must be "active" or "suspended".'),
], validate, ctrl.setStatus);

// ── Remove from team ──────────────────────────────────────────────────────────
router.delete('/:id', requirePermission('rbac', 'edit'), [mongoId()], validate, ctrl.removeMember);

// ── Resend credentials (generates a fresh temp password) ─────────────────────
router.post('/:id/resend-invite', requirePermission('rbac', 'edit'), [mongoId()], validate, ctrl.resendInvite);

module.exports = router;
