'use strict';

/**
 * controllers/marginController.js — Margin calculator jobs.
 *
 * Every write recomputes the job's summary on the server with the same engine
 * the browser uses (services/marginCalc.service.js); a summary sent by the
 * client is ignored. Stored totals and the stats built from them therefore
 * always match the rows.
 *
 * Jobs belong to the caller's tenant (team members share their tenant's jobs).
 */

const MarginJob = require('../models/margin');
const { calculate, num, MAX_ROWS, ROUNDING_STEPS } = require('../services/marginCalc.service');
const { escapeRegex } = require('../utils/validation');

const STATUSES = ['draft', 'finalised', 'archived'];

const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });

const ctx = (req) => {
  const user     = req.user || {};
  const userId   = user.id || user._id || user.sub;
  const tenantId = user.tenantId || userId;
  return { tenantId, userId };
};

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  if (err?.name === 'CastError') return fail(res, 404, 'NOT_FOUND', 'Job not found.');
  if (err?.name === 'ValidationError') return fail(res, 422, 'VALIDATION_ERROR', err.message);
  return next(err);
});

const text = (v, max) => String(v ?? '').trim().slice(0, max);
const clampPct = (v, max) => Math.min(num(v), max);

/**
 * Turns a request body into clean job fields (only the ones present, unless
 * `full`). Numbers are made finite and non-negative; text is trimmed and
 * capped. Returns { fields } or { error }.
 */
const cleanJobInput = (body = {}, { full = false } = {}) => {
  const f = {};
  const has = (k) => full || body[k] !== undefined;

  if (has('jobName')) f.jobName = text(body.jobName, 120);
  if (has('notes')) f.notes = text(body.notes, 2000);
  if (has('tags')) f.tags = (Array.isArray(body.tags) ? body.tags : []).slice(0, 20).map(t => text(t, 40)).filter(Boolean);

  if (has('setupCount')) f.setupCount = body.setupCount === undefined ? 1 : num(body.setupCount);
  if (has('setupUnit')) f.setupUnit = num(body.setupUnit);
  if (has('shipping')) f.shipping = num(body.shipping);
  if (has('gstRate')) f.gstRate = body.gstRate === undefined ? 18 : clampPct(body.gstRate, 100);
  if (has('discountPct')) f.discountPct = clampPct(body.discountPct, 100);
  if (has('otherCost')) f.otherCost = num(body.otherCost);
  if (has('paymentFeePct')) f.paymentFeePct = clampPct(body.paymentFeePct, 20);
  if (has('targetPct')) f.targetPct = body.targetPct === undefined ? 50 : clampPct(body.targetPct, 1000);
  if (has('priceRounding')) {
    const r = Number(body.priceRounding);
    f.priceRounding = ROUNDING_STEPS.includes(r) ? r : 1;
  }

  if (has('rows')) {
    const rows = body.rows ?? [];
    if (!Array.isArray(rows)) return { error: 'rows must be a list of line items.' };
    if (rows.length > MAX_ROWS) return { error: `A job can have at most ${MAX_ROWS} line items.` };
    f.rows = rows.map(r => ({
      item: text(r?.item, 200),
      qty: num(r?.qty),
      unitCost: num(r?.unitCost),
      decoUnit: num(r?.decoUnit),
      setup: num(r?.setup),
      ship: num(r?.ship),
      quoteUnit: num(r?.quoteUnit),
    }));
  }

  if (has('status')) {
    if (body.status !== undefined && !STATUSES.includes(body.status)) return { error: 'Invalid status.' };
    f.status = body.status ?? 'draft';
  }
  return { fields: f };
};

/** The fields the engine reads, from a stored job merged with an update. */
const engineInput = (job) => ({
  rows: job.rows,
  setupCount: job.setupCount, setupUnit: job.setupUnit, shipping: job.shipping,
  gstRate: job.gstRate, discountPct: job.discountPct, otherCost: job.otherCost,
  paymentFeePct: job.paymentFeePct, targetPct: job.targetPct,
  priceRounding: job.priceRounding,
});

/* ─────────────────────────────────────────────
   POST /tenant/margin-jobs
───────────────────────────────────────────── */
exports.createJob = asyncHandler(async (req, res) => {
  const { tenantId, userId } = ctx(req);
  if (!tenantId) return fail(res, 400, 'NO_TENANT', 'Tenant context missing.');

  const { fields, error } = cleanJobInput(req.body, { full: true });
  if (error) return fail(res, 422, 'VALIDATION_ERROR', error);

  const job = await MarginJob.create({
    ...fields,
    tenantId,
    createdBy: userId,
    summary: calculate(fields).summary,
  });
  res.status(201).json({ success: true, data: job });
});

/* ─────────────────────────────────────────────
   GET /tenant/margin-jobs
   ?page=1&limit=20&status=draft&q=vmart
   Archived jobs are left out unless status=archived (or status=all) is asked for.
───────────────────────────────────────────── */
exports.listJobs = asyncHandler(async (req, res) => {
  const { tenantId } = ctx(req);
  if (!tenantId) return fail(res, 400, 'NO_TENANT', 'Tenant context missing.');

  const page  = Math.max(parseInt(req.query.page  || '1',  10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10) || 20, 1), 100);
  const skip  = (page - 1) * limit;

  const filter = { tenantId };
  const status = String(req.query.status || '');
  if (STATUSES.includes(status)) filter.status = status;
  else if (status !== 'all') filter.status = { $ne: 'archived' };

  // Substring match (the old $text search only matched whole words, so
  // "vm" never found "V-Mart").
  const q = text(req.query.q, 60);
  if (q) filter.jobName = { $regex: escapeRegex(q), $options: 'i' };

  const [jobs, total] = await Promise.all([
    MarginJob.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).select('-rows').lean(),
    MarginJob.countDocuments(filter),
  ]);

  res.json({ success: true, data: jobs, meta: { page, limit, total, pages: Math.ceil(total / limit) } });
});

/* ─────────────────────────────────────────────
   GET /tenant/margin-jobs/:id
───────────────────────────────────────────── */
exports.getJob = asyncHandler(async (req, res) => {
  const { tenantId } = ctx(req);
  const job = await MarginJob.findOne({ _id: req.params.id, tenantId }).lean();
  if (!job) return fail(res, 404, 'NOT_FOUND', 'Job not found.');
  res.json({ success: true, data: job });
});

/* ─────────────────────────────────────────────
   PUT /tenant/margin-jobs/:id   (manual save + autosave)
───────────────────────────────────────────── */
exports.updateJob = asyncHandler(async (req, res) => {
  const { tenantId } = ctx(req);
  const { fields, error } = cleanJobInput(req.body);
  if (error) return fail(res, 422, 'VALIDATION_ERROR', error);

  const job = await MarginJob.findOne({ _id: req.params.id, tenantId });
  if (!job) return fail(res, 404, 'NOT_FOUND', 'Job not found.');

  job.set(fields);
  job.summary = calculate(engineInput(job)).summary;
  await job.save();
  res.json({ success: true, data: job });
});

/* ─────────────────────────────────────────────
   PATCH /tenant/margin-jobs/:id/status
───────────────────────────────────────────── */
exports.updateStatus = asyncHandler(async (req, res) => {
  const { tenantId } = ctx(req);
  const { status } = req.body;
  if (!STATUSES.includes(status)) return fail(res, 422, 'VALIDATION_ERROR', 'Invalid status.');

  const job = await MarginJob.findOneAndUpdate(
    { _id: req.params.id, tenantId },
    { $set: { status } },
    { new: true },
  );
  if (!job) return fail(res, 404, 'NOT_FOUND', 'Job not found.');
  res.json({ success: true, data: job });
});

/* ─────────────────────────────────────────────
   DELETE /tenant/margin-jobs/:id   (soft delete)
───────────────────────────────────────────── */
exports.deleteJob = asyncHandler(async (req, res) => {
  const { tenantId } = ctx(req);
  const job = await MarginJob.findOneAndUpdate(
    { _id: req.params.id, tenantId },
    { $set: { deletedAt: new Date() } },
    { new: true },
  );
  if (!job) return fail(res, 404, 'NOT_FOUND', 'Job not found.');
  res.json({ success: true, message: 'Job deleted.' });
});

/* ─────────────────────────────────────────────
   POST /tenant/margin-jobs/:id/duplicate
───────────────────────────────────────────── */
exports.duplicateJob = asyncHandler(async (req, res) => {
  const { tenantId, userId } = ctx(req);
  const src = await MarginJob.findOne({ _id: req.params.id, tenantId }).lean();
  if (!src) return fail(res, 404, 'NOT_FOUND', 'Job not found.');

  const { _id, createdAt, updatedAt, __v, ...rest } = src;
  const copy = await MarginJob.create({
    ...rest,
    tenantId,
    createdBy: userId,
    jobName  : `${src.jobName || 'Job'} (Copy)`.slice(0, 120),
    status   : 'draft',
    summary  : calculate(engineInput(src)).summary,
  });
  res.status(201).json({ success: true, data: copy });
});

/* ─────────────────────────────────────────────
   GET /tenant/margin-jobs/stats/summary
   Active (non-archived) jobs. Revenue = taxable value (ex GST, including
   billed setup/shipping); margin is margin on cost across all of them:
   Σ profit ÷ Σ cost.
   (It used to average the jobs' percentages — a ₹100 job counted as much as a
   ₹1,00,000 one — over line revenue only, archived jobs included.)
───────────────────────────────────────────── */
exports.getStats = asyncHandler(async (req, res) => {
  const { tenantId } = ctx(req);
  const [stats] = await MarginJob.aggregate([
    { $match: { tenantId, deletedAt: null } },
    { $group: {
      _id: null,
      allJobs       : { $sum: 1 },
      totalJobs     : { $sum: { $cond: [{ $ne: ['$status', 'archived'] }, 1, 0] } },
      totalRevenue  : { $sum: { $cond: [{ $ne: ['$status', 'archived'] }, '$summary.grandTotal', 0] } },
      totalProfit   : { $sum: { $cond: [{ $ne: ['$status', 'archived'] }, '$summary.profitSubtotal', 0] } },
      draftCount    : { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
      finalisedCount: { $sum: { $cond: [{ $eq: ['$status', 'finalised'] }, 1, 0] } },
      archivedCount : { $sum: { $cond: [{ $eq: ['$status', 'archived'] }, 1, 0] } },
    } },
  ]);

  const s = stats || { totalJobs: 0, totalRevenue: 0, totalProfit: 0, draftCount: 0, finalisedCount: 0, archivedCount: 0 };
  const round2 = (n) => Math.round((n || 0) * 100) / 100;
  res.json({
    success: true,
    data: {
      totalJobs: s.totalJobs,
      totalRevenue: round2(s.totalRevenue),
      totalProfit: round2(s.totalProfit),
      // Margin on cost across the jobs: Σ profit ÷ Σ cost (cost = revenue − profit).
      avgMarginPct: s.totalRevenue - s.totalProfit > 0
        ? Math.round((s.totalProfit / (s.totalRevenue - s.totalProfit)) * 10000) / 10000 : 0,
      draftCount: s.draftCount,
      finalisedCount: s.finalisedCount,
      archivedCount: s.archivedCount,
    },
  });
});

module.exports._internal = { cleanJobInput };
