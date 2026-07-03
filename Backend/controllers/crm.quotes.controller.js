'use strict';

const Tenant        = require('../models/tenant');
const QuoteTracking = require('../models/quote.tracking');
const Razorpay      = require('razorpay');

/* ── Tiny helpers ────────────────────────────────────────────────────────── */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const ok = (res, data = {}, message = 'Success') =>
  res.json({ success: true, message, data });

const fail = (res, message = 'Something went wrong', status = 400) =>
  res.status(status).json({ success: false, message });

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

const loadTenant = async (userId, res) => {
  const tenant = await Tenant.findById(userId).select('+crm.apiKey +razorpay.keyId +razorpay.keySecret');
  if (!tenant)                   { fail(res, 'Tenant not found', 404);                                return null; }
  if (!tenant.crm?.isConfigured) { fail(res, 'CRM is not configured. Connect it in Settings first.'); return null; }
  const apiKey = tenant.getCRMKey?.();
  if (!apiKey)                   { fail(res, 'CRM API key could not be decrypted.', 500);             return null; }
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
  // Auto-detect from Razorpay if tracking is default (no admin override yet)
  const isDefaultTracking = !tracking
    || (tracking.paymentStatus === 'pending' && !tracking.paidAmount && !tracking._adminOverride);

  const autoFields = isDefaultTracking
    ? autoDetectFromRazorpay(quote, rzpPayment)
    : null;

  if (!tracking && !autoFields) return quote;

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

/* ══════════════════════════════════════════════════════════════════════════
   GET /tenant/quotes
   ══════════════════════════════════════════════════════════════════════════ */
exports.getQuotes = asyncHandler(async (req, res) => {
  const loaded = await loadTenant(req.user.id, res);
  if (!loaded) return;

  const { tenant, apiKey } = loaded;
  const search     = String(req.query.search || '').trim();
  const limit      = Math.min(200, parseInt(req.query.limit)      || 25);
  const startAfter = Math.max(0,   parseInt(req.query.startAfter) || 0);

  // Fetch CRM quotes + Razorpay payments in parallel
  const [raw, rzpMap] = await Promise.all([
    search ? fetchPage(apiKey, { search, limit, startAfter }) : fetchAllQuotes(apiKey),
    fetchRazorpayPaymentMap(tenant),
  ]);

  const quotes = raw.map(normalise);

  // Fetch all QuoteTracking records for this tenant in one query
  const trackingRecords = await QuoteTracking.find({ tenantId: tenant._id }).lean();
  const trackingMap     = new Map(trackingRecords.map(t => [String(t.quoteId), t]));

  // Auto-upsert tracking for Razorpay-paid quotes that have no admin override
  const autoUpserts = [];

  const mergedQuotes = quotes.map(q => {
    const tracking   = trackingMap.get(String(q.quoteId));
    const rzpPayment = rzpMap?.byQuotationNo?.get(q.quoteNumber)
                    ?? rzpMap?.byQuotationNo?.get(String(q.quoteId));

    // If Razorpay has a matching captured payment and tracking doesn't reflect it yet,
    // queue an upsert so the DB stays in sync (no webhook needed)
    const isDefaultTracking = !tracking
      || (tracking.paymentStatus === 'pending' && !tracking.paidAmount && !tracking._adminOverride);

    if (rzpPayment && isDefaultTracking) {
      const autoFields = autoDetectFromRazorpay(q, rzpPayment);
      if (autoFields) {
        autoUpserts.push(
          QuoteTracking.findOneAndUpdate(
            { tenantId: tenant._id, quoteId: String(q.quoteId) },
            {
              $set: {
                paymentStatus : autoFields.paymentStatus,
                paidAmount    : autoFields.paidAmount,
                paymentMethod : autoFields.paymentMethod,
                paidAt        : autoFields.paidAt ? new Date(autoFields.paidAt) : null,
                _paymentId    : autoFields._paymentId,
                rzpBank       : autoFields.rzpBank,
                rzpVpa        : autoFields.rzpVpa,
                rzpWallet     : autoFields.rzpWallet,
              },
              $push: {
                timeline: {
                  event: `Auto-synced: Payment ₹${autoFields.paidAmount.toLocaleString('en-IN')} via ${autoFields.paymentMethod} (${autoFields._paymentId})`,
                  date : dateLabel(rzpPayment.created_at),
                  by   : 'System · Auto-sync',
                  type : 'payment',
                },
              },
            },
            { upsert: true, new: true },
          ).catch(() => null),
        );
      }
    }

    return mergeTracking(q, tracking, rzpPayment);
  });

  // Fire-and-forget auto-upserts (don't block the response)
  if (autoUpserts.length) Promise.allSettled(autoUpserts);

  return ok(res, {
    quotes: mergedQuotes,
    total:  mergedQuotes.length,
    limit,
    startAfter,
    search,
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /tenant/quotes/stats
   ══════════════════════════════════════════════════════════════════════════ */
exports.getQuoteStats = asyncHandler(async (req, res) => {
  const loaded = await loadTenant(req.user.id, res);
  if (!loaded) return;

  const { tenant, apiKey } = loaded;

  const [raw, trackingRecords] = await Promise.all([
    fetchAllQuotes(apiKey),
    QuoteTracking.find({ tenantId: tenant._id }).lean(),
  ]);

  const quotes       = raw.map(normalise);
  const trackingMap  = new Map(trackingRecords.map(t => [String(t.quoteId), t]));

  let totalRevenue    = 0;
  let pendingRevenue  = 0;
  let overdueRevenue  = 0;
  let paidCount       = 0;
  let pendingCount    = 0;
  let failedCount     = 0;
  let partialCount    = 0;
  let overdueCount    = 0;

  const now = new Date();

  for (const q of quotes) {
    const t   = trackingMap.get(String(q.quoteId));
    const pay = t?.paymentStatus ?? resolvePayStatus(q);
    const exp = q.expiryDate ?? '';
    const isOverdue = exp && new Date(exp) < now && !['paid', 'partially_paid'].includes(pay);

    if (pay === 'paid') {
      paidCount++;
      totalRevenue += t?.paidAmount ?? q.amount;
    } else if (pay === 'partially_paid') {
      partialCount++;
      totalRevenue    += t?.paidAmount ?? 0;
      pendingRevenue  += q.amount - (t?.paidAmount ?? 0);
    } else if (pay === 'failed') {
      failedCount++;
    } else {
      pendingCount++;
      pendingRevenue += q.amount;
    }

    if (isOverdue) {
      overdueCount++;
      overdueRevenue += q.amount - (t?.paidAmount ?? 0);
    }
  }

  return ok(res, {
    total:          quotes.length,
    totalRevenue,
    pendingRevenue,
    overdueRevenue,
    paidCount,
    pendingCount,
    failedCount,
    partialCount,
    overdueCount,
    conversionRate: quotes.length ? Math.round((paidCount / quotes.length) * 100) : 0,
    avgDealSize:    quotes.length ? Math.round(quotes.reduce((s, q) => s + q.amount, 0) / quotes.length) : 0,
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /tenant/quotes/:quoteId
   ══════════════════════════════════════════════════════════════════════════ */
exports.getQuoteById = asyncHandler(async (req, res) => {
  const loaded = await loadTenant(req.user.id, res);
  if (!loaded) return;

  const { tenant, apiKey } = loaded;
  const { quoteId }        = req.params;

  const [raw, tracking, rzpMap] = await Promise.all([
    fetchPage(apiKey, { search: quoteId, limit: 25, startAfter: 0 }),
    QuoteTracking.findOne({ tenantId: tenant._id, quoteId }).lean(),
    fetchRazorpayPaymentMap(tenant),
  ]);

  const found = raw.find(q =>
    q._id               === quoteId ||
    q.id                === quoteId ||
    String(q.ticket_number) === quoteId,
  );

  if (!found) return fail(res, `Quote "${quoteId}" not found.`, 404);

  const quote      = normalise(found);
  const rzpPayment = rzpMap?.byQuotationNo?.get(quote.quoteNumber)
                  ?? rzpMap?.byQuotationNo?.get(String(quote.quoteId));
  const merged     = mergeTracking(quote, tracking, rzpPayment);

  return ok(res, merged);
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /tenant/quotes/search
   ══════════════════════════════════════════════════════════════════════════ */
exports.searchQuotes = asyncHandler(async (req, res) => {
  const loaded = await loadTenant(req.user.id, res);
  if (!loaded) return;

  const {
    search = '', limit = 25, startAfter = 0,
    status, dateFrom, dateTo,
  } = req.body;

  const raw = await fetchPage(loaded.apiKey, {
    search:     String(search).trim(),
    limit:      Math.min(200, parseInt(limit)      || 25),
    startAfter: Math.max(0,   parseInt(startAfter) || 0),
  });

  let quotes = raw.map(normalise);
  if (status)   quotes = quotes.filter(q => (q.clientApprovalStatus ?? q.status ?? '').toLowerCase() === status.toLowerCase());
  if (dateFrom) quotes = quotes.filter(q => q.createdAt && new Date(q.createdAt) >= new Date(dateFrom));
  if (dateTo)   quotes = quotes.filter(q => q.createdAt && new Date(q.createdAt) <= new Date(dateTo + 'T23:59:59'));

  return ok(res, { quotes, total: quotes.length, startAfter, limit, search });
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /tenant/quotes/sync-razorpay
   On-demand sync: re-fetches all Razorpay captured payments and updates any
   QuoteTracking records that are still 'pending' with no admin override.
   ══════════════════════════════════════════════════════════════════════════ */
exports.syncAllRazorpay = asyncHandler(async (req, res) => {
  const loaded = await loadTenant(req.user.id, res);
  if (!loaded) return;

  const { tenant, apiKey } = loaded;

  const [raw, rzpMap] = await Promise.all([
    fetchAllQuotes(apiKey),
    fetchRazorpayPaymentMap(tenant),
  ]);

  if (!rzpMap) return ok(res, { synced: 0 }, 'Razorpay not configured or unreachable');

  const quotes      = raw.map(normalise);
  const trackingAll = await QuoteTracking.find({ tenantId: tenant._id }).lean();
  const trackingMap = new Map(trackingAll.map(t => [String(t.quoteId), t]));

  let synced = 0;
  const ops  = [];

  for (const q of quotes) {
    const rzpPayment = rzpMap.byQuotationNo.get(q.quoteNumber)
                    ?? rzpMap.byQuotationNo.get(String(q.quoteId));
    if (!rzpPayment) continue;

    const tracking          = trackingMap.get(String(q.quoteId));
    const isDefaultTracking = !tracking
      || (tracking.paymentStatus === 'pending' && !tracking.paidAmount && !tracking._adminOverride);

    if (!isDefaultTracking) continue;

    const autoFields = autoDetectFromRazorpay(q, rzpPayment);
    if (!autoFields) continue;

    synced++;
    ops.push(
      QuoteTracking.findOneAndUpdate(
        { tenantId: tenant._id, quoteId: String(q.quoteId) },
        {
          $set: {
            paymentStatus : autoFields.paymentStatus,
            paidAmount    : autoFields.paidAmount,
            paymentMethod : autoFields.paymentMethod,
            paidAt        : autoFields.paidAt ? new Date(autoFields.paidAt) : null,
            _paymentId    : autoFields._paymentId,
            rzpBank       : autoFields.rzpBank,
            rzpVpa        : autoFields.rzpVpa,
            rzpWallet     : autoFields.rzpWallet,
          },
          $push: {
            timeline: {
              event: `Bulk sync: Payment ₹${autoFields.paidAmount.toLocaleString('en-IN')} via ${autoFields.paymentMethod} (${autoFields._paymentId})`,
              date : dateLabel(rzpPayment.created_at),
              by   : 'System · Bulk Sync',
              type : 'payment',
            },
          },
        },
        { upsert: true, new: true },
      ),
    );
  }

  await Promise.allSettled(ops);
  return ok(res, { synced }, `${synced} payment${synced !== 1 ? 's' : ''} synced from Razorpay`);
});

/* ══════════════════════════════════════════════════════════════════════════
   PATCH /tenant/quotes/:quoteId/track
   Manual update (bank transfer, cash, NEFT, etc.) + admin overrides.
   Setting _adminOverride = true prevents auto-sync from overwriting.
   ══════════════════════════════════════════════════════════════════════════ */
exports.updateTracking = asyncHandler(async (req, res) => {
  const loaded = await loadTenant(req.user.id, res);
  if (!loaded) return;

  const { tenant }  = loaded;
  const { quoteId } = req.params;

  const ALLOWED = [
    'quotationStatus', 'paymentStatus', 'paymentMethod',
    'paidAmount', 'bankTransferRef', 'bankTransferNotes',
    'notes', 'paidAt',
  ];

  const setPayload = {};
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) setPayload[key] = req.body[key];
  }

  // Auto-set paidAt
  if (setPayload.paymentStatus === 'paid' && !setPayload.paidAt) {
    setPayload.paidAt = new Date();
  }
  if (setPayload.paymentStatus && setPayload.paymentStatus !== 'paid' && !req.body.paidAt) {
    setPayload.paidAt = null;
  }

  // Mark as admin override so auto-sync won't overwrite manual changes
  setPayload._adminOverride = true;
  setPayload.updatedBy      = req.user.id;

  // Build timeline entry for status changes
  const pushPayload = {};
  if (req.body.timelineEntry && typeof req.body.timelineEntry === 'object') {
    const entry = req.body.timelineEntry;
    if (entry.event && entry.type) {
      pushPayload.timeline = {
        event: String(entry.event).slice(0, 500),
        date:  entry.date || new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
        by:    entry.by   || 'Admin',
        type:  ['status', 'payment', 'note', 'warning', 'error'].includes(entry.type) ? entry.type : 'note',
      };
    }
  }

  const updateOp = { $set: setPayload };
  if (pushPayload.timeline) updateOp.$push = { timeline: pushPayload.timeline };

  const tracking = await QuoteTracking.findOneAndUpdate(
    { tenantId: tenant._id, quoteId },
    updateOp,
    { new: true, upsert: true, runValidators: true },
  );

  return ok(res, tracking, 'Tracking updated successfully');
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /tenant/quotes/:quoteId/manual-payment
   Dedicated endpoint for recording manual payments (bank transfer, cash, etc.)
   Validates amounts and builds a proper timeline automatically.
   ══════════════════════════════════════════════════════════════════════════ */
exports.recordManualPayment = asyncHandler(async (req, res) => {
  const loaded = await loadTenant(req.user.id, res);
  if (!loaded) return;

  const { tenant, apiKey } = loaded;
  const { quoteId }        = req.params;

  const {
    method,           // 'Bank Transfer' | 'Cash' | 'Cheque' | 'NEFT' | 'RTGS' | 'IMPS'
    amount,           // amount paid now (may be partial)
    referenceNumber,  // UTR / cheque number / receipt number
    paymentDate,      // ISO date string
    notes,
    totalAmount,      // quote total (passed from frontend to avoid re-fetch)
  } = req.body;

  if (!amount || amount <= 0)  return fail(res, 'Amount must be greater than 0');
  if (!method)                 return fail(res, 'Payment method is required');

  // Load existing tracking to calculate running paidAmount
  const existing = await QuoteTracking.findOne({ tenantId: tenant._id, quoteId }).lean();
  const prevPaid = existing?.paidAmount ?? 0;
  const newPaid  = prevPaid + Number(amount);
  const total    = Number(totalAmount ?? 0);

  const paymentStatus = total > 0 && newPaid >= total
    ? 'paid'
    : newPaid > 0
      ? 'partially_paid'
      : 'pending';

  const paidAt  = paymentDate ? new Date(paymentDate) : new Date();
  const dateStr = paidAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const timelineEvent = [
    `Manual payment: ₹${Number(amount).toLocaleString('en-IN')} via ${method}`,
    referenceNumber ? `Ref: ${referenceNumber}` : '',
    notes ? `(${notes})` : '',
  ].filter(Boolean).join(' · ');

  const updateOp = {
    $set: {
      paymentStatus,
      paidAmount    : newPaid,
      paymentMethod : method,
      paidAt        : paymentStatus === 'paid' ? paidAt : (existing?.paidAt ?? null),
      bankTransferRef:   referenceNumber ?? existing?.bankTransferRef   ?? '',
      bankTransferNotes: notes           ?? existing?.bankTransferNotes ?? '',
      _adminOverride: true,
      updatedBy:      req.user.id,
    },
    $push: {
      timeline: {
        event: timelineEvent,
        date:  dateStr,
        by:    'Admin · Manual',
        type:  'payment',
      },
    },
  };

  const tracking = await QuoteTracking.findOneAndUpdate(
    { tenantId: tenant._id, quoteId },
    updateOp,
    { new: true, upsert: true, runValidators: true },
  );

  return ok(res, tracking, 'Manual payment recorded successfully');
});