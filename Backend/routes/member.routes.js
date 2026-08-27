'use strict';

const express    = require('express');
const { body, param, query, validationResult } = require('express-validator');
const ctrl          = require('../controllers/memberController');
const { protect }   = require('../middleware/auth');
const requireTenant = require('../middleware/requireTenant');
const requirePermission = require('../middleware/requirePermission');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      code   : 'VALIDATION_ERROR',
      errors : errors.array().map(e => ({ field: e.path, message: e.msg })),
    });
  }
  next();
};

const mongoId = () => param('id').isMongoId().withMessage('Invalid member ID.');

// All routes require auth + tenant context
router.use(protect, requireTenant);

// ── List members (filter by roleId or status) ─────────────────────────────────
router.get('/', requirePermission('rbac', 'view'), [
  query('roleId').optional().isMongoId(),
  query('status').optional().isIn(['active', 'suspended']),
], validate, ctrl.listMembers);

// ── Invite a new user (temp password emailed) ─────────────────────────────────
router.post('/invite', requirePermission('rbac', 'edit'), [
  body('email').isEmail().withMessage('Valid email required.').normalizeEmail(),
  body('roleId').isMongoId().withMessage('Valid role ID required.'),
  body('firstName').optional().trim().isLength({ max: 50 }),
  body('lastName').optional().trim().isLength({ max: 50 }),
  body('phone').optional().matches(/^[+]?[\d\s\-()]{7,15}$/).withMessage('Invalid phone number.'),
], validate, ctrl.inviteMember);

// ── Assign an already-registered user ────────────────────────────────────────
router.post('/assign', requirePermission('rbac', 'edit'), [
  body('email').isEmail().withMessage('Valid email required.').normalizeEmail(),
  body('roleId').isMongoId().withMessage('Valid role ID required.'),
], validate, ctrl.assignExistingMember);

// ── Reassign role ─────────────────────────────────────────────────────────────
router.patch('/:id/role', requirePermission('rbac', 'edit'), [
  mongoId(),
  body('roleId').isMongoId().withMessage('Valid role ID required.'),
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
