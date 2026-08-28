'use strict';

const billingService = require('../services/billing.service');
const billingSettingsService = require('../services/billingSettings.service');
const { streamInvoicePdf } = require('../services/invoicePdf.service');

// Service errors carry an explicit `.status` + user-facing `.message` for
// expected/validation failures (e.g. "Invoice not found") — those are
// answered directly so the specific message survives in production (the
// global error handler in app.js replaces err.message with a generic string
// there). Anything without `.status` is a genuine unexpected failure and
// still goes to `next()` as usual.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    next(err);
  });

const ok = (res, data = {}, message = 'Success') => res.json({ success: true, message, data });

// ── GET /api/admin/billing/tenants ────────────────────────────────────────────
exports.getBillingOverview = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
  const month = req.query.month ? parseInt(req.query.month) : undefined;
  const year = req.query.year ? parseInt(req.query.year) : undefined;

  const result = await billingService.listBillingOverview({
    page, limit, month, year,
    status: req.query.status,
    search: req.query.search,
    planId: req.query.planId,
    paymentMethod: req.query.paymentMethod,
    minAmount: req.query.minAmount ? parseFloat(req.query.minAmount) : undefined,
    maxAmount: req.query.maxAmount ? parseFloat(req.query.maxAmount) : undefined,
    dueWindow: req.query.dueWindow,
    followUpStatus: req.query.followUpStatus,
  });

  return ok(res, result);
});

// ── GET /api/admin/billing/tenants/:tenantId ──────────────────────────────────
exports.getTenantBilling = asyncHandler(async (req, res) => {
  const { tenant, subscription } = await billingService.getTenantBillingDetail(req.params.tenantId);
  return ok(res, {
    tenant: {
      tenantId: tenant.tenantId,
      businessName: tenant.businessName,
      ownerName: `${tenant.firstName} ${tenant.lastName}`.trim(),
      email: tenant.email,
      billingSuspended: tenant.billingSuspended,
    },
    subscription,
  });
});

// ── GET /api/admin/billing/tenants/:tenantId/audit ────────────────────────────
exports.getTenantAuditLog = asyncHandler(async (req, res) => {
  const entries = await billingService.getAuditLog(req.params.tenantId);
  return ok(res, entries);
});

// ── PATCH /api/admin/billing/tenants/:tenantId/config ─────────────────────────
exports.updateConfig = asyncHandler(async (req, res) => {
  const sub = await billingService.updateSubscriptionConfig(req.params.tenantId, req.body);
  return ok(res, sub, 'Billing configuration updated.');
});

// ── POST /api/admin/billing/tenants/:tenantId/change-plan ─────────────────────
exports.changePlan = asyncHandler(async (req, res) => {
  const sub = await billingService.changePlan(req.params.tenantId, req.body.planId, req.user);
  return ok(res, sub, 'Plan changed.');
});

// ── POST /api/admin/billing/tenants/:tenantId/cancel ───────────────────────────
exports.cancelSubscription = asyncHandler(async (req, res) => {
  const sub = await billingService.cancelSubscription(req.params.tenantId, req.body.reason, req.user);
  return ok(res, sub, 'Subscription cancelled.');
});

// ── POST /api/admin/billing/tenants/:tenantId/invoices/:invoiceId/payment ─────
exports.recordPayment = asyncHandler(async (req, res) => {
  const result = await billingService.recordManualPayment(
    req.params.tenantId, req.params.invoiceId, req.body, req.user,
  );
  return ok(res, result, 'Payment recorded.');
});

// ── POST /api/admin/billing/tenants/:tenantId/invoices/:invoiceId/fail ────────
exports.markPaymentFailed = asyncHandler(async (req, res) => {
  const invoice = await billingService.markPaymentFailed(
    req.params.tenantId, req.params.invoiceId, req.body.reason, req.user,
  );
  return ok(res, invoice, 'Payment marked as failed.');
});

// ── POST /api/admin/billing/tenants/:tenantId/invoices/:invoiceId/refund ──────
exports.issueRefund = asyncHandler(async (req, res) => {
  const invoice = await billingService.issueRefund(
    req.params.tenantId, req.params.invoiceId, req.body, req.user,
  );
  return ok(res, invoice, 'Refund recorded.');
});

// ── POST /api/admin/billing/tenants/:tenantId/invoices/:invoiceId/followup ────
exports.addFollowUp = asyncHandler(async (req, res) => {
  const invoice = await billingService.addFollowUp(
    req.params.tenantId, req.params.invoiceId, req.body, req.user,
  );
  return ok(res, invoice, 'Follow-up added.');
});

// ── PATCH .../invoices/:invoiceId/followup/:followUpId ────────────────────────
exports.updateFollowUpStatus = asyncHandler(async (req, res) => {
  const invoice = await billingService.updateFollowUpStatus(
    req.params.tenantId, req.params.invoiceId, req.params.followUpId, req.body.followUpStatus,
  );
  return ok(res, invoice, 'Follow-up updated.');
});

// ── POST /api/admin/billing/tenants/:tenantId/invoices/:invoiceId/waive ───────
exports.waiveInvoice = asyncHandler(async (req, res) => {
  const invoice = await billingService.waiveInvoice(req.params.tenantId, req.params.invoiceId, req.user);
  return ok(res, invoice, 'Invoice waived.');
});

// ── POST /api/admin/billing/tenants/:tenantId/reactivate ──────────────────────
exports.reactivate = asyncHandler(async (req, res) => {
  const tenant = await billingService.manualReactivate(req.params.tenantId, req.user);
  return ok(res, { billingSuspended: tenant.billingSuspended }, 'Tenant reactivated.');
});

// ── POST /api/admin/billing/tenants/:tenantId/suspend ──────────────────────────
exports.suspend = asyncHandler(async (req, res) => {
  const tenant = await billingService.manualSuspend(req.params.tenantId, req.body.reason, req.user);
  return ok(res, { billingSuspended: tenant.billingSuspended }, 'Tenant suspended.');
});

// ── POST .../invoices/:invoiceId/remind ────────────────────────────────────────
exports.sendReminder = asyncHandler(async (req, res) => {
  const invoice = await billingService.sendManualReminder(req.params.tenantId, req.params.invoiceId, req.user);
  return ok(res, invoice, 'Reminder sent.');
});

// ── POST .../invoices/:invoiceId/adjustment ────────────────────────────────────
exports.applyAdjustment = asyncHandler(async (req, res) => {
  const invoice = await billingService.applyAdjustment(req.params.tenantId, req.params.invoiceId, req.body, req.user);
  return ok(res, invoice, 'Adjustment applied.');
});

// ── GET /api/admin/billing/follow-ups ──────────────────────────────────────────
exports.getFollowUpBuckets = asyncHandler(async (req, res) => {
  const buckets = await billingService.categorizeFollowUps({
    upcomingWindowDays: req.query.upcomingWindowDays ? parseInt(req.query.upcomingWindowDays) : undefined,
  });
  return ok(res, buckets);
});

// ── GET /api/admin/billing/calendar ────────────────────────────────────────────
exports.getCalendar = asyncHandler(async (req, res) => {
  const month = req.query.month ? parseInt(req.query.month) : undefined;
  const year = req.query.year ? parseInt(req.query.year) : undefined;
  const data = await billingService.getBillingCalendar({
    month, year,
    search: req.query.search,
    planId: req.query.planId,
    status: req.query.status,
    assignedStaffName: req.query.assignedStaffName,
  });
  return ok(res, data);
});

// ── GET /api/admin/billing/analytics ───────────────────────────────────────────
exports.getAnalytics = asyncHandler(async (req, res) => {
  const data = await billingService.getAnalytics();
  return ok(res, data);
});

// ── GET /api/admin/billing/tenants/:tenantId/invoices/:invoiceId/pdf ──────────
exports.downloadInvoicePdf = asyncHandler(async (req, res) => {
  const { tenant, subscription } = await billingService.getTenantBillingDetail(req.params.tenantId);
  const invoice = subscription.invoices.id(req.params.invoiceId);
  if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  const settings = await billingSettingsService.getSettings();
  streamInvoicePdf(res, { tenant, invoice, mode: req.query.mode === 'receipt' ? 'receipt' : 'invoice', settings });
});

// ── GET /api/admin/billing/settings ────────────────────────────────────────────
exports.getSettings = asyncHandler(async (req, res) => {
  const settings = await billingSettingsService.getSettings();
  return ok(res, settings);
});

// ── PATCH /api/admin/billing/settings ──────────────────────────────────────────
exports.updateSettings = asyncHandler(async (req, res) => {
  const settings = await billingSettingsService.updateSettings(req.body, req.user);
  return ok(res, settings, 'Billing settings updated.');
});
