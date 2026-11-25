'use strict';

/**
 * services/superAdminAggregation.service.js
 *
 * Cross-tenant data aggregation for the Super Admin Portal.
 * Reuses the same per-tenant "fetch CRM quotes + Razorpay + local tracking,
 * merged" pipeline that Tracking and Royalty already use
 * (quoteTracking.service.js) — this is NOT a separate data ecosystem, it
 * just runs that pipeline once per tenant (through a short-TTL cache, see
 * below) and rolls the results up.
 */

const Tenant = require('../models/tenant');
const RoyaltyConfig = require('../models/royaltyConfig');
const {
  fetchMergedQuotes, eligiblePayments, round2,
} = require('./quoteTracking.service');
const { getSyncStatus } = require('./crmSync.service');

const emptyQuoteStats = () => ({ total: 0, pending: 0, approved: 0, rejectedOrExpired: 0 });

/**
 * Buckets a merged quote for the "Approved / Pending / Rejected-Expired"
 * KPIs (mutually exclusive, so they always sum to the total).
 *
 * "Approved" used to mean paid/partially-paid only, so the "Approved
 * Quotations" KPI read 0 while clients had approved 61 quotes in the CRM.
 * It now means the client approved it in the CRM, or it has been paid
 * (payment implies acceptance).
 */
const quoteOutcome = (q) => {
  if (['paid', 'partially_paid'].includes(q.paymentStatus) || q.approvalStatus === 'approved') return 'approved';
  if (q.paymentStatus === 'failed' || q.quotationStatus === 'Cancelled' || q.approvalStatus === 'rejected') return 'rejectedOrExpired';
  return 'pending';
};
const emptyPaymentStats = () => ({ count: 0, totalCollected: 0, pendingAmount: 0, failedCount: 0 });

/* ══════════════════════════════════════════════════════════════════════════
   Tenant quote cache
   ──────────────────────────────────────────────────────────────────────────
   Every cross-tenant view (dashboard, quotations, payments, activity) needs
   the same "this tenant's merged quotes" data, and quotes are never stored
   locally — they're fetched live from each tenant's own CRM + Razorpay on
   every call. Without this, navigating Dashboard → Quotations → Payments
   within a few seconds triggers a full external-API round trip per tenant,
   per page. A 60s in-process TTL cache (keyed by tenantId) collapses that to
   one fetch per tenant per minute, shared across every consumer below,
   while staying "near-real-time" rather than introducing a persisted
   cache/sync collection the data model doesn't otherwise need. The cache
   stores the in-flight *promise*, not just the resolved value, so two
   concurrent requests for the same tenant (e.g. two admins hitting the
   dashboard at once) also collapse into a single upstream fetch.
   ══════════════════════════════════════════════════════════════════════════ */

const QUOTE_CACHE_TTL_MS = 60_000;
const tenantQuoteCache = new Map(); // tenantId -> { expiresAt, promise }

const fetchTenantQuotesUncached = async (tenant) => {
  if (!tenant.crm?.isConfigured) return { quotes: [], error: null, sync: null };
  let apiKey;
  try { apiKey = tenant.getCRMKey(); } catch { apiKey = null; }
  if (!apiKey) return { quotes: [], error: 'CRM key could not be decrypted.', sync: null };

  try {
    // fetchMergedQuotes reads the synced copy (crmSync.service), so this no
    // longer calls the CRM once per tenant per page view.
    const merged = await fetchMergedQuotes(tenant, apiKey);
    const sync = await getSyncStatus(tenant._id).catch(() => null);
    return { quotes: merged, error: null, sync };
  } catch (err) {
    const sync = await getSyncStatus(tenant._id).catch(() => null);
    return { quotes: [], error: err.message || 'Sync failed.', sync };
  }
};

/** Drops a tenant's cached merged quotes so the next read sees fresh data
 *  (called after a successful CRM sync). */
const invalidateTenantQuoteCache = (tenantId) => {
  if (tenantId) tenantQuoteCache.delete(tenantId);
};

/**
 * Fetches one tenant's merged quotes (CRM + tracking + Razorpay), through
 * the TTL cache described above. Never throws; a fetch failure for this
 * tenant just yields an empty array plus an error string the caller can
 * surface, so one tenant's outage never breaks the rest of the aggregation.
 *
 * Pass `{ bypassCache: true }` for an explicit "Refresh" action.
 */
const fetchTenantQuotes = (tenant, { bypassCache = false } = {}) => {
  const key = tenant.tenantId;
  const cached = tenantQuoteCache.get(key);
  if (!bypassCache && cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = fetchTenantQuotesUncached(tenant);
  tenantQuoteCache.set(key, { expiresAt: Date.now() + QUOTE_CACHE_TTL_MS, promise });

  // Don't let a failed fetch poison the cache for the full TTL — clear it so
  // the *next* call retries instead of repeating the same error for 60s.
  promise.then(
    (result) => { if (result.error) tenantQuoteCache.delete(key); },
    () => tenantQuoteCache.delete(key),
  );

  return promise;
};

const tenantLabel = (tenant) => ({
  tenantId: tenant.tenantId,
  tenantName: tenant.businessName || `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim() || tenant.email,
});

const inRange = (dateVal, periodStart, periodEnd) => {
  // No bounds ("All time") → everything counts, even a record with no date.
  if (!periodStart && !periodEnd) return true;
  if (!dateVal) return false;
  const d = new Date(dateVal);
  if (periodStart && d < periodStart) return false;
  if (periodEnd && d > periodEnd) return false;
  return true;
};

/**
 * Every account whose data the Super Admin portal monitors: all store
 * tenants, plus the superadmin account itself once it has connected its own
 * CRM. Sub-users are excluded (they share their parent's data).
 *
 * The superadmin used to be excluded unconditionally ("an admin-tier login,
 * not a store"), but Settings lets the superadmin connect a CRM — and when
 * that is the only CRM connection (as in this deployment), every Super Admin
 * dashboard/quotation/payment view aggregated zero accounts while Settings
 * showed the CRM as connected.
 */
const MONITORED_ACCOUNTS_FILTER = {
  isSubUser: { $ne: true },
  $or: [
    { role: 'tenant' },
    { role: 'superadmin', 'crm.isConfigured': true },
  ],
};

const listMonitoredTenants = () =>
  Tenant.find(MONITORED_ACCOUNTS_FILTER)
    .select('+crm.apiKey +razorpay.keyId +razorpay.keySecret')
    .sort({ createdAt: -1 });

/**
 * Builds the full monitoring snapshot for one tenant, scoped to a period.
 * Never throws — a CRM/Razorpay failure for this tenant is reported in the
 * snapshot itself (`syncStatus: 'error'`) so it can't take down the rest of
 * the aggregation.
 */
const buildTenantSnapshot = async (tenant, { periodStart, periodEnd, bypassCache = false } = {}) => {
  const base = {
    id: String(tenant._id),
    tenantId: tenant.tenantId,
    businessName: tenant.businessName || '',
    ownerName: `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim(),
    email: tenant.email,
    phone: tenant.phone || '',
    city: tenant.city || '',
    isActive: tenant.isActive !== false,
    setupStep: tenant.setupStep,
    createdAt: tenant.createdAt,
    crm: {
      isConfigured: tenant.crm?.isConfigured ?? false,
      provider: tenant.crm?.provider ?? null,
      verifiedAt: tenant.crm?.verifiedAt ?? null,
    },
    razorpay: {
      isConfigured: tenant.razorpay?.isConfigured ?? false,
      verifiedAt: tenant.razorpay?.verifiedAt ?? null,
    },
    syncStatus: 'not_configured',
    syncError: null,
    lastSyncAt: null,
    quotations: emptyQuoteStats(),
    invoicedAmount: 0,
    payments: emptyPaymentStats(),
    royalty: { percentage: 0, totalPayable: 0 },
  };

  if (!tenant.crm?.isConfigured) return base;

  const [{ quotes: merged, error, sync }, royaltyConfig] = await Promise.all([
    fetchTenantQuotes(tenant, { bypassCache }),
    RoyaltyConfig.findOne({ tenantId: tenant.tenantId }),
  ]);

  if (error) return { ...base, syncStatus: 'error', syncError: error, lastSyncAt: sync?.lastSuccessAt ?? null };

  const quotations = emptyQuoteStats();
  const payments = emptyPaymentStats();
  let invoicedAmount = 0;
  let royaltyPayable = 0;
  const pct = royaltyConfig?.currentPercentage() ?? 0;

  for (const q of merged) {
    if (!inRange(q.createdAt, periodStart, periodEnd)) continue;

    quotations.total++;
    invoicedAmount += q.amount ?? 0;
    quotations[quoteOutcome(q)]++;

    if (q.paymentStatus === 'pending') {
      payments.pendingAmount += q.amount ?? 0;
    } else if (q.paymentStatus === 'failed') {
      payments.failedCount++;
    }
  }

  // Payments/royalty use each payment's own date (not the quote's
  // createdAt) and the rate in force on that date (royaltyFor) — the exact
  // calculation the tenant's Royalty page uses, so the two pages' totals for
  // the same tenant always agree. (This used to apply today's rate to every
  // payment while the Royalty page used the historical one.)
  for (const q of merged) {
    if (!['paid', 'partially_paid'].includes(q.paymentStatus)) continue;
    // The Royalty page charges no royalty on cancelled quotations either.
    const earnsRoyalty = !!royaltyConfig && q.quotationStatus !== 'Cancelled';
    for (const p of eligiblePayments(q)) {
      if (!p.date || !(p.amount > 0) || !inRange(p.date, periodStart, periodEnd)) continue;
      payments.count++;
      payments.totalCollected += p.amount;
      if (earnsRoyalty) royaltyPayable += royaltyConfig.royaltyFor(p.amount, p.date, q.quoteId).amount;
    }
  }

  // Real sync health: numbers come from the last successful sync; if the most
  // recent attempt failed, flag it (with the reason) while still showing them.
  const lastSyncFailed = sync?.lastStatus === 'error';
  return {
    ...base,
    syncStatus: lastSyncFailed ? 'error' : 'ok',
    syncError: lastSyncFailed ? sync.lastError : null,
    lastSyncAt: sync?.lastSuccessAt ?? null,
    quotations,
    invoicedAmount: round2(invoicedAmount),
    payments: {
      count: payments.count,
      totalCollected: round2(payments.totalCollected),
      pendingAmount: round2(payments.pendingAmount),
      failedCount: payments.failedCount,
    },
    royalty: { percentage: pct, totalPayable: round2(royaltyPayable) },
  };
};

/** A merged quote → one Quotation Monitoring row (list views). */
const quoteRow = (label, q) => ({
  ...label,
  quoteId: q.quoteId,
  quotationNo: q.quoteNumber,
  customerName: q.customerName,
  customerEmail: q.email,
  customerPhone: q.phone || '',
  companyName: q.companyName || '',
  quotationDate: q.createdAt,
  expiryDate: q.expiryDate || null,
  isExpired: !!q.isExpired,
  amount: round2(q.amount ?? 0),
  currency: q.currency || 'INR',
  quotationStatus: q.quotationStatus,
  paymentStatus: q.paymentStatus,
  approvalStatus: q.approvalStatus,
  outcome: quoteOutcome(q),
  paidAmount: round2(q.paidAmount ?? 0),
  balanceDue: round2(Math.max(0, (q.amount ?? 0) - (q.paidAmount ?? 0))),
  createdBy: q.ownerName || null,
  relatedDeal: q.dealName || null,
  lastUpdated: q.trackingUpdatedAt || q.updatedAt || null,
});

/**
 * One merged quote (CRM + tracking + Razorpay) for a detail view, looked up
 * by CRM id or quote number in that tenant's (cached) quote set.
 * Returns { tenant, quote } or null when the tenant/quote doesn't exist.
 */
const findTenantQuote = async (tenantId, quoteId, { bypassCache = false } = {}) => {
  const tenant = await Tenant.findOne({ tenantId, ...MONITORED_ACCOUNTS_FILTER })
    .select('+crm.apiKey +razorpay.keyId +razorpay.keySecret');
  if (!tenant) return null;

  const { quotes, error, sync } = await fetchTenantQuotes(tenant, { bypassCache });
  if (error && !quotes.length) {
    return { tenant: tenantLabel(tenant), quote: null, error };
  }
  const id = String(quoteId);
  const quote = quotes.find(q => String(q.quoteId) === id || String(q.quoteNumber) === id) ?? null;
  return {
    tenant: tenantLabel(tenant),
    quote: quote && {
      ...quote,
      outcome: quoteOutcome(quote),
      balanceDue: round2(Math.max(0, (quote.amount ?? 0) - (quote.paidAmount ?? 0))),
      payments: eligiblePayments(quote),
    },
    lastSyncAt: sync?.lastSuccessAt ?? null,
  };
};

/**
 * One row per quotation, across every tenant — spec: Quotation Monitoring.
 * "Created By" / "Related Deal" use the best available CRM fields (the
 * quote owner and deal name); there's no separate Invoice entity in this
 * system, so invoice-status is intentionally omitted rather than faked.
 */
const buildAllTenantQuoteRows = async ({ periodStart, periodEnd, bypassCache = false } = {}) => {
  const tenants = await listMonitoredTenants();
  const rows = [];
  const tenantErrors = [];

  await Promise.all(tenants.map(async (tenant) => {
    const { quotes, error } = await fetchTenantQuotes(tenant, { bypassCache });
    if (error) tenantErrors.push({ ...tenantLabel(tenant), error });

    const label = tenantLabel(tenant);
    for (const q of quotes) {
      if (!inRange(q.createdAt, periodStart, periodEnd)) continue;
      rows.push(quoteRow(label, q));
    }
  }));

  rows.sort((a, b) => new Date(b.quotationDate) - new Date(a.quotationDate));
  return { rows, tenantErrors };
};

/**
 * One row per actual payment transaction, across every tenant — spec:
 * Payment Tracking. Reuses `eligiblePayments`, the exact same "what counts
 * as a real payment" logic Royalty and the Dashboard already use, so a
 * transaction reconciles identically everywhere it appears in the app.
 */
const buildAllTenantPaymentRows = async ({ periodStart, periodEnd, bypassCache = false } = {}) => {
  const tenants = await listMonitoredTenants();
  const rows = [];
  const tenantErrors = [];

  await Promise.all(tenants.map(async (tenant) => {
    const { quotes, error } = await fetchTenantQuotes(tenant, { bypassCache });
    if (error) tenantErrors.push({ ...tenantLabel(tenant), error });

    const label = tenantLabel(tenant);
    for (const q of quotes) {
      if (!['paid', 'partially_paid'].includes(q.paymentStatus)) continue;
      for (const p of eligiblePayments(q)) {
        if (!p.date || !(p.amount > 0) || !inRange(p.date, periodStart, periodEnd)) continue;
        rows.push({
          ...label,
          quoteId: q.quoteId,
          quotationNo: q.quoteNumber,
          customerName: q.customerName,
          customerEmail: q.email,
          paymentDate: p.date,
          paymentMethod: q.paymentMethod || null,
          paymentAmount: round2(p.amount),
          paymentStatus: q.paymentStatus,
          paymentSource: p.source,
          transactionReference: p.reference || null,
          refundStatus: q.paymentStatus === 'refunded' ? 'refunded' : null,
          createdBy: p.source === 'Razorpay' ? 'System · Auto-sync' : (q.ownerName || 'Admin'),
          lastUpdated: q.trackingUpdatedAt || null,
        });
      }
    }
  }));

  rows.sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));
  return { rows, tenantErrors };
};

/**
 * A unified, recency-sorted activity feed across every tenant — spec:
 * Tracking / Activity. Built from the same quote rows/payment rows above
 * plus each tenant's integration sync status, so it needs no new data
 * source of its own.
 */
const buildActivityFeed = async ({ periodStart, periodEnd, bypassCache = false } = {}) => {
  const tenants = await listMonitoredTenants();
  const events = [];
  const tenantErrors = [];

  await Promise.all(tenants.map(async (tenant) => {
    const label = tenantLabel(tenant);
    const { quotes, error } = await fetchTenantQuotes(tenant, { bypassCache });

    if (error) {
      tenantErrors.push({ ...label, error });
      events.push({
        ...label,
        type: 'sync_failed',
        title: 'CRM sync failed',
        detail: error,
        timestamp: new Date().toISOString(),
        severity: 'error',
      });
      return;
    }

    if (!tenant.crm?.isConfigured) return;

    for (const q of quotes) {
      if (q.createdAt && inRange(q.createdAt, periodStart, periodEnd)) {
        events.push({
          ...label,
          type: 'quotation_created',
          title: `Quotation ${q.quoteNumber} created`,
          detail: `${q.customerName || 'Customer'} · ${round2(q.amount ?? 0)}`,
          timestamp: q.createdAt,
          severity: 'info',
        });
      }
      if (q.trackingUpdatedAt && inRange(q.trackingUpdatedAt, periodStart, periodEnd)) {
        events.push({
          ...label,
          type: 'quotation_updated',
          title: `Quotation ${q.quoteNumber} updated`,
          detail: `Stage: ${q.quotationStatus} · Payment: ${q.paymentStatus}`,
          timestamp: q.trackingUpdatedAt,
          severity: 'info',
        });
      }
      if (['paid', 'partially_paid'].includes(q.paymentStatus)) {
        for (const p of eligiblePayments(q)) {
          if (!p.date || !(p.amount > 0) || !inRange(p.date, periodStart, periodEnd)) continue;
          events.push({
            ...label,
            type: 'payment_recorded',
            title: `Payment received — ${q.quoteNumber}`,
            detail: `${round2(p.amount)} via ${p.source}${p.reference ? ' · ' + p.reference : ''}`,
            timestamp: p.date,
            severity: 'success',
          });
        }
      }
    }
  }));

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return { events, tenantErrors };
};

const buildAllTenantSnapshots = async ({ periodStart, periodEnd, bypassCache = false } = {}) => {
  const tenants = await listMonitoredTenants();
  const settled = await Promise.allSettled(
    tenants.map(t => buildTenantSnapshot(t, { periodStart, periodEnd, bypassCache })),
  );
  // A rejection here would only happen from a bug in buildTenantSnapshot
  // itself (it already catches its own errors) — still isolate defensively
  // rather than let one bad promise blank the whole dashboard.
  return settled.map((r, i) => r.status === 'fulfilled'
    ? r.value
    : { tenantId: tenants[i].tenantId, syncStatus: 'error', syncError: r.reason?.message || 'Unknown error' });
};

/** Minimal tenant list for filter dropdowns — no CRM/Razorpay calls, so it's
 *  always fast regardless of how many tenants exist or whether their CRM is
 *  reachable. Use this instead of buildAllTenantSnapshots() when all you
 *  need is "which tenants exist". */
const listTenantsLite = async () => {
  const tenants = await Tenant.find(MONITORED_ACCOUNTS_FILTER)
    .select('tenantId businessName firstName lastName email')
    .sort({ businessName: 1 });
  return tenants.map(t => ({
    tenantId: t.tenantId,
    businessName: t.businessName || '',
    ownerName: `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim() || t.email,
  }));
};

module.exports = {
  buildTenantSnapshot,
  buildAllTenantSnapshots,
  buildAllTenantQuoteRows,
  buildAllTenantPaymentRows,
  buildActivityFeed,
  listMonitoredTenants,
  listTenantsLite,
  invalidateTenantQuoteCache,
  quoteOutcome,
  findTenantQuote,
  inRange,
};
