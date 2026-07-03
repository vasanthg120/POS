'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/razorpay.statements.conroller');
const { protect } = require('../middleware/auth');

router.use(protect);

// Summary KPIs
router.get('/summary',              ctrl.getSummary);

// Payment list + detail
router.get('/payments',             ctrl.getPayments);
router.get('/payments/:paymentId',  ctrl.getPaymentDetail);

// Refunds
router.get('/refunds',              ctrl.getRefunds);

module.exports = router;