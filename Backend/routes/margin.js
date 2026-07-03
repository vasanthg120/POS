'use strict';
const express = require('express');
const router  = express.Router();

// Use your existing auth middleware (same pattern as tenant.settings.routes)
const { protect } = require('../middleware/auth');

const ctrl = require('../controllers/marginController');

// All routes require authentication
router.use(protect);

/* ── Stats ── */
router.get('/stats/summary', ctrl.getStats);

/* ── CRUD ── */
router.route('/')
  .get(ctrl.listJobs)
  .post(ctrl.createJob);

router.route('/:id')
  .get(ctrl.getJob)
  .put(ctrl.updateJob)
  .delete(ctrl.deleteJob);

router.patch('/:id/status',    ctrl.updateStatus);
router.post( '/:id/duplicate', ctrl.duplicateJob);

module.exports = router;