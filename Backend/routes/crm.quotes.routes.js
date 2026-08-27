'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/crm.quotes.controller');
const { protect } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { requireAnyPermission } = requirePermission;

router.use(protect);

// This quotes list backs both the Quotations page and the Tracking page —
// either page's view permission is enough to read it.
const readGate = requireAnyPermission(['quotations', 'tracking'], 'view');

// ── List & search ─────────────────────────────────────────────────────────
router.get ('/',                   readGate, ctrl.getQuotes);
router.get ('/stats',              readGate, ctrl.getQuoteStats);
router.post('/search',             readGate, ctrl.searchQuotes);

// ── Bulk Razorpay sync (on-demand, no webhook needed) ────────────────────
// POST so it's explicit and doesn't get cached; no body required.
// Tracking page action — requires tracking:edit.
router.post('/sync-razorpay',      requirePermission('tracking', 'edit'), ctrl.syncAllRazorpay);

// ── Single quote ──────────────────────────────────────────────────────────
router.get ('/:quoteId',           readGate, ctrl.getQuoteById);

// ── Tracking updates ──────────────────────────────────────────────────────
// General admin override (stage, notes, method, partial amounts, etc.)
router.patch('/:quoteId/track',          requirePermission('tracking', 'edit'), ctrl.updateTracking);

// Dedicated manual-payment endpoint (Bank Transfer / Cash / Cheque / NEFT etc.)
// Accumulates paidAmount correctly across multiple partial payments.
router.post ('/:quoteId/manual-payment', requirePermission('tracking', 'edit'), ctrl.recordManualPayment);

module.exports = router;