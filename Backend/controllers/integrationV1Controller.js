'use strict';

/**
 * controllers/integrationV1Controller.js
 *
 * Handlers for the POS Integration API v1 (routes/integration.v1.routes.js),
 * consumed by the Haive AI Agent with an API key.
 *
 * Rules every handler follows:
 *   - Read ONLY req.integration.tenant's data (set by middleware/requireApiKey).
 *   - Read the POS database only — never call the CRM or Razorpay from here.
 *   - Return the public v1 shapes below, never internal/CRM documents, so the
 *     contract stays stable while internals change.
 *   - Envelope: { success: true, data, meta? } / { success: false, code, message }.
 */

const CrmQuote = require('../models/crmQuote');
const QuoteTracking = require('../models/quote.tracking');
const { normalise, mergeTracking, round2 } = require('../services/quoteTracking.service');

const API_VERSION = 'v1';

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const iso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/* ── Public v1 shapes ────────────────────────────────────────────────────── */

/** A merged quote (normalise + mergeTracking) → the v1 Quotation resource. */
const toQuotation = (q, stored) => {
  const total = Number(q.amount) || 0;
  const paid = Number(q.paidAmount) || 0;
  const b = q.breakdown ?? {};
  return {
    id: String(q.quoteId),
    number: q.quoteNumber,
    title: q.dealName || q.title || null,
    status: {
      approval: q.approvalStatus,        // approved | pending | rejected | draft
      stage: q.quotationStatus,          // POS pipeline stage
      payment: q.paymentStatus,          // pending | partially_paid | paid | failed | refunded
      crm: q.status ?? null,             // CRM quote status (e.g. published, draft)
    },
    isExpired: !!q.isExpired,
    customer: {
      id: q.customerId || null,
      name: q.customerName || null,
      company: q.companyName || null,
      email: q.email || null,
      phone: q.phone || null,
      address: q.customerAddress || null,
    },
    owner: { name: q.ownerName || null, email: q.ownerEmail || null },
    amounts: {
      currency: q.currency || 'INR',
      subtotal: b.subtotal ?? null,
      discount: b.discountTotal ?? 0,
      fees: b.feesTotal ?? 0,
      tax: b.taxTotal ?? 0,
      total: round2(total),
      paid: round2(paid),
      balanceDue: round2(Math.max(0, total - paid)),
    },
    payment: {
      method: q.paymentMethod || null,
      paidAt: iso(q.paidAt),
    },
    dates: {
      createdAt: iso(q.createdAt),
      updatedAt: iso(q.updatedAt),
      expiresAt: iso(q.expiryDate),
      syncedAt: iso(stored?.lastSyncedAt),
    },
  };
};

/* ── GET /api/v1 — discovery + connection test ───────────────────────────── */

const discovery = (resources) => (req, res) => {
  const { tenant, keyId, scopes } = req.integration;
  res.json({
    success: true,
    data: {
      api: 'POS Integration API',
      version: API_VERSION,
      authenticated: true,
      account: {
        tenantId: tenant.tenantId,
        businessName: tenant.businessName || null,
        currency: tenant.currency || 'INR',
        timezone: tenant.timezone || null,
      },
      apiKey: { keyId, scopes },
      resources: resources.map(r => ({
        name: r.name,
        path: `/api/${API_VERSION}/${r.name}`,
        methods: r.methods,
        scope: r.scope,
        status: r.status,
        description: r.description,
      })),
      serverTime: new Date().toISOString(),
    },
  });
};

/* ── GET /api/v1/quotations ──────────────────────────────────────────────── */

const SORTS = {
  createdAt: { crmCreatedAt: 1 },
  '-createdAt': { crmCreatedAt: -1 },
  amount: { amount: 1 },
  '-amount': { amount: -1 },
  syncedAt: { lastSyncedAt: 1 },
  '-syncedAt': { lastSyncedAt: -1 },
};

const listQuotations = asyncHandler(async (req, res) => {
  const tenantObjId = req.integration.tenant._id;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const sort = SORTS[req.query.sort] ?? SORTS['-createdAt'];

  const filter = { tenantId: tenantObjId, isDeletedInCrm: false };

  if (req.query.createdFrom || req.query.createdTo) {
    filter.crmCreatedAt = {};
    if (req.query.createdFrom) filter.crmCreatedAt.$gte = new Date(req.query.createdFrom);
    if (req.query.createdTo) filter.crmCreatedAt.$lte = new Date(req.query.createdTo);
  }

  // Incremental sync for Haive: quotes whose CRM content changed in the POS
  // copy OR whose POS payment/stage tracking changed since the given time.
  if (req.query.updatedSince) {
    const since = new Date(req.query.updatedSince);
    const touched = await QuoteTracking.find({ tenantId: tenantObjId, updatedAt: { $gte: since } })
      .select('quoteId').lean();
    filter.$or = [
      { lastSyncedAt: { $gte: since } },
      ...(touched.length ? [{ crmQuoteId: { $in: touched.map(t => String(t.quoteId)) } }] : []),
    ];
  }

  if (req.query.number) filter.quoteNumber = String(req.query.number);

  const [docs, total] = await Promise.all([
    CrmQuote.find(filter).sort({ ...sort, _id: 1 }).skip((page - 1) * limit).limit(limit)
      .select('crmQuoteId raw lastSyncedAt').lean(),
    CrmQuote.countDocuments(filter),
  ]);

  const tracking = docs.length
    ? await QuoteTracking.find({ tenantId: tenantObjId, quoteId: { $in: docs.map(d => d.crmQuoteId) } }).lean()
    : [];
  const trackingById = new Map(tracking.map(t => [String(t.quoteId), t]));

  const data = docs.map(d => toQuotation(mergeTracking(normalise(d.raw), trackingById.get(d.crmQuoteId), null), d));

  const pages = Math.max(1, Math.ceil(total / limit));
  res.json({ success: true, data, meta: { page, limit, total, pages, hasMore: page < pages } });
});

/* ── GET /api/v1/quotations/:id  (CRM id or quotation number) ────────────── */

const getQuotation = asyncHandler(async (req, res) => {
  const tenantObjId = req.integration.tenant._id;
  const id = String(req.params.id);
  const doc = await CrmQuote.findOne({
    tenantId: tenantObjId,
    isDeletedInCrm: false,
    $or: [{ crmQuoteId: id }, { quoteNumber: id }],
  }).select('crmQuoteId raw lastSyncedAt').lean();

  // Same 404 whether the quote doesn't exist or belongs to another tenant.
  if (!doc) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: `Quotation "${id}" not found.` });

  const tracking = await QuoteTracking.findOne({ tenantId: tenantObjId, quoteId: doc.crmQuoteId }).lean();
  return res.json({ success: true, data: toQuotation(mergeTracking(normalise(doc.raw), tracking, null), doc) });
});

/* ── Planned resources ───────────────────────────────────────────────────── */

const notYetAvailable = (resource) => (req, res) => res.status(501).json({
  success: false,
  code: 'NOT_IMPLEMENTED',
  message: `The "${resource}" resource is reserved for a future release of the POS Integration API (${API_VERSION}).`,
});

module.exports = {
  API_VERSION,
  discovery,
  listQuotations,
  getQuotation,
  notYetAvailable,
  _internal: { toQuotation },
};
