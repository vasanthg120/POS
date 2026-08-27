'use strict';
const express = require('express');
const router  = express.Router();

// Use your existing auth middleware (same pattern as tenant.settings.routes)
const { protect } = require('../middleware/auth');

const ctrl = require('../controllers/marginController');
const requirePermission = require('../middleware/requirePermission');

// All routes require authentication
router.use(protect);

// The margin-calculator RBAC page only exposes 'view' and 'create' actions
// (see admin rbac.ts PAGES + Backend/utils/seedTenantRoles.js) — there is no
// separate 'edit'/'delete' grant for this page, so every mutating operation
// here (including update/status/duplicate/delete) is gated behind 'create',
// the one action that already means "full use of the calculator".
const canView   = requirePermission('margin-calculator', 'view');
const canModify = requirePermission('margin-calculator', 'create');

/* ── Stats ── */
router.get('/stats/summary', canView, ctrl.getStats);

/* ── CRUD ── */
router.route('/')
  .get(canView, ctrl.listJobs)
  .post(canModify, ctrl.createJob);

router.route('/:id')
  .get(canView, ctrl.getJob)
  .put(canModify, ctrl.updateJob)
  .delete(canModify, ctrl.deleteJob);

router.patch('/:id/status',    canModify, ctrl.updateStatus);
router.post( '/:id/duplicate', canModify, ctrl.duplicateJob);

module.exports = router;