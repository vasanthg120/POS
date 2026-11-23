'use strict';

const QuoteTracking = require('../models/quote.tracking');
const logger = require('../utils/logger');
const {
  dateLabel,
  fetchPage,
  fetchRazorpayPaymentMap,
  loadTenant: loadTenantRaw,
  normalise,
  matchesSearch,
  autoDetectFromRazorpay,
  mergeTracking,
  eligiblePayments,
  round2,
} = require('../services/quoteTracking.service');
const {
  getSyncedQuotes,
  getSyncStatus: getCrmSyncStatus,
  findSyncedQuote,
  syncTenant,
} = require('../services/crmSync.service');

/* ── Tiny helpers ────────────────────────────────────────────────────────── */

const ok = (res, data = {}, message = 'Success') =>
  res.json({ success: true, message, data });

const fail = (res, message = 'Something went wrong', status = 400) =>
  res.status(status).json({ success: false, message });

// CRM failures carry a specific, safe message (status code + CRM response
// excerpt, never credentials). Send it to the client instead of letting the
// global handler turn it into a generic 500 the dashboard can't explain.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err?.isCrmError && !res.headersSent) {
      logger.warn(`[CRM] ${req.method} ${req.baseUrl}${req.path} → ${err.message}`);
      return fail(res, err.message, err.status && err.status < 500 ? err.status : 502);
    }
    return next(err);
  });

/* ── Tracking input validation ───────────────────────────────────────────── */

const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'partially_paid', 'refunded'];
const QUOTATION_STAGES = ['Created', 'In Progress', 'Processing', 'Awaiting Payment',
  'Payment Completed', 'Delivered', 'Closed', 'Cancelled'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** null if OK. A date-only value chosen as "today" passes in any timezone. */
const paymentDateProblem = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return 'Payment date is not a valid date.';
  if (t > Date.now() + DAY_MS) return 'Payment date cannot be in the future.';
  return null;
};

/** First problem with a PATCH /:quoteId/track body, or null. */
const trackingProblem = (b) => {
  if (b.paymentStatus !== undefined && !PAYMENT_STATUSES.includes(b.paymentStatus)) {
    return 'Choose a valid payment status.';
  }
  if (b.quotationStatus !== undefined && !QUOTATION_STAGES.includes(b.quotationStatus)) {
    return 'Choose a valid quotation stage.';
  }
  if (b.paidAmount !== undefined && b.paidAmount !== null) {
    const n = Number(b.paidAmount);
    if (!Number.isFinite(n) || n < 0) return 'Paid amount must be a number, 0 or more.';
    if (b.paymentStatus === 'partially_paid' && n <= 0) {
      return 'Enter the amount paid so far for a partially paid quotation.';
    }
  }
  const dp = b.paidAt ? paymentDateProblem(b.paidAt) : null;
  if (dp) return dp;
  if (b.paymentMethod && String(b.paymentMethod).length > 50) return 'Payment method must be at most 50 characters.';
  if (b.bankTransferRef && String(b.bankTransferRef).length > 100) return 'Transfer reference must be at most 100 characters.';
  if (b.bankTransferNotes && String(b.bankTransferNotes).length > 500) return 'Transfer notes must be at most 500 characters.';
  if (b.notes && String(b.notes).length > 2000) return 'Notes must be at most 2000 characters.';
  return null;
};

// Adapts the service's { tenant, apiKey } | { error, status } shape onto the
// existing res.json(...)-on-failure calling convention this controller used.
const loadTenant = async (userId, res) => {
  const loaded = await loadTenantRaw(userId);
  if (loaded.error) { fail(res, loaded.error, loaded.status); return null; }
  return loaded;
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

  // Always the full locally synced copy; a search filters it here. Searching
  // used to call the CRM live for a single page (limit 25), so a search or a
  // filtered view never showed more than one page of matches.
  const [{ quotes: raw, sync }, rzpMap] = await Promise.all([
    getSyncedQuotes(tenant, apiKey),
    fetchRazorpayPaymentMap(tenant),
  ]);

  const quotes = raw.map(normalise).filter(q => matchesSearch(q, search));

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
    // queue an upsert so the DB stays in sync (no webhook needed). Not gated on
    // _adminOverride — see the comment on mergeTracking in quoteTracking.service.js.
    const isDefaultTracking = !tracking
      || (tracking.paymentStatus === 'pending' && !tracking.paidAmount);

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
    sync,
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /tenant/quotes/stats
   ══════════════════════════════════════════════════════════════════════════ */
exports.getQuoteStats = asyncHandler(async (req, res) => {
  const loaded = await loadTenant(req.user.id, res);
  if (!loaded) return;

  const { tenant, apiKey } = loaded;

  // Same merged view the quotes list returns (synced CRM data + tracking +
  // Razorpay auto-detect), so the dashboard's numbers always match the
  // Tracking/Quotations pages. This used to merge tracking only, so a
  // Razorpay-paid quote showed as paid in the list but pending in the stats.
  const [{ quotes: raw, sync }, trackingRecords, rzpMap] = await Promise.all([
    getSyncedQuotes(tenant, apiKey),
    QuoteTracking.find({ tenantId: tenant._id }).lean(),
    fetchRazorpayPaymentMap(tenant),
  ]);

  const trackingMap = new Map(trackingRecords.map(t => [String(t.quoteId), t]));
  const quotes = raw.map(normalise).map((q) => {
    const rzpPayment = rzpMap?.byQuotationNo?.get(q.quoteNumber)
                    ?? rzpMap?.byQuotationNo?.get(String(q.quoteId));
    return mergeTracking(q, trackingMap.get(String(q.quoteId)), rzpPayment);
  });

  let totalRevenue    = 0;
  let pendingRevenue  = 0;
  let overdueRevenue  = 0;
  let paidCount       = 0;
  let pendingCount    = 0;
  let failedCount     = 0;
  let partialCount    = 0;
  let overdueCount    = 0;
  let monthRevenue    = 0;
  let todayRevenue    = 0;
  const approval = { approved: 0, rejected: 0, pending: 0, draft: 0 };
  let expiredCount = 0;
  const customers = new Set();

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const dayStart   = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (const q of quotes) {
    const pay  = q.paymentStatus;
    const paid = q.paidAmount ?? 0;
    const isOverdue = q.isExpired && !['paid', 'partially_paid'].includes(pay);

    if (pay === 'paid') {
      paidCount++;
      totalRevenue += paid || q.amount;
    } else if (pay === 'partially_paid') {
      partialCount++;
      totalRevenue   += paid;
      pendingRevenue += q.amount - paid;
    } else if (pay === 'failed') {
      failedCount++;
    } else {
      pendingCount++;
      pendingRevenue += q.amount;
    }

    if (isOverdue) {
      overdueCount++;
      overdueRevenue += q.amount - paid;
    }

    // Period revenue by each payment's own date — the rule Royalty and the
    // Super Admin dashboard already use.
    if (pay === 'paid' || pay === 'partially_paid') {
      for (const p of eligiblePayments(q)) {
        const d = p.date ? new Date(p.date) : null;
        if (!d || !(p.amount > 0)) continue;
        if (d >= monthStart) monthRevenue += p.amount;
        if (d >= dayStart)   todayRevenue += p.amount;
      }
    }

    approval[q.approvalStatus] = (approval[q.approvalStatus] ?? 0) + 1;
    if (q.isExpired) expiredCount++;
    const customerKey = q.customerId || q.email;
    if (customerKey) customers.add(customerKey);
  }

  return ok(res, {
    total:          quotes.length,
    totalRevenue:   round2(totalRevenue),
    pendingRevenue: round2(pendingRevenue),
    overdueRevenue: round2(overdueRevenue),
    paidCount,
    pendingCount,
    failedCount,
    partialCount,
    overdueCount,
    conversionRate: quotes.length ? Math.round((paidCount / quotes.length) * 100) : 0,
    avgDealSize:    quotes.length ? Math.round(quotes.reduce((s, q) => s + q.amount, 0) / quotes.length) : 0,
    // Added fields (existing consumers ignore them)
    monthRevenue:   round2(monthRevenue),
    todayRevenue:   round2(todayRevenue),
    convertedCount: paidCount + partialCount,
    approvedCount:  approval.approved,
    rejectedCount:  approval.rejected,
    awaitingApprovalCount: approval.pending,
    draftCount:     approval.draft,
    expiredCount,
    customerCount:  customers.size,
    pipelineValue:  round2(quotes.reduce((s, q) => s + (q.amount || 0), 0)),
    sync,
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

  // Synced copy first (works even when the CRM is slow or down); fall back to
  // the CRM's live search for a quote created since the last sync.
  const findLive = async () => {
    const raw = await fetchPage(apiKey, { search: quoteId, limit: 25, startAfter: 0 });
    return raw.find(q =>
      q._id               === quoteId ||
      q.id                === quoteId ||
      String(q.ticket_number) === quoteId,
    ) ?? null;
  };

  const [stored, tracking, rzpMap] = await Promise.all([
    findSyncedQuote(tenant._id, quoteId),
    QuoteTracking.findOne({ tenantId: tenant._id, quoteId }).lean(),
    fetchRazorpayPaymentMap(tenant),
  ]);
  const found = stored ?? await findLive();

  if (!found) return fail(res, `Quote "${quoteId}" not found.`, 404);

  const quote      = normalise(found);
  const rzpPayment = rzpMap?.byQuotationNo?.get(quote.quoteNumber)
                  ?? rzpMap?.byQuotationNo?.get(String(quote.quoteId));
  const merged     = mergeTracking(quote, tracking, rzpPayment);

  return ok(res, {
    ...merged,
    balanceDue: round2(Math.max(0, (merged.amount ?? 0) - (merged.paidAmount ?? 0))),
    payments: eligiblePayments(merged),
  });
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

  // Filters run over every synced quote (merged with tracking), not over one
  // live CRM page of `limit` quotes as before — that returned a handful of
  // matches out of the first 25 and hid the rest.
  const { tenant, apiKey } = loaded;
  const [{ quotes: raw }, trackingRecords, rzpMap] = await Promise.all([
    getSyncedQuotes(tenant, apiKey),
    QuoteTracking.find({ tenantId: tenant._id }).lean(),
    fetchRazorpayPaymentMap(tenant),
  ]);
  const trackingMap = new Map(trackingRecords.map(t => [String(t.quoteId), t]));

  const wanted = String(status ?? '').trim().toLowerCase();
  const snake  = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  let quotes = raw.map(normalise)
    .filter(q => matchesSearch(q, search))
    .map((q) => {
      const rzpPayment = rzpMap?.byQuotationNo?.get(q.quoteNumber)
                      ?? rzpMap?.byQuotationNo?.get(String(q.quoteId));
      return mergeTracking(q, trackingMap.get(String(q.quoteId)), rzpPayment);
    });

  if (wanted) {
    quotes = quotes.filter(q => [
      q.approvalStatus, q.clientApprovalStatus, q.status, q.paymentStatus, snake(q.quotationStatus),
      q.isExpired ? 'expired' : '',
    ].some(v => snake(v) === snake(wanted)));
  }
  if (dateFrom) quotes = quotes.filter(q => q.createdAt && new Date(q.createdAt) >= new Date(dateFrom));
  if (dateTo)   quotes = quotes.filter(q => q.createdAt && new Date(q.createdAt) <= new Date(dateTo + 'T23:59:59'));

  return ok(res, {
    quotes, total: quotes.length,
    startAfter: Math.max(0, parseInt(startAfter) || 0),
    limit: Math.min(200, parseInt(limit) || 25),
    search,
  });
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

  const [{ quotes: raw }, rzpMap] = await Promise.all([
    getSyncedQuotes(tenant, apiKey),
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
      || (tracking.paymentStatus === 'pending' && !tracking.paidAmount);

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
   POST /tenant/quotes/sync
   "Sync now": pulls every quote from the CRM into the POS database right
   away and returns what the run did.
   ══════════════════════════════════════════════════════════════════════════ */
exports.syncNow = asyncHandler(async (req, res) => {
  const loaded = await loadTenant(req.user.id, res);
  if (!loaded) return;

  const { tenant, apiKey } = loaded;
  const result = await syncTenant(tenant, { trigger: 'manual', apiKey });
  const status = await getCrmSyncStatus(tenant._id);

  if (result.status === 'skipped') {
    return res.status(409).json({ success: false, message: result.reason, data: { result, status } });
  }
  if (result.status === 'error') {
    return res.status(502).json({ success: false, message: `CRM sync failed: ${result.error}`, data: { result, status } });
  }

  const s = result.stats;
  const message = `Synced ${s.fetched} quote${s.fetched === 1 ? '' : 's'} from CRM`
    + ` (${s.inserted} new, ${s.updated + s.restored} updated, ${s.unchanged} unchanged`
    + `${s.markedDeleted ? `, ${s.markedDeleted} removed` : ''}${s.failed ? `, ${s.failed} failed` : ''}).`;
  return ok(res, { result, status }, message);
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /tenant/quotes/sync-status
   ══════════════════════════════════════════════════════════════════════════ */
exports.getSyncStatus = asyncHandler(async (req, res) => {
  const loaded = await loadTenant(req.user.id, res);
  if (!loaded) return;
  return ok(res, await getCrmSyncStatus(loaded.tenant._id, { includeRuns: true }));
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

  // Bad values used to reach Mongoose (runValidators) and come back as a
  // generic 500 "Something went wrong."; check them here with real messages.
  const problem = trackingProblem(req.body);
  if (problem) return fail(res, problem, 422);

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

  const { tenant } = loaded;
  const { quoteId } = req.params;

  const {
    method,           // 'Bank Transfer' | 'Cash' | 'Cheque' | 'NEFT' | 'RTGS' | 'IMPS'
    amount,           // amount paid now (may be partial)
    referenceNumber,  // UTR / cheque number / receipt number
    paymentDate,      // ISO date string
    notes,
    totalAmount,      // quote total (passed from frontend to avoid re-fetch)
  } = req.body;

  // `!amount || amount <= 0` let non-numeric input ("abc") through as NaN.
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return fail(res, 'Enter a payment amount greater than 0.', 422);
  if (typeof method !== 'string' || !method.trim()) return fail(res, 'Select a payment method.', 422);
  if (method.length > 50) return fail(res, 'Payment method must be at most 50 characters.', 422);
  if (referenceNumber && String(referenceNumber).length > 100) return fail(res, 'Reference number must be at most 100 characters.', 422);
  if (notes && String(notes).length > 500) return fail(res, 'Notes must be at most 500 characters.', 422);
  const dateProblem = paymentDateProblem(paymentDate);
  if (dateProblem) return fail(res, dateProblem, 422);

  // Load existing tracking to calculate running paidAmount
  const [existing, storedQuote] = await Promise.all([
    QuoteTracking.findOne({ tenantId: tenant._id, quoteId }).lean(),
    findSyncedQuote(tenant._id, quoteId),
  ]);
  const prevPaid = existing?.paidAmount ?? 0;
  const newPaid  = round2(prevPaid + amt);
  // Prefer the quote total from the synced CRM copy over the one the browser sends.
  const total    = Number(storedQuote?.quote_amount ?? totalAmount ?? 0) || 0;

  if (total > 0 && newPaid > total + 0.01) {
    const due = Math.max(0, round2(total - prevPaid));
    return fail(res, `Amount exceeds the balance due (₹${due.toLocaleString('en-IN')}).`, 422);
  }

  const paymentStatus = total > 0 && newPaid >= total
    ? 'paid'
    : newPaid > 0
      ? 'partially_paid'
      : 'pending';

  const paidAt  = paymentDate ? new Date(paymentDate) : new Date();
  const dateStr = paidAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const timelineEvent = [
    `Manual payment: ₹${amt.toLocaleString('en-IN')} via ${method}`,
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
      // Itemized record of this installment — lets anything downstream (e.g.
      // the Royalty report) see each manual payment individually rather than
      // only the running total. Purely additive: existing fields/behavior
      // above are unchanged.
      manualPayments: {
        amount: amt,
        method,
        referenceNumber: referenceNumber ?? '',
        paymentDate: paidAt,
        notes: notes ?? '',
        recordedBy: req.user.id,
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
