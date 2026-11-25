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
  const royalty = config.royaltyFor(payment.amount, payment.date, quote.quoteId);
  const quoteAmount = round2(Number(quote.amount) || 0);
  const paidToDate = round2(Number(quote.paidAmount) || 0);
  return {
    quoteId: quote.quoteId,
    quotationNo: quote.quoteNumber,
    quotationTitle: quote.title || '',
    customerName: quote.customerName,
    customerEmail: quote.email || '',
    quotationDate: quote.createdAt,
    paymentDate: payment.date,
    paymentReference: payment.reference || '—',
    paymentSource: payment.source,
    paymentMethod: payment.method || '',
    paymentAmount: round2(payment.amount),
    royaltyPercent: royalty.percentage,
    royaltyAmount: royalty.amount,
    // Why this rate: in force that day / predates the first rate / override / none set.
    rateBasis: royalty.basis,
    rateEffectiveFrom: royalty.effectiveFrom,
    quoteAmount,
    paidToDate,
    balanceDue: round2(Math.max(0, quoteAmount - paidToDate)),
    paymentStatus: quote.paymentStatus,
    quotationStatus: quote.quotationStatus,
    royaltyStatus: royalty.basis === 'unset' ? 'Rate not set' : 'Calculated',
  };
};

const sumBy = (rows, key) => round2(rows.reduce((s, r) => s + (r[key] || 0), 0));

/* ══════════════════════════════════════════════════════════════════════════
   GET /tenant/royalty
   Main report: quotations → eligible payments → royalty rows, filtered.
   ══════════════════════════════════════════════════════════════════════════ */
exports.getReport = asyncHandler(async (req, res) => {
  const loaded = await loadTenant(req.user.id);
  if (loaded.error) return fail(res, loaded.error, loaded.status);
  const { tenant, apiKey } = loaded;

  const {
    month, year, dateFrom, dateTo, period,
    quoteId, search, source, status,
  } = req.query;

  const [merged, config] = await Promise.all([
    fetchMergedQuotes(tenant, apiKey),
    getOrCreateConfig(req.user.tenantId),
  ]);

  // ── Period bounds — default to the current month; period=all → no bounds ──
  const { periodStart, periodEnd } = resolvePeriod({ month, year, dateFrom, dateTo, period });

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
  if (status) rows = rows.filter(r => r.paymentStatus.toLowerCase() === String(status).toLowerCase());

  // Source split is taken before the source filter, so the Manual / Razorpay
  // toggles keep showing both sides instead of zeroing the one filtered out.
  const sourceSplit = ['Manual', 'Razorpay'].map(s => {
    const of = rows.filter(r => r.paymentSource === s);
    return { source: s, count: of.length, amount: sumBy(of, 'paymentAmount'), royalty: sumBy(of, 'royaltyAmount') };
  });

  if (source) rows = rows.filter(r => r.paymentSource.toLowerCase() === String(source).toLowerCase());

  rows.sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));

  // One line per rate actually applied — normally a single "₹X × 9%", but a
  // period spanning a rate change shows each rate's share separately.
  const byRate = new Map();
  for (const r of rows) {
    const e = byRate.get(r.royaltyPercent) ?? { percentage: r.royaltyPercent, count: 0, amount: 0, royalty: 0 };
    e.count++;
    e.amount += r.paymentAmount;
    e.royalty += r.royaltyAmount;
    byRate.set(r.royaltyPercent, e);
  }
  const rateBreakdown = [...byRate.values()]
    .map(e => ({ ...e, amount: round2(e.amount), royalty: round2(e.royalty) }))
    .sort((a, b) => b.amount - a.amount);

  const current = config.currentEntry();
  const isPaidStatus = (q) => ['paid', 'partially_paid'].includes(q.paymentStatus);

  // ── Summary ──────────────────────────────────────────────────────────────
  const summary = {
    // "How many quotes this period" — independent of payment status.
    quotationsInPeriod: quotationsInPeriod.length,
    // …and how many of *those* have a payment recorded (any date).
    paidQuotationsInPeriod: quotationsInPeriod.filter(q => isPaidStatus(q) && eligiblePayments(q).length > 0).length,
    // Payment transactions whose payment date falls in the selected period.
    totalPayments: rows.length,
    totalEligibleAmount: sumBy(rows, 'paymentAmount'),
    royaltyPercentage: current?.percentage ?? 0,
    rateConfigured: !!current,
    rateSince: current?.effectiveFrom ?? null,
    totalRoyaltyPayable: sumBy(rows, 'royaltyAmount'),
    // Distinct quotations those payments belong to (may be created in any period).
    quotationCount: new Set(rows.map(r => r.quoteId)).size,
    manualCount: sourceSplit[0].count,
    razorpayCount: sourceSplit[1].count,
    scannedQuotations: scannedQuotations.length,
  };

  return ok(res, {
    summary,
    rows,
    statusBreakdown,
    sourceSplit,
    rateBreakdown,
    period: {
      from: periodStart ? periodStart.toISOString() : null,
      to: periodEnd ? periodEnd.toISOString() : null,
    },
  });
});
