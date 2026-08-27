'use strict';

const SubscriptionPlan = require('../models/subscriptionPlan');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    next(err);
  });

const ok = (res, data = {}, message = 'Success') => res.json({ success: true, message, data });

const httpError = (message, status = 400) => { const e = new Error(message); e.status = status; return e; };

const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// ── GET /api/admin/billing/plans ──────────────────────────────────────────────
exports.listPlans = asyncHandler(async (req, res) => {
  const filter = req.query.includeInactive === 'true' ? {} : { isActive: true };
  const plans = await SubscriptionPlan.find(filter).sort({ monthlyPrice: 1 });
  return ok(res, plans);
});

// ── POST /api/admin/billing/plans ─────────────────────────────────────────────
exports.createPlan = asyncHandler(async (req, res) => {
  const { name, description, monthlyPrice, gstPercent, trialDays, gracePeriodDays, features } = req.body;
  const slug = slugify(name);

  const existing = await SubscriptionPlan.findOne({ slug });
  if (existing) throw httpError('A plan with this name already exists.', 409);

  const plan = await SubscriptionPlan.create({
    name, slug, description, monthlyPrice,
    gstPercent: gstPercent ?? 18, trialDays: trialDays ?? 0,
    gracePeriodDays: gracePeriodDays === '' || gracePeriodDays === undefined ? null : Number(gracePeriodDays),
    features: Array.isArray(features) ? features.filter(Boolean) : [],
  });
  return ok(res, plan, 'Plan created.');
});

// ── PATCH /api/admin/billing/plans/:planId ────────────────────────────────────
exports.updatePlan = asyncHandler(async (req, res) => {
  const plan = await SubscriptionPlan.findById(req.params.planId);
  if (!plan) throw httpError('Plan not found.', 404);

  const { name, description, monthlyPrice, gstPercent, trialDays, gracePeriodDays, features } = req.body;
  if (name !== undefined) { plan.name = name; plan.slug = slugify(name); }
  if (description !== undefined) plan.description = description;
  if (monthlyPrice !== undefined) plan.monthlyPrice = monthlyPrice;
  if (gstPercent !== undefined) plan.gstPercent = gstPercent;
  if (trialDays !== undefined) plan.trialDays = trialDays;
  if (gracePeriodDays !== undefined) plan.gracePeriodDays = gracePeriodDays === null || gracePeriodDays === '' ? null : Number(gracePeriodDays);
  if (features !== undefined) plan.features = Array.isArray(features) ? features.filter(Boolean) : [];

  await plan.save();
  return ok(res, plan, 'Plan updated.');
});

// ── PATCH /api/admin/billing/plans/:planId/status ─────────────────────────────
exports.setPlanStatus = asyncHandler(async (req, res) => {
  const plan = await SubscriptionPlan.findById(req.params.planId);
  if (!plan) throw httpError('Plan not found.', 404);
  plan.isActive = !!req.body.isActive;
  await plan.save();
  return ok(res, plan, `Plan ${plan.isActive ? 'activated' : 'deactivated'}.`);
});
