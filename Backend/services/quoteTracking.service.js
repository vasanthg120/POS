'use strict';

/**
 * services/quoteTracking.service.js
 *
 * Shared CRM-quote + Razorpay + QuoteTracking merge logic.
 *
 * Extracted out of crm.quotes.controller.js (the Tracking page's backend) so
 * other features — currently the Royalty page — can reuse the exact same
 * "quotation + its payment status" view without duplicating this logic or
 * drifting from it. Behavior is unchanged from the original controller.
 */

const QuoteTracking = require('../models/quote.tracking');

/* ── Method normaliser ───────────────────────────────────────────────────── */

const METHOD_MAP = {
  upi: 'UPI', card: 'Card', netbanking: 'Net Banking',
  net_banking: 'Net Banking', wallet: 'Wallet', emi: 'EMI',
  bank_transfer: 'Bank Transfer', cash: 'Cash',
};

const normaliseMethod = (raw = '') =>
  METHOD_MAP[raw.toLowerCase().trim().replace(/\s+/g, '_')] ?? (raw || '');

const dateLabel = (ts) => {
  const d = ts ? new Date(ts > 1e10 ? ts : ts * 1000) : new Date();
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

/* ── ProspectConnect ─────────────────────────────────────────────────────── */

const PC_API = 'https://api.prospectconnect.ai/quotes/getQuotes';

const fetchPage = async (apiKey, { search = '', limit = 200, startAfter = 0 } = {}) => {
  const res = await fetch(PC_API, {
    method:  'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ limit, search, startAfter }),
    signal:  AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`ProspectConnect ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
  }
  const data = await res.json();
  return data?.quotes ?? data?.data ?? (Array.isArray(data) ? data : []);
};

const fetchAllQuotes = async (apiKey, search = '') => {
  if (search) return fetchPage(apiKey, { search, limit: 200, startAfter: 0 });
  let all = [], cursor = 0, safety = 15;
  while (safety-- > 0) {
    const page = await fetchPage(apiKey, { search: '', limit: 200, startAfter: cursor });
    if (!page.length) break;
    all = all.concat(page);
    if (page.length < 200) break;
    cursor += 200;
  }
  return all;
};

/* ── Razorpay: fetch payments for a tenant ───────────────────────────────── */

/**
 * Fetches up to `count` captured payments from Razorpay and returns a Map
 * keyed by notes.quotationNo → payment entity.
 * Also indexes by payment ID so the drawer's "Sync Razorpay" still works.
 */
const fetchRazorpayPaymentMap = async (tenant) => {
  if (!tenant.razorpay?.isConfigured) return null;

  const { keyId, keySecret } = tenant.getRazorpayKeys?.() ?? {};
  if (!keyId || !keySecret) return null;

  try {
    const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const url = `https://api.razorpay.com/v1/payments?count=100&status=captured`;
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const items = data.items ?? [];

    const byQuotationNo = new Map();
    const byPaymentId   = new Map();

    for (const p of items) {
      byPaymentId.set(p.id, p);
      const qNo = p.notes?.quotationNo ?? p.notes?.quoteId ?? p.receipt ?? '';
      if (qNo) byQuotationNo.set(String(qNo).trim(), p);
    }

    return { byQuotationNo, byPaymentId };
  } catch {
    return null;
  }
};

/* ── Tenant loader ───────────────────────────────────────────────────────── */

const loadTenant = async (userId) => {
  const Tenant = require('../models/tenant');
  const tenant = await Tenant.findById(userId).select('+crm.apiKey +razorpay.keyId +razorpay.keySecret');
  if (!tenant) return { error: 'Tenant not found', status: 404 };
  if (!tenant.crm?.isConfigured) return { error: 'CRM is not configured. Connect it in Settings first.', status: 400 };
  const apiKey = tenant.getCRMKey?.();
  if (!apiKey) return { error: 'CRM API key could not be decrypted.', status: 500 };
  return { tenant, apiKey };
};

/* ── Normalise CRM quote ─────────────────────────────────────────────────── */

const normalise = (q) => {
  const client  = q.client_details ?? {};
  const contact = q.contact_detail ?? {};
  const owner   = q.quote_owner   ?? {};
  const deal    = q.deal          ?? {};

  const rawItems = Array.isArray(q.items)     ? q.items
                 : Array.isArray(q.line_items) ? q.line_items
                 : Array.isArray(q.products)   ? q.products
                 : [];

  return {
    id:          q._id ?? q.id,
    quoteId:     q._id ?? q.id,
    quoteNumber: String(q.ticket_number ?? q._id ?? ''),
    title:       q.quote_name ?? deal.name ?? q.title ?? String(q.ticket_number ?? ''),
    dealName:    q.quote_name ?? deal.name ?? '',
    ownerName:   owner.name  ?? owner.fullName  ?? '',
    ownerEmail:  owner.email ?? '',
    ownerPhone:  owner.phone ?? '',
    customerName: client.name  ?? client.fullName ?? contact.name_beautify ?? contact.name_pure ?? contact.name ?? '',
    email:        client.email ?? contact.email ?? '',
    phone:        client.phone ?? contact.phone ?? '',
    amount:       q.quote_amount ?? q.amount ?? q.total ?? 0,
    currency:     q.currency ?? 'INR',
    status:               q.quote_status           ?? q.status ?? 'draft',
    clientApprovalStatus: q.client_approval_status ?? '',
    createdAt:  q.created_at  ?? q.createdAt  ?? null,
    updatedAt:  q.updated_at  ?? q.updatedAt  ?? null,
    expiryDate: q.expiration_date ?? q.expiry_date ?? q.expiryDate ?? null,
    notes: q.notes ?? '',
    items: rawItems,
    raw: q,
  };
};

/* ── Auto-detect payment status from Razorpay ────────────────────────────── */

/**
 * Given a normalised CRM quote and a matched Razorpay payment entity (or null),
 * return the fields that should be written to QuoteTracking.
 *
 * This runs ONLY when the tracking record has no admin-override
 * (i.e. paymentStatus is still 'pending' and paidAmount is 0).
 */
const autoDetectFromRazorpay = (quote, rzpPayment) => {
  if (!rzpPayment) return null;

  const amountINR = (rzpPayment.amount ?? 0) / 100;
  const method    = normaliseMethod(rzpPayment.method ?? '');
  const paidAt    = rzpPayment.created_at
    ? new Date(rzpPayment.created_at * 1000).toISOString()
    : new Date().toISOString();

  // Full payment
  if (amountINR >= quote.amount) {
    return {
      paymentStatus : 'paid',
      paidAmount    : amountINR,
      paymentMethod : method,
      paidAt,
      _paymentId    : rzpPayment.id,
      rzpBank       : rzpPayment.bank   ?? null,
      rzpVpa        : rzpPayment.vpa    ?? null,
      rzpWallet     : rzpPayment.wallet ?? null,
      _autoSynced   : true,
    };
  }

  // Partial payment
  if (amountINR > 0) {
    return {
      paymentStatus : 'partially_paid',
      paidAmount    : amountINR,
      paymentMethod : method,
      paidAt,
      _paymentId    : rzpPayment.id,
      rzpBank       : rzpPayment.bank   ?? null,
      rzpVpa        : rzpPayment.vpa    ?? null,
      rzpWallet     : rzpPayment.wallet ?? null,
      _autoSynced   : true,
    };
  }

  return null;
};

/* ── Merge tracking onto normalised quote ────────────────────────────────── */

const mergeTracking = (quote, tracking, rzpPayment) => {
  // Auto-detect from Razorpay as long as no *real* payment has been recorded
  // yet (still 'pending' with nothing paid). Deliberately NOT gated on
  // `_adminOverride` here — that flag also gets set by unrelated edits (e.g.
  // a stage-only save from the Tracking drawer), and if it blocked detection
  // a genuine incoming Razorpay payment would never get picked up for a
  // quote whose stage was touched before it was paid.
  const isDefaultTracking = !tracking
    || (tracking.paymentStatus === 'pending' && !tracking.paidAmount);

  const autoFields = isDefaultTracking
    ? autoDetectFromRazorpay(quote, rzpPayment)
    : null;

  // Always run the merge below, even with no tracking record and no
  // Razorpay match — its `??` fallback chains (resolvePayStatus /
  // resolveQuotStage) already produce correct defaults for that case.
  // Previously this short-circuited to the bare CRM quote instead, which
  // has no paymentStatus/quotationStatus field at all — the Tracking page
  // never noticed because its frontend defaults paymentStatus to 'pending',
  // but that meant most quotes silently had paymentStatus === undefined
  // here rather than the real 'pending' string.
  return {
    ...quote,
    quotationStatus:   tracking?.quotationStatus   ?? resolveQuotStage(quote),
    paymentStatus:     autoFields?.paymentStatus   ?? tracking?.paymentStatus   ?? resolvePayStatus(quote),
    paymentMethod:     autoFields?.paymentMethod   ?? tracking?.paymentMethod   ?? '',
    paidAmount:        autoFields?.paidAmount      ?? tracking?.paidAmount      ?? 0,
    bankTransferRef:   tracking?.bankTransferRef   ?? '',
    bankTransferNotes: tracking?.bankTransferNotes ?? '',
    notes:             tracking?.notes             ?? quote.notes,
    paidAt: autoFields?.paidAt ?? (tracking?.paidAt
      ? (tracking.paidAt instanceof Date ? tracking.paidAt.toISOString() : tracking.paidAt)
      : null),
    timeline:          Array.isArray(tracking?.timeline) ? tracking.timeline : [],
    manualPayments:    Array.isArray(tracking?.manualPayments) ? tracking.manualPayments : [],
    _paymentId:        autoFields?._paymentId  ?? tracking?._paymentId  ?? null,
    rzpBank:           autoFields?.rzpBank      ?? tracking?.rzpBank     ?? null,
    rzpVpa:            autoFields?.rzpVpa       ?? tracking?.rzpVpa      ?? null,
    rzpWallet:         autoFields?.rzpWallet    ?? tracking?.rzpWallet   ?? null,
    trackingUpdatedAt: tracking?.updatedAt ?? null,
  };
};

/* ── Status resolvers (fallback when no tracking exists) ─────────────────── */

const resolvePayStatus = (q) => {
  const exp = q.expiryDate ?? '';
  if (exp && new Date(exp) < new Date()) return 'failed';
  return 'pending';
};

const resolveQuotStage = (q) => {
  const raw = (q.status ?? q.clientApprovalStatus ?? '').toLowerCase();
  if (raw === 'accepted' || raw === 'approved' || raw === 'paid') return 'Payment Completed';
  if (raw === 'sent' || raw === 'published') return 'Awaiting Payment';
  if (raw === 'cancelled' || raw === 'rejected') return 'Cancelled';
  if (raw === 'delivered') return 'Delivered';
  if (raw === 'closed' || raw === 'expired') return 'Closed';
  if (raw === 'draft') return 'Created';
  return 'In Progress';
};

/**
 * Fetches every quote for a tenant merged with its QuoteTracking record and
 * (if unsynced) its matching Razorpay payment — the same "one call gets you
 * every quote's current payment state" helper `getQuotes` uses internally.
 */
const fetchMergedQuotes = async (tenant, apiKey, search = '') => {
  const [raw, rzpMap] = await Promise.all([
    search ? fetchAllQuotes(apiKey, search) : fetchAllQuotes(apiKey),
    fetchRazorpayPaymentMap(tenant),
  ]);

  const quotes = raw.map(normalise);

  const trackingRecords = await QuoteTracking.find({ tenantId: tenant._id }).lean();
  const trackingMap     = new Map(trackingRecords.map(t => [String(t.quoteId), t]));

  return quotes.map(q => {
    const tracking   = trackingMap.get(String(q.quoteId));
    const rzpPayment = rzpMap?.byQuotationNo?.get(q.quoteNumber)
                    ?? rzpMap?.byQuotationNo?.get(String(q.quoteId));
    return mergeTracking(q, tracking, rzpPayment);
  });
};

/* ── Shared money / period helpers ────────────────────────────────────────── */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * A quote's eligible payment(s). Tracking records a payment through one of
 * three paths, checked in order:
 *   1. Itemized manual installments (the dedicated "Record Manual Payment"
 *      flow) — one row per installment.
 *   2. A Razorpay auto-synced payment (`_paymentId` set).
 *   3. A payment status/amount set directly via the Tracking drawer's
 *      general edit form (Payment Status → Paid/Partial + Paid Amount,
 *      then Save) — this doesn't go through either structured path above,
 *      but it's just as real a payment, so it's treated as a single manual
 *      entry using the recorded amount and date.
 * Manual and Razorpay are mutually exclusive per quote (QuoteTracking's
 * `_adminOverride` flag permanently blocks auto-sync once any manual action
 * happens on that quote), so this can never double-count the same payment.
 *
 * Shared by Royalty and the Super Admin cross-tenant aggregation so both
 * always agree on what counts as "a real payment" for a quote.
 */
const eligiblePayments = (quote) => {
  if (Array.isArray(quote.manualPayments) && quote.manualPayments.length) {
    return quote.manualPayments.map(mp => ({
      source: 'Manual',
      amount: mp.amount,
      date: mp.paymentDate,
      reference: mp.referenceNumber,
    }));
  }
  if (quote._paymentId) {
    return [{
      source: 'Razorpay',
      amount: quote.paidAmount,
      date: quote.paidAt,
      reference: quote._paymentId,
    }];
  }
  if (quote.paidAmount > 0) {
    return [{
      source: 'Manual',
      amount: quote.paidAmount,
      date: quote.paidAt ?? quote.trackingUpdatedAt,
      reference: quote.bankTransferRef || 'Recorded in Tracking',
    }];
  }
  return [];
};

/**
 * Resolves a { periodStart, periodEnd } window from query-style params —
 * explicit dateFrom/dateTo win, otherwise month (1-12) + year, defaulting to
 * the current month. Shared so every period-scoped report (Royalty, Super
 * Admin dashboard) resolves "this month" identically.
 */
const resolvePeriod = ({ month, year, dateFrom, dateTo } = {}) => {
  const now = new Date();
  if (dateFrom || dateTo) {
    return {
      periodStart: dateFrom ? new Date(dateFrom) : null,
      periodEnd: dateTo ? new Date(`${dateTo}T23:59:59.999`) : null,
    };
  }
  const y = year ? parseInt(year, 10) : now.getFullYear();
  const m = month ? parseInt(month, 10) - 1 : now.getMonth(); // caller uses 1-12
  return {
    periodStart: new Date(y, m, 1),
    periodEnd: new Date(y, m + 1, 0, 23, 59, 59, 999),
  };
};

module.exports = {
  PC_API,
  METHOD_MAP,
  normaliseMethod,
  dateLabel,
  round2,
  eligiblePayments,
  resolvePeriod,
  fetchPage,
  fetchAllQuotes,
  fetchRazorpayPaymentMap,
  loadTenant,
  normalise,
  autoDetectFromRazorpay,
  mergeTracking,
  resolvePayStatus,
  resolveQuotStage,
  fetchMergedQuotes,
};
