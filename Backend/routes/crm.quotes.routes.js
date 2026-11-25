'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/crm.quotes.controller');
const { protect } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { requireAnyPermission } = requirePermission;

router.use(protect);

// This quotes list backs the Quotations, Tracking and Dashboard pages — any
// of those pages' view permission is enough to read it. ('dashboard' was
// missing, so a sub-user whose role only grants the Dashboard got a 403 here
// and saw an empty dashboard.)
const readGate = requireAnyPermission(['quotations', 'tracking', 'dashboard'], 'view');

// ── List & search ─────────────────────────────────────────────────────────
router.get ('/',                   readGate, ctrl.getQuotes);
router.get ('/stats',              readGate, ctrl.getQuoteStats);
router.post('/search',             readGate, ctrl.searchQuotes);

// ── CRM → POS live-sync health ────────────────────────────────────────────
// Registered before '/:quoteId' so the path isn't read as a quote ID.
// There is no manual sync route: quote reads pull from the CRM themselves.
router.get ('/sync-status',        readGate, ctrl.getSyncStatus);

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