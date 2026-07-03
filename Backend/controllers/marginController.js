'use strict';
const MarginJob = require('../models/margin');

const err = (msg, status = 400) => Object.assign(new Error(msg), { statusCode: status });
const ctx = (req) => {
  const user     = req.user || {};
  const userId   = user.id || user._id || user.sub;
  const tenantId = user.tenantId || userId;
  return { tenantId, userId };
};

exports.createJob = async (req, res, next) => {
  try {
    const { tenantId, userId } = ctx(req);
    if (!tenantId) return next(err('Tenant context missing', 400));

    const {
      jobName, setupCount, setupUnit, shipping, gstRate,
      rows, summary, status, tags, notes,
    } = req.body;

    const job = await MarginJob.create({
      tenantId,
      createdBy  : userId,
      jobName    : jobName  || '',
      setupCount : setupCount ?? 1,
      setupUnit  : setupUnit  ?? 0,
      shipping   : shipping   ?? 0,
      gstRate    : gstRate    ?? 18,
      rows       : rows       || [],
      summary    : summary    || {},
      status     : status     || 'draft',
      tags       : tags       || [],
      notes      : notes      || '',
    });

    res.status(201).json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   GET /tenant/margin-jobs
   List all jobs for the tenant (paginated)
   Query: ?page=1&limit=20&status=draft&q=vmart
───────────────────────────────────────────── */
exports.listJobs = async (req, res, next) => {
  try {
    const { tenantId } = ctx(req);
    if (!tenantId) return next(err('Tenant context missing', 400));

    const page   = Math.max(parseInt(req.query.page  || '1',  10), 1);
    const limit  = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const skip   = (page - 1) * limit;

    const filter = { tenantId };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.q)      filter.$text  = { $search: req.query.q };

    const [jobs, total] = await Promise.all([
      MarginJob.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-rows')          // list view: skip heavy rows array
        .lean(),
      MarginJob.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data   : jobs,
      meta   : { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   GET /tenant/margin-jobs/:id
   Fetch single job with all rows
───────────────────────────────────────────── */
exports.getJob = async (req, res, next) => {
  try {
    const { tenantId } = ctx(req);
    const job = await MarginJob.findOne({ _id: req.params.id, tenantId }).lean();
    if (!job) return next(err('Job not found', 404));
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   PUT /tenant/margin-jobs/:id
   Full update (autosave / manual save)
───────────────────────────────────────────── */
exports.updateJob = async (req, res, next) => {
  try {
    const { tenantId } = ctx(req);

    const allowed = [
      'jobName', 'setupCount', 'setupUnit', 'shipping',
      'gstRate', 'rows', 'summary', 'status', 'tags', 'notes',
    ];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    const job = await MarginJob.findOneAndUpdate(
      { _id: req.params.id, tenantId },
      { $set: update },
      { new: true, runValidators: true },
    );
    if (!job) return next(err('Job not found', 404));

    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   PATCH /tenant/margin-jobs/:id/status
   Quick status transition
───────────────────────────────────────────── */
exports.updateStatus = async (req, res, next) => {
  try {
    const { tenantId } = ctx(req);
    const { status } = req.body;
    const allowed = ['draft', 'finalised', 'archived'];
    if (!allowed.includes(status)) return next(err('Invalid status', 400));

    const job = await MarginJob.findOneAndUpdate(
      { _id: req.params.id, tenantId },
      { $set: { status } },
      { new: true },
    );
    if (!job) return next(err('Job not found', 404));
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   DELETE /tenant/margin-jobs/:id
   Soft delete
───────────────────────────────────────────── */
exports.deleteJob = async (req, res, next) => {
  try {
    const { tenantId } = ctx(req);
    const job = await MarginJob.findOneAndUpdate(
      { _id: req.params.id, tenantId },
      { $set: { deletedAt: new Date() } },
      { new: true },
    );
    if (!job) return next(err('Job not found', 404));
    res.json({ success: true, message: 'Job archived successfully' });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /tenant/margin-jobs/:id/duplicate
   Clone a job under a new name
───────────────────────────────────────────── */
exports.duplicateJob = async (req, res, next) => {
  try {
    const { tenantId, userId } = ctx(req);
    const src = await MarginJob.findOne({ _id: req.params.id, tenantId }).lean();
    if (!src) return next(err('Job not found', 404));

    const { _id, createdAt, updatedAt, ...rest } = src;
    const copy = await MarginJob.create({
      ...rest,
      tenantId,
      createdBy : userId,
      jobName   : `${src.jobName || 'Job'} (Copy)`,
      status    : 'draft',
    });
    res.status(201).json({ success: true, data: copy });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   GET /tenant/margin-jobs/stats/summary
   Aggregate stats for dashboard widgets
───────────────────────────────────────────── */
exports.getStats = async (req, res, next) => {
  try {
    const { tenantId } = ctx(req);
    const stats = await MarginJob.aggregate([
      { $match: { tenantId, deletedAt: null } },  // Mixed type — no ObjectId cast needed
      { $group: {
        _id           : null,
        totalJobs     : { $sum: 1 },
        totalRevenue  : { $sum: '$summary.totalQuote' },
        totalProfit   : { $sum: '$summary.profitSubtotal' },
        avgMarginPct  : { $avg: '$summary.overallMarginPct' },
        draftCount    : { $sum: { $cond: [{ $eq: ['$status', 'draft']     }, 1, 0] } },
        finalisedCount: { $sum: { $cond: [{ $eq: ['$status', 'finalised'] }, 1, 0] } },
      }},
      { $project: { _id: 0, totalJobs: 1, totalRevenue: 1, totalProfit: 1, avgMarginPct: 1, draftCount: 1, finalisedCount: 1 } },
    ]);

    res.json({ success: true, data: stats[0] || {
      totalJobs: 0, totalRevenue: 0, totalProfit: 0,
      avgMarginPct: 0, draftCount: 0, finalisedCount: 0,
    }});
  } catch (err) {
    next(err);
  }
};