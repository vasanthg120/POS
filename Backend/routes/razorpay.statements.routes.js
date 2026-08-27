'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/razorpay.statements.conroller');
const { protect } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');

router.use(protect);

// Summary KPIs
router.get('/summary',              requirePermission('payments', 'view'), ctrl.getSummary);

// Payment list + detail
router.get('/payments',             requirePermission('payments', 'view'), ctrl.getPayments);
router.get('/payments/:paymentId',  requirePermission('payments', 'view'), ctrl.getPaymentDetail);

// Refunds
router.get('/refunds',              requirePermission('payments', 'view'), ctrl.getRefunds);

module.exports = router;