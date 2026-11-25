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
const PC_PAGE_SIZE = 200;
const PC_MAX_PAGES = 50; // 10,000 quotes per tenant before a fetch is reported incomplete

const crmError = (message, status = 502) => Object.assign(new Error(message), { status, isCrmError: true });

/**
 * One getQuotes call, validated. Returns { quotes, count } where `count` is
 * the CRM's own total (null if it didn't send one).
 *
 * Throws on anything that isn't a JSON body carrying a quote array — this
 * used to fall back to `[]`, which turned an error payload or a changed
 * response shape into "this tenant has zero quotes" with nothing logged.
 */
const fetchPageWithMeta = async (apiKey, { search = '', limit = PC_PAGE_SIZE, startAfter = 0 } = {}) => {
  let res;
  try {
    res = await fetch(PC_API, {
      method:  'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ limit, search, startAfter }),
      signal:  AbortSignal.timeout(20000),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw crmError(timedOut
      ? 'ProspectConnect did not respond within 20 seconds.'
      : `Could not reach ProspectConnect: ${err?.message || err}`, 504);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (the CRM rejected the API key — reconnect the CRM in Settings)'
      : '';
    // Response body only — never the request headers, which carry the key.
    throw Object.assign(
      crmError(`ProspectConnect ${res.status}${hint}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`),
      { upstreamStatus: res.status },
    );
  }

  let data;
  try { data = JSON.parse(text); } catch {
    throw crmError(`ProspectConnect returned a non-JSON response (HTTP ${res.status}).`);
  }

  const quotes = Array.isArray(data) ? data
               : Array.isArray(data?.quotes) ? data.quotes
               : Array.isArray(data?.data) ? data.data
               : null;
  if (!quotes) {
    const msg = data?.message || data?.error || `unexpected response keys: ${Object.keys(data || {}).join(', ') || 'none'}`;
    throw crmError(`ProspectConnect response did not contain a quote list (${String(msg).slice(0, 200)}).`);
  }

  const count = Number.isFinite(data?.count) ? data.count : null;
  return { quotes, count };
};

const fetchPage = async (apiKey, opts = {}) => (await fetchPageWithMeta(apiKey, opts)).quotes;

/**
 * Walks every page. Returns { quotes, reportedCount, complete } — `complete`
 * is false when the page cap was hit or fewer unique quotes came back than
 * the CRM says it has, so callers (the sync) never treat a truncated fetch
 * as the full dataset.
 */
const fetchAllQuotesWithMeta = async (apiKey) => {
  const all = [];
  let reportedCount = null;
  let exhausted = false;

  for (let page = 0; page < PC_MAX_PAGES; page++) {
    const { quotes, count } = await fetchPageWithMeta(apiKey, {
      search: '', limit: PC_PAGE_SIZE, startAfter: page * PC_PAGE_SIZE,
    });
    if (count !== null) reportedCount = count;
    all.push(...quotes);
    if (quotes.length < PC_PAGE_SIZE) { exhausted = true; break; }
    if (reportedCount !== null && all.length >= reportedCount) { exhausted = true; break; }
  }

  const uniqueCount = new Set(all.map(q => String(q?._id ?? q?.id ?? ''))).size;
  const complete = exhausted && (reportedCount === null || uniqueCount >= reportedCount);
  return { quotes: all, reportedCount, complete };
};

const fetchAllQuotes = async (apiKey, search = '') => {
  if (search) return fetchPage(apiKey, { search, limit: PC_PAGE_SIZE, startAfter: 0 });
  return (await fetchAllQuotesWithMeta(apiKey)).quotes;
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

// Large HTML/text blobs on every ProspectConnect quote (~3.9 MB of a 4.2 MB
// response for 107 quotes, measured). No POS screen reads them, so they are
// neither stored by the sync nor sent to the browser in `raw`.
const HEAVY_RAW_FIELDS = ['purchase_terms', 'comments_to_buyer', 'signature_content', 'header_content', 'footer_content'];

const stripHeavyFields = (q) => {
  if (!q || typeof q !== 'object') return q;
  const out = { ...q };
  for (const f of HEAVY_RAW_FIELDS) delete out[f];
  return out;
};

/**
 * ProspectConnect `client_approval_status` → approved | rejected | pending.
 * Observed values: 'approved', 'awaiting_response'. Rejection spellings are
 * matched defensively since none exist in the current data.
 */
const APPROVED_VALUES = new Set(['approved', 'accepted', 'signed']);
const REJECTED_VALUES = new Set(['rejected', 'declined', 'denied']);
const normaliseApproval = (raw) => {
  const s = String(raw ?? '').trim().toLowerCase();
  if (APPROVED_VALUES.has(s)) return 'approved';
  if (REJECTED_VALUES.has(s)) return 'rejected';
  return 'pending';
};

const sumNumeric = (arr, key) =>
  Array.isArray(arr) ? arr.reduce((s, x) => s + (Number.isFinite(x?.[key]) ? x[key] : 0), 0) : 0;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * ProspectConnect's price adjustments: `discount`, `fees`, `tax` (plus the
 * per-group `group*` arrays, empty in every quote seen so far). Returned as
 * display rows so a detail view can show how the total was reached.
 */
const adjustmentRows = (q) => {
  const pick = (arr, nameKey, amountKey) => (Array.isArray(arr) ? arr : [])
    .filter(x => x && typeof x === 'object')
    .map(x => ({
      name: String(x[nameKey] ?? '').trim() || 'Unnamed',
      amount: round2(num(x[amountKey])),
      rate: x.tax_input != null && x.currency === '%' ? `${x.tax_input}%` : null,
    }));
  return {
    discounts: [...pick(q.discount, 'discount_name', 'discount_amount'), ...pick(q.groupDiscount, 'discount_name', 'discount_amount')],
    fees:      [...pick(q.fees, 'fees_name', 'fees_amount'),             ...pick(q.groupFees, 'fees_name', 'fees_amount')],
    taxes:     [...pick(q.tax, 'tax_name', 'tax_amount'),                ...pick(q.groupTax, 'tax_name', 'tax_amount')],
  };
};

const joinAddress = (c = {}) =>
  [c.address, c.city, c.state, c.postal_code || c.zip, c.country]
    .map(v => String(v ?? '').trim()).filter(Boolean).join(', ');

const normalise = (q) => {
  const client  = q.client_details ?? {};
  const contact = q.contact_detail ?? {};
  const owner   = q.quote_owner   ?? {};
  const deal    = q.deal          ?? {};
  const ownerCo = q.quote_owner_company ?? {};

  const rawItems = Array.isArray(q.items)     ? q.items
                 : Array.isArray(q.line_items) ? q.line_items
                 : Array.isArray(q.products)   ? q.products
                 : [];

  const status     = q.quote_status ?? q.status ?? 'draft';
  const expiryDate = q.expiration_date ?? q.expiry_date ?? q.expiryDate ?? null;
  const approval   = normaliseApproval(q.client_approval_status);

  const amount = num(q.quote_amount ?? q.amount ?? q.total);
  const { discounts, fees, taxes } = adjustmentRows(q);
  const discountTotal = round2(discounts.reduce((s, x) => s + x.amount, 0));
  const feesTotal     = round2(fees.reduce((s, x) => s + x.amount, 0));
  const taxAmount     = round2(taxes.reduce((s, x) => s + x.amount, 0));

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
    customerId:   client.id ?? contact.id ?? '',
    amount:       q.quote_amount ?? q.amount ?? q.total ?? 0,
    currency:     q.currency ?? 'INR',
    taxTotal:     sumNumeric(q.tax, 'tax_amount'),
    status,
    clientApprovalStatus: q.client_approval_status ?? '',
    // approved | rejected | pending (sent, awaiting the client) | draft (never sent)
    approvalStatus: String(status).toLowerCase() === 'draft' && approval === 'pending' ? 'draft' : approval,
    isExpired:  !!expiryDate && new Date(expiryDate) < new Date(),
    isActive:   q.is_active !== false,
    // ProspectConnect sends created_at/date_created and date_modified — it
    // has no updated_at, so updatedAt was always null before.
    createdAt:  q.created_at ?? q.createdAt ?? q.date_created ?? null,
    updatedAt:  q.updated_at ?? q.updatedAt ?? q.date_modified ?? null,
    expiryDate,
    notes: q.notes ?? '',
    items: rawItems,

    // ── Detail-view fields ────────────────────────────────────────────────
    companyName:     client.company_name ?? '',
    customerAddress: joinAddress(client),
    dealId:          deal.id ?? '',
    ownerCompany:    ownerCo.company_name ?? '',
    ownerCompanyCity: ownerCo.city ?? '',
    ownerTaxIds:     Array.isArray(ownerCo.tax_ids)
      ? ownerCo.tax_ids.map(t => ({ label: t?.label || t?.type || 'Tax ID', value: t?.value || '' })).filter(t => t.value)
      : [],
    isDraft:        q.in_draft_mode === true || String(status).toLowerCase() === 'draft',
    paymentOption:  q.payment_option ?? '',
    // Price build-up: subtotal − discounts + fees + taxes = amount.
    breakdown: {
      subtotal: round2(amount - taxAmount - feesTotal + discountTotal),
      discounts, fees, taxes,
      discountTotal, feesTotal, taxTotal: taxAmount,
      total: round2(amount),
    },
    clientFeedback: (Array.isArray(q.approvals_feedback) ? q.approvals_feedback : [])
      .filter(f => f && f.feedback)
      .map(f => ({ text: String(f.feedback), date: f.feedback_date ?? null, fromClient: f.is_client_feedback === true })),

    raw: stripHeavyFields(q),
  };
};

/** Case-insensitive match of a normalised quote against a free-text search. */
const matchesSearch = (q, term) => {
  const t = String(term ?? '').trim().toLowerCase();
  if (!t) return true;
  return [
    q.quoteNumber, q.quoteId, q.title, q.dealName, q.customerName, q.companyName,
    q.email, q.phone, q.ownerName, q.ownerEmail,
  ].some(v => String(v ?? '').toLowerCase().includes(t));
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
  // An expired offer the client never approved is treated as lost ('failed'),
  // as before. But ProspectConnect expires quotes ~2 days after creation, so
  // this rule used to mark client-APPROVED quotes as failed too (61 of 107 in
  // live data) — an approved quote with no payment yet is still payment-due.
  if (normaliseApproval(q.clientApprovalStatus) === 'approved') return 'pending';
  const exp = q.expiryDate ?? '';
  if (exp && new Date(exp) < new Date()) return 'failed';
  return 'pending';
};

const resolveQuotStage = (q) => {
  // `status` (quote_status) is always set by normalise(), so the old
  // `q.status ?? q.clientApprovalStatus` fallback never consulted the
  // client's decision — a rejected quote showed as "Awaiting Payment".
  if (normaliseApproval(q.clientApprovalStatus) === 'rejected') return 'Cancelled';
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
  // Everything — including a search — reads the locally synced copy
  // (services/crmSync.service.js). A search used to go to the CRM live and
  // returned at most one page, so searched lists were silently truncated.
  // Lazy require: crmSync requires this file.
  const { getSyncedQuotes } = require('./crmSync.service');
  const [raw, rzpMap] = await Promise.all([
    getSyncedQuotes(tenant, apiKey).then(r => r.quotes),
    fetchRazorpayPaymentMap(tenant),
  ]);

  const quotes = raw.map(normalise).filter(q => matchesSearch(q, search));

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
      method: mp.method || '',
    }));
  }
  if (quote._paymentId) {
    return [{
      source: 'Razorpay',
      amount: quote.paidAmount,
      date: quote.paidAt,
      reference: quote._paymentId,
      method: quote.paymentMethod || '',
    }];
  }
  if (quote.paidAmount > 0) {
    return [{
      source: 'Manual',
      amount: quote.paidAmount,
      date: quote.paidAt ?? quote.trackingUpdatedAt,
      reference: quote.bankTransferRef || 'Recorded in Tracking',
      method: quote.paymentMethod || '',
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
const resolvePeriod = ({ month, year, dateFrom, dateTo, period } = {}) => {
  const now = new Date();
  // `period=all` → no date bounds at all (every synced quote). Without it the
  // Super Admin views always defaulted to the current month, so with 108
  // quotes synced only the 11 created this month were ever shown.
  if (String(period ?? '').toLowerCase() === 'all') {
    return { periodStart: null, periodEnd: null };
  }
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
  HEAVY_RAW_FIELDS,
  normaliseMethod,
  normaliseApproval,
  stripHeavyFields,
  dateLabel,
  round2,
  eligiblePayments,
  resolvePeriod,
  fetchPageWithMeta,
  fetchPage,
  fetchAllQuotesWithMeta,
  fetchAllQuotes,
  fetchRazorpayPaymentMap,
  loadTenant,
  normalise,
  matchesSearch,
  autoDetectFromRazorpay,
  mergeTracking,
  resolvePayStatus,
  resolveQuotStage,
  fetchMergedQuotes,
};
