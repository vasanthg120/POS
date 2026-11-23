'use strict';

const Tenant = require('../models/tenant');
const { resolvePeriod, round2 } = require('../services/quoteTracking.service');
const {
  buildTenantSnapshot, buildAllTenantSnapshots,
  buildAllTenantQuoteRows, buildAllTenantPaymentRows,
  buildActivityFeed, listTenantsLite, findTenantQuote,
} = require('../services/superAdminAggregation.service');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const ok = (res, data = {}, message = 'Success') =>
  res.json({ success: true, message, data });

const fail = (res, message = 'Something went wrong', status = 400) =>
  res.status(status).json({ success: false, message });

const wantsFreshData = (req) => req.query.refresh === 'true';

const periodPayload = (periodStart, periodEnd) => ({
  from: periodStart ? periodStart.toISOString() : null,
  to: periodEnd ? periodEnd.toISOString() : null,
});

/** Slices an already-filtered array into a page, returning the standard
 *  {page, limit, total, pages} shape used elsewhere in this codebase
 *  (adminController.listTenants). Filtering happens before this is called —
 *  the underlying data isn't in a queryable local DB (quotes are fetched
 *  live per tenant), so "filter then paginate in memory" is the correct
 *  place for this, not a DB-level skip/limit. */
const paginate = (rows, req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const total = rows.length;
  const start = (page - 1) * limit;
  return {
    pageRows: rows.slice(start, start + limit),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  };
};

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/admin/tenants/lite
   Minimal {tenantId, businessName, ownerName} list — no CRM/Razorpay calls.
   Use this for filter dropdowns instead of the full overview endpoint.
   Registered before '/tenants/:tenantId' in routes/index.js.
   ══════════════════════════════════════════════════════════════════════════ */
exports.getTenantsLite = asyncHandler(async (req, res) => {
  const tenants = await listTenantsLite();
  return ok(res, { tenants });
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/admin/tenants/overview
   Cross-tenant snapshot array — powers both the Super Admin dashboard KPIs
   (summed client-side, same pattern Royalty uses) and the enhanced Tenant
   Management table, from a single call.
   ══════════════════════════════════════════════════════════════════════════ */
exports.getTenantsOverview = asyncHandler(async (req, res) => {
  const { month, year, dateFrom, dateTo, period } = req.query;
  const { periodStart, periodEnd } = resolvePeriod({ month, year, dateFrom, dateTo, period });

  const tenants = await buildAllTenantSnapshots({ periodStart, periodEnd, bypassCache: wantsFreshData(req) });

  return ok(res, { tenants, period: periodPayload(periodStart, periodEnd) });
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/admin/tenants/:tenantId/overview
   Single-tenant version, for the Tenant Detail page.
   ══════════════════════════════════════════════════════════════════════════ */
exports.getTenantOverview = asyncHandler(async (req, res) => {
  const { month, year, dateFrom, dateTo, period } = req.query;
  const { periodStart, periodEnd } = resolvePeriod({ month, year, dateFrom, dateTo, period });

  const tenant = await Tenant
    .findOne({ tenantId: req.params.tenantId })
    .select('+crm.apiKey +razorpay.keyId +razorpay.keySecret');
  if (!tenant) return fail(res, 'Tenant not found.', 404);

  const snapshot = await buildTenantSnapshot(tenant, { periodStart, periodEnd, bypassCache: wantsFreshData(req) });

  return ok(res, { tenant: snapshot, period: periodPayload(periodStart, periodEnd) });
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/admin/quotations
   Cross-tenant Quotation Monitoring — one row per quotation across every
   tenant, with the tenant that owns it attached to each row. Filtered
   server-side, then paginated.
   ══════════════════════════════════════════════════════════════════════════ */
exports.getQuotationsAcrossTenants = asyncHandler(async (req, res) => {
  const {
    month, year, dateFrom, dateTo, period,
    tenantId, status, paymentStatus, outcome, approval, search, minAmount, maxAmount,
  } = req.query;
  const { periodStart, periodEnd } = resolvePeriod({ month, year, dateFrom, dateTo, period });

  const { rows: allRows, tenantErrors } = await buildAllTenantQuoteRows({
    periodStart, periodEnd, bypassCache: wantsFreshData(req),
  });

  let rows = allRows;
  if (tenantId) rows = rows.filter(r => r.tenantId === tenantId);
  if (status) rows = rows.filter(r => (r.quotationStatus || '').toLowerCase() === String(status).toLowerCase());
  if (paymentStatus) rows = rows.filter(r => r.paymentStatus === paymentStatus);
  // outcome = the dashboard KPI bucket (approved | pending | rejectedOrExpired),
  // so a KPI card can drill down to exactly the quotes it counts.
  if (outcome) rows = rows.filter(r => r.outcome === outcome);
  if (approval) rows = rows.filter(r => r.approvalStatus === approval);
  if (minAmount) rows = rows.filter(r => r.amount >= Number(minAmount));
  if (maxAmount) rows = rows.filter(r => r.amount <= Number(maxAmount));
  if (search) {
    const q = String(search).trim().toLowerCase();
    rows = rows.filter(r =>
      `${r.quotationNo} ${r.customerName} ${r.customerEmail} ${r.companyName} ${r.tenantName} ${r.relatedDeal ?? ''} ${r.createdBy ?? ''}`
        .toLowerCase().includes(q));
  }

  const sortField = ['amount', 'customerName', 'quotationDate', 'paidAmount'].includes(req.query.sort) ? req.query.sort : null;
  if (sortField) {
    const dir = req.query.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const av = a[sortField], bv = b[sortField];
      if (sortField === 'quotationDate') return dir * (new Date(av || 0) - new Date(bv || 0));
      if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv);
      return dir * String(av ?? '').localeCompare(String(bv ?? ''));
    });
  }

  // Summary reflects the full filtered set, before the page slice.
  const summary = {
    total: rows.length,
    totalAmount: round2(rows.reduce((s, r) => s + r.amount, 0)),
    paidAmount: round2(rows.reduce((s, r) => s + (r.paidAmount || 0), 0)),
    balanceDue: round2(rows.reduce((s, r) => s + (r.balanceDue || 0), 0)),
    // Same buckets as the dashboard KPIs (superAdminAggregation quoteOutcome).
    approved: rows.filter(r => r.outcome === 'approved').length,
    pending: rows.filter(r => r.outcome === 'pending').length,
    rejectedExpired: rows.filter(r => r.outcome === 'rejectedOrExpired').length,
  };

  const { pageRows, pagination } = paginate(rows, req);

  return ok(res, {
    rows: pageRows,
    summary,
    pagination,
    tenantErrors,
    period: periodPayload(periodStart, periodEnd),
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/admin/tenants/:tenantId/quotes/:quoteId
   One quotation in full — CRM details, price breakdown, tracking, payments,
   timeline — for the detail drawer every Super Admin list opens.
   ══════════════════════════════════════════════════════════════════════════ */
exports.getTenantQuoteDetail = asyncHandler(async (req, res) => {
  const result = await findTenantQuote(req.params.tenantId, req.params.quoteId, {
    bypassCache: wantsFreshData(req),
  });
  if (!result) return fail(res, 'Tenant not found.', 404);
  if (!result.quote) {
    return fail(res, result.error
      ? `Could not load this tenant's quotations: ${result.error}`
      : `Quotation "${req.params.quoteId}" not found.`, result.error ? 502 : 404);
  }
  return ok(res, result);
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/admin/payments
   Cross-tenant Payment Tracking — one row per actual payment transaction
   (Manual or Razorpay) across every tenant. Filtered server-side, then
   paginated.
   ══════════════════════════════════════════════════════════════════════════ */
exports.getPaymentsAcrossTenants = asyncHandler(async (req, res) => {
  const {
    month, year, dateFrom, dateTo, period,
    tenantId, source, status, method, search, minAmount, maxAmount,
  } = req.query;
  const { periodStart, periodEnd } = resolvePeriod({ month, year, dateFrom, dateTo, period });

  const { rows: allRows, tenantErrors } = await buildAllTenantPaymentRows({
    periodStart, periodEnd, bypassCache: wantsFreshData(req),
  });

  let rows = allRows;
  if (tenantId) rows = rows.filter(r => r.tenantId === tenantId);
  if (source) rows = rows.filter(r => r.paymentSource.toLowerCase() === String(source).toLowerCase());
  if (status) rows = rows.filter(r => r.paymentStatus === status);
  if (method) rows = rows.filter(r => (r.paymentMethod || '').toLowerCase() === String(method).toLowerCase());
  if (minAmount) rows = rows.filter(r => r.paymentAmount >= Number(minAmount));
  if (maxAmount) rows = rows.filter(r => r.paymentAmount <= Number(maxAmount));
  if (search) {
    const q = String(search).trim().toLowerCase();
    rows = rows.filter(r =>
      `${r.quotationNo} ${r.customerName} ${r.customerEmail} ${r.tenantName} ${r.transactionReference}`.toLowerCase().includes(q));
  }

  const paySort = ['paymentDate', 'paymentAmount', 'customerName'].includes(req.query.sort) ? req.query.sort : null;
  if (paySort) {
    const dir = req.query.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      if (paySort === 'paymentDate') return dir * (new Date(a.paymentDate || 0) - new Date(b.paymentDate || 0));
      if (paySort === 'paymentAmount') return dir * (a.paymentAmount - b.paymentAmount);
      return dir * String(a.customerName ?? '').localeCompare(String(b.customerName ?? ''));
    });
  }

  // Summary reflects the full filtered set, before the page slice.
  const summary = {
    totalCount: rows.length,
    totalCollected: round2(rows.reduce((s, r) => s + r.paymentAmount, 0)),
    manualCount: rows.filter(r => r.paymentSource === 'Manual').length,
    razorpayCount: rows.filter(r => r.paymentSource === 'Razorpay').length,
  };

  const { pageRows, pagination } = paginate(rows, req);

  return ok(res, {
    rows: pageRows,
    summary,
    pagination,
    tenantErrors,
    period: periodPayload(periodStart, periodEnd),
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/admin/activity
   Unified cross-tenant activity feed — quotation created/updated, payments
   recorded, and CRM sync failures, sorted by recency and paginated.
   ══════════════════════════════════════════════════════════════════════════ */
exports.getActivityFeed = asyncHandler(async (req, res) => {
  const { month, year, dateFrom, dateTo, period, tenantId, type, severity } = req.query;
  const { periodStart, periodEnd } = resolvePeriod({ month, year, dateFrom, dateTo, period });

  const { events: allEvents, tenantErrors } = await buildActivityFeed({
    periodStart, periodEnd, bypassCache: wantsFreshData(req),
  });

  let events = allEvents;
  if (tenantId) events = events.filter(e => e.tenantId === tenantId);
  if (type) events = events.filter(e => e.type === type);
  if (severity) events = events.filter(e => e.severity === severity);

  const summary = {
    total: events.length,
    quotationEvents: events.filter(e => e.type.startsWith('quotation_')).length,
    paymentEvents: events.filter(e => e.type === 'payment_recorded').length,
    syncFailures: events.filter(e => e.type === 'sync_failed').length,
  };

  const { pageRows, pagination } = paginate(events, req);

  return ok(res, {
    events: pageRows,
    summary,
    pagination,
    tenantErrors,
    period: periodPayload(periodStart, periodEnd),
  });
});
