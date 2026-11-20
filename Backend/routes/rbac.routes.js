'use strict';

const express    = require('express');
const { body, param } = require('express-validator');
const rbacCtrl      = require('../controllers/rbacController');
const { protect }   = require('../middleware/auth');
const requireTenant = require('../middleware/requireTenant');
const requirePermission = require('../middleware/requirePermission');
const { validate } = require('../middleware/validate');

const router = express.Router();

const mongoId = () => param('id').isMongoId().withMessage('Invalid role ID.');

// Create and edit share these; edit used to have no validation at all, so a
// 1- or 500-character name or a non-hex colour was accepted there.
const roleRules = ({ partial }) => [
  (partial ? body('name').optional() : body('name')).trim()
    .notEmpty().withMessage('Role name is required.')
    .isLength({ min: 2, max: 40 }).withMessage('Role name must be 2–40 characters.'),
  body('description').optional({ values: 'null' }).isString().withMessage('Description must be text.').trim()
    .isLength({ max: 200 }).withMessage('Description must be at most 200 characters.'),
  body('color').optional({ values: 'falsy' })
    .matches(/^#[0-9a-fA-F]{6}$/).withMessage('Colour must be a hex value like #1E40AF.'),
  body('permissions').optional().isArray().withMessage('Permissions must be a list.'),
  body('permissions.*.pageKey').isString().notEmpty().withMessage('Each permission needs a page.'),
  body('permissions.*.actions').isArray().withMessage('Each permission needs a list of actions.'),
];

// All RBAC routes require auth + tenant role
router.use(protect, requireTenant);

router.get('/',           requirePermission('rbac', 'view'), rbacCtrl.listRoles);
router.get('/audit',      requirePermission('rbac', 'view'), rbacCtrl.getAuditLog);

router.post('/', requirePermission('rbac', 'edit'), roleRules({ partial: false }), validate, rbacCtrl.createRole);

router.get   ('/:id',           requirePermission('rbac', 'view'), [mongoId()], validate, rbacCtrl.getRole);
router.patch ('/:id',           requirePermission('rbac', 'edit'), [mongoId(), ...roleRules({ partial: true })], validate, rbacCtrl.updateRole);
router.delete('/:id',           requirePermission('rbac', 'edit'), [mongoId()], validate, rbacCtrl.deleteRole);
router.post  ('/:id/duplicate', requirePermission('rbac', 'edit'), [mongoId()], validate, rbacCtrl.duplicateRole);
router.get   ('/:id/audit',     requirePermission('rbac', 'view'), [mongoId()], validate, rbacCtrl.getRoleAuditLog);

module.exports = router;