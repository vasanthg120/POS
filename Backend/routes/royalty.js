'use strict';

const express = require('express');
const router  = express.Router();

const { protect } = require('../middleware/auth');
const requireTenant = require('../middleware/requireTenant');
const requirePermission = require('../middleware/requirePermission');
const ctrl = require('../controllers/royaltyController');

// All routes require authentication + tenant context
router.use(protect, requireTenant);

const canView = requirePermission('royalty', 'view');

// Royalty percentage is set by the platform superadmin (see
// /api/admin/tenants/:tenantId/royalty-config) — tenants can view their
// current rate here but cannot change it themselves.
router.get('/config', canView, ctrl.getConfig);

router.get('/', canView, ctrl.getReport);

module.exports = router;
