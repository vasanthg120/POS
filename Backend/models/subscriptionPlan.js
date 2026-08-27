'use strict';

const mongoose = require('mongoose');

/**
 * Subscription plan catalog — managed exclusively by the superadmin.
 * Assigning a plan to a tenant COPIES its price/GST into that tenant's
 * TenantSubscription at assignment time (see billing.service.js changePlan);
 * editing a plan afterward never retroactively changes already-assigned
 * tenants, only future assignments. Plans are soft-deactivated (isActive),
 * never deleted, so historical invoices keep a meaningful planName snapshot.
 */
const subscriptionPlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, default: '', maxlength: 300 },
    monthlyPrice: { type: Number, required: true, min: 0 },
    gstPercent: { type: Number, default: 18, min: 0, max: 100 },
    trialDays: { type: Number, default: 0, min: 0 },
    // Default grace period for tenants on this plan — copied into the
    // tenant's own subscription on assignment (like price/GST), then still
    // independently overridable per tenant. Null = use the platform default.
    gracePeriodDays: { type: Number, default: null, min: 0 },
    features: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
