'use strict';

const RoyaltyConfig = require('../models/royaltyConfig');
const Tenant = require('../models/tenant');
const {
  loadTenant, fetchMergedQuotes, round2, eligiblePayments, resolvePeriod,
} = require('../services/quoteTracking.service');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const ok = (res, data = {}, message = 'Success') =>
  res.json({ success: true, message, data });

const fail = (res, message = 'Something went wrong', status = 400) =>
  res.status(status).json({ success: false, message });

const getOrCreateConfig = async (tenantId) => {
  let config = await RoyaltyConfig.findOne({ tenantId });
  if (!config) config = await RoyaltyConfig.create({ tenantId, history: [] });
  return config;
};

/* ══════════════════════════════════════════════════════════════════════════
   GET /tenant/royalty/config
   ══════════════════════════════════════════════════════════════════════════ */
exports.getConfig = asyncHandler(async (req, res) => {
  const config = await getOrCreateConfig(req.user.tenantId);
  return ok(res, {
    percentage: config.currentPercentage(),
    history: [...config.history].sort((a, b) => b.effectiveFrom - a.effectiveFrom),
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/admin/tenants/:tenantId/royalty-config
   PATCH /api/admin/tenants/:tenantId/royalty-config
   Superadmin-only — the royalty rate for a tenant is set from the
   platform side; tenants can only view their current rate (see getConfig
   above). Appends a new rate to history rather than overwriting — past
   reports keep resolving the rate that was actually in force on their
   payment dates.
   ══════════════════════════════════════════════════════════════════════════ */
exports.getConfigForTenant = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findOne({ tenantId: req.params.tenantId });
  if (!tenant) return fail(res, 'Tenant not found.', 404);

  const config = await getOrCreateConfig(req.params.tenantId);
  return ok(res, {
    percentage: config.currentPercentage(),
    history: [...config.history].sort((a, b) => b.effectiveFrom - a.effectiveFrom),
  });
});

exports.setConfigForTenant = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findOne({ tenantId: req.params.tenantId });
  if (!tenant) return fail(res, 'Tenant not found.', 404);

  const pct = Number(req.body.percentage);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return fail(res, 'Royalty percentage must be a number between 0 and 100.');
  }

  const config = await getOrCreateConfig(req.params.tenantId);
  const name = `${req.user.firstName ?? ''} ${req.user.lastName ?? ''}`.trim() || req.user.email || 'Admin';

  config.history.push({
    percentage: pct,
    effectiveFrom: new Date(),
    changedBy: req.user.id,
    changedByName: name,
  });
  await config.save();

  return ok(res, {
    percentage: config.currentPercentage(),
    history: [...config.history].sort((a, b) => b.effectiveFrom - a.effectiveFrom),
  }, `Royalty percentage set to ${pct}%.`);
});

/* ── Row builder ─────────────────────────────────────────────────────────── */

const buildRow = (quote, payment, config) => {
  const pct = config.getEffectivePercentage(payment.date, quote.quoteId);
  return {
    quoteId: quote.quoteId,
    quotationNo: quote.quoteNumber,
    customerName: quote.customerName,
    quotationDate: quote.createdAt,
    paymentDate: payment.date,
    paymentReference: payment.reference || '—',
    paymentSource: payment.source,
    paymentAmount: round2(payment.amount),
    royaltyPercent: pct,
    royaltyAmount: round2((payment.amount * pct) / 100),
    paymentStatus: quote.paymentStatus,
    quotationStatus: quote.quotationStatus,
    royaltyStatus: 'Calculated',
  };
};

/* ══════════════════════════════════════════════════════════════════════════
   GET /tenant/royalty
   Main report: quotations → eligible payments → royalty rows, filtered.
   ══════════════════════════════════════════════════════════════════════════ */
exports.getReport = asyncHandler(async (req, res) => {
  const loaded = await loadTenant(req.user.id);
  if (loaded.error) return fail(res, loaded.error, loaded.status);
  const { tenant, apiKey } = loaded;

  const {
    month, year, dateFrom, dateTo,
    quoteId, search, source, status,
  } = req.query;

  const [merged, config] = await Promise.all([
    fetchMergedQuotes(tenant, apiKey),
    getOrCreateConfig(req.user.tenantId),
  ]);

  // ── Period bounds — default to the current month ──────────────────────
  const { periodStart, periodEnd } = resolvePeriod({ month, year, dateFrom, dateTo });

  const searchTerm = String(quoteId ?? search ?? '').trim().toLowerCase();
  const matchesSearch = (q) => {
    if (!searchTerm) return true;
    const haystack = `${q.quoteNumber} ${q.customerName} ${q.email}`.toLowerCase();
    return haystack.includes(searchTerm);
  };

  // ── Quotations → eligible payments → rows ──────────────────────────────
  let rows = [];
  for (const q of merged) {
    if (!matchesSearch(q)) continue;
    if (!['paid', 'partially_paid'].includes(q.paymentStatus)) continue;
    if (q.quotationStatus === 'Cancelled') continue;

    for (const payment of eligiblePayments(q)) {
      if (!payment.date || !(payment.amount > 0)) continue;
      rows.push(buildRow(q, payment, config));
    }
  }

  // ── Diagnostic breakdown ─────────────────────────────────────────────────
  // A quotation's workflow *stage* (e.g. "Payment Completed") is a separate
  // field from its *payment status* — a quote can be staged as complete
  // while still owing its full balance if no payment was ever logged. This
  // breakdown makes that visible instead of the report just looking empty,
  // covering the full matched dataset (not period-filtered, since a quote
  // with no payment has no payment date to filter by).
  const scannedQuotations = merged.filter(matchesSearch);

  // All quotations *created* within the selected period, independent of
  // payment status — answers "how many quotes this month" on its own,
  // separate from "how many of them have been paid".
  const quotationsInPeriod = scannedQuotations.filter(q => {
    if (!q.createdAt) return false;
    const d = new Date(q.createdAt);
    if (periodStart && d < periodStart) return false;
    if (periodEnd && d > periodEnd) return false;
    return true;
  });

  const statusBreakdown = ['pending', 'paid', 'partially_paid', 'failed', 'refunded'].map(s => {
    const matches = scannedQuotations.filter(q => q.paymentStatus === s);
    return {
      status: s,
      count: matches.length,
      amount: round2(matches.reduce((sum, q) => sum + (s === 'pending' ? q.amount : (q.paidAmount ?? q.amount)), 0)),
    };
  }).filter(b => b.count > 0);

  // ── Filters ──────────────────────────────────────────────────────────────
  rows = rows.filter(r => {
    const d = new Date(r.paymentDate);
    if (periodStart && d < periodStart) return false;
    if (periodEnd && d > periodEnd) return false;
    return true;
  });
  if (source) rows = rows.filter(r => r.paymentSource.toLowerCase() === String(source).toLowerCase());
  if (status) rows = rows.filter(r => r.paymentStatus.toLowerCase() === String(status).toLowerCase());

  rows.sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));

  // ── Summary ──────────────────────────────────────────────────────────────
  const summary = {
    // "How many quotes this month" — independent of payment status.
    quotationsInPeriod: quotationsInPeriod.length,
    // "Total payments done this month" — count + amount of actual payment
    // transactions whose payment date falls in the selected period.
    totalPayments: rows.length,
    totalEligibleAmount: round2(rows.reduce((s, r) => s + r.paymentAmount, 0)),
    royaltyPercentage: config.currentPercentage() ?? 0,
    totalRoyaltyPayable: round2(rows.reduce((s, r) => s + r.royaltyAmount, 0)),
    quotationCount: new Set(rows.map(r => r.quoteId)).size,
    manualCount: rows.filter(r => r.paymentSource === 'Manual').length,
    razorpayCount: rows.filter(r => r.paymentSource === 'Razorpay').length,
    scannedQuotations: scannedQuotations.length,
  };

  return ok(res, {
    summary,
    rows,
    statusBreakdown,
    period: {
      from: periodStart ? periodStart.toISOString() : null,
      to: periodEnd ? periodEnd.toISOString() : null,
    },
  });
});
