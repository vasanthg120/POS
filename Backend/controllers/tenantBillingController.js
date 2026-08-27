'use strict';

// Tenant-facing billing — strictly read-only, strictly scoped to the
// calling tenant's own subscription (req.user.tenantId). No config editing,
// no payment recording — that stays superadmin-only.

const billingService = require('../services/billing.service');
const { streamInvoicePdf } = require('../services/invoicePdf.service');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
  streamInvoicePdf(res, { tenant, invoice, mode: req.query.mode === 'receipt' ? 'receipt' : 'invoice' });
});
