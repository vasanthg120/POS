'use strict';

// Tenant-facing billing — scoped to the calling tenant's own subscription
// (req.user.tenantId). Config editing, manual payment recording, and every
// other billing-state mutation stay superadmin-only; the one exception is
// paying their own outstanding invoice online (createPaymentOrder/verifyPayment
// below), which still lands through billingService.recordManualPayment so it
// goes through the exact same status-transition/audit/receipt path.

const billingService = require('../services/billing.service');
const billingSettingsService = require('../services/billingSettings.service');
const billingPaymentService = require('../services/billingPayment.service');
const { streamInvoicePdf } = require('../services/invoicePdf.service');

// Mirrors billingController.js's asyncHandler — expected/validation failures
// carry an explicit `.status` and are answered directly so their specific
// message survives; anything else still goes to `next()`.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    next(err);
  });

// ── GET /api/tenant/billing ────────────────────────────────────────────────────
exports.getMyBilling = asyncHandler(async (req, res) => {
  const { tenant, subscription } = await billingService.getTenantBillingDetail(req.user.tenantId);
  return res.json({
    success: true,
    data: {
      tenant: {
        tenantId: tenant.tenantId,
        businessName: tenant.businessName,
        billingSuspended: tenant.billingSuspended,
      },
      subscription,
    },
  });
});

// ── GET /api/tenant/billing/invoices/:invoiceId/pdf ────────────────────────────
exports.downloadMyInvoicePdf = asyncHandler(async (req, res) => {
  const { tenant, subscription } = await billingService.getTenantBillingDetail(req.user.tenantId);
  const invoice = subscription.invoices.id(req.params.invoiceId);
  if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  const settings = await billingSettingsService.getSettings();
  streamInvoicePdf(res, { tenant, invoice, mode: req.query.mode === 'receipt' ? 'receipt' : 'invoice', settings });
});

// ── POST /api/tenant/billing/invoices/:invoiceId/pay ───────────────────────────
exports.createPaymentOrder = asyncHandler(async (req, res) => {
  const data = await billingPaymentService.createInvoicePaymentOrder(req.user.tenantId, req.params.invoiceId);
  return res.json({ success: true, data });
});

// ── POST /api/tenant/billing/invoices/:invoiceId/verify ────────────────────────
exports.verifyPayment = asyncHandler(async (req, res) => {
  const result = await billingPaymentService.verifyInvoicePayment(req.user.tenantId, req.params.invoiceId, req.body, req.user);
  return res.json({ success: true, message: result.alreadyPaid ? 'Already paid.' : 'Payment verified.', data: result });
});
