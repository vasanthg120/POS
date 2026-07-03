'use strict';

const express    = require('express');
const { body, param, validationResult } = require('express-validator');
const rbacCtrl      = require('../controllers/rbacController');
const { protect }   = require('../middleware/auth');
const requireTenant = require('../middleware/requireTenant');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false, code: 'VALIDATION_ERROR',
      errors : errors.array().map(e => ({ field: e.path, message: e.msg })),
    });
  }
  next();
};

const mongoId = () => param('id').isMongoId().withMessage('Invalid role ID.');

// All RBAC routes require auth + tenant role
router.use(protect, requireTenant);

router.get('/',           rbacCtrl.listRoles);
router.get('/audit',      rbacCtrl.getAuditLog);

router.post('/', [
  body('name').trim().notEmpty().withMessage('Role name is required.').isLength({ min: 2, max: 40 }),
  body('description').optional().isLength({ max: 200 }),
  body('color').optional().matches(/^#[0-9a-fA-F]{6}$/).withMessage('Invalid hex color.'),
  body('permissions').optional().isArray(),
], validate, rbacCtrl.createRole);

router.get   ('/:id',           [mongoId()], validate, rbacCtrl.getRole);
router.patch ('/:id',           [mongoId()], validate, rbacCtrl.updateRole);
router.delete('/:id',           [mongoId()], validate, rbacCtrl.deleteRole);
router.post  ('/:id/duplicate', [mongoId()], validate, rbacCtrl.duplicateRole);
router.get   ('/:id/audit',     [mongoId()], validate, rbacCtrl.getRoleAuditLog);

module.exports = router;