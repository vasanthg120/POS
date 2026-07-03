'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/crm.quotes.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

// ── List & search ─────────────────────────────────────────────────────────
router.get ('/',                   ctrl.getQuotes);
router.get ('/stats',              ctrl.getQuoteStats);
router.post('/search',             ctrl.searchQuotes);

// ── Bulk Razorpay sync (on-demand, no webhook needed) ────────────────────
// POST so it's explicit and doesn't get cached; no body required.
router.post('/sync-razorpay',      ctrl.syncAllRazorpay);

// ── Single quote ──────────────────────────────────────────────────────────
router.get ('/:quoteId',           ctrl.getQuoteById);

// ── Tracking updates ──────────────────────────────────────────────────────
// General admin override (stage, notes, method, partial amounts, etc.)
router.patch('/:quoteId/track',          ctrl.updateTracking);

// Dedicated manual-payment endpoint (Bank Transfer / Cash / Cheque / NEFT etc.)
// Accumulates paidAmount correctly across multiple partial payments.
router.post ('/:quoteId/manual-payment', ctrl.recordManualPayment);

module.exports = router;