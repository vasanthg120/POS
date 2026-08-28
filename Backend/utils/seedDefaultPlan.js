'use strict';

const SubscriptionPlan = require('../models/subscriptionPlan');
const logger = require('./logger');

/**
 * Seeds the platform's default "Basic" subscription plan on first startup —
 * plans are meant to be entirely database-driven (see subscriptionPlanController.js),
 * so this exists only to guarantee a sane out-of-the-box plan exists rather
 * than hardcoding ₹4,000 anywhere else in the app. No-op once any plan exists.
 */
const seedDefaultPlan = async () => {
  const count = await SubscriptionPlan.countDocuments();
  if (count > 0) return;

  await SubscriptionPlan.create({
    name: 'Basic',
    slug: 'basic',
    description: 'Standard plan for new tenants.',
    monthlyPrice: 4000,
    gstPercent: 18,
    trialDays: 0,
    gracePeriodDays: null,
    features: [],
    isActive: true,
  });

  logger.info('[SeedDefaultPlan] Created default "Basic" plan (₹4,000/month).');
};

module.exports = seedDefaultPlan;
