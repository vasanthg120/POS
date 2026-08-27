'use strict';

const mongoose = require('mongoose');

/**
 * One royalty-rate history entry. Percentages are never overwritten in
 * place — a change appends a new entry with its own `effectiveFrom`, so a
 * report for a past period can still resolve the rate that was actually in
 * force on that date even after the rate has since changed.
 */
const historyEntrySchema = new mongoose.Schema(
  {
    percentage: { type: Number, required: true, min: 0, max: 100 },
    effectiveFrom: { type: Date, required: true, default: Date.now },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    changedByName: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, _id: true },
);

/**
 * Forward-looking extension point: lets a specific quotation carry its own
 * royalty rate instead of the tenant-wide one. Not exposed in the UI yet —
 * `getEffectivePercentage` already checks it so no schema migration is
 * needed if/when this becomes a real feature.
 */
const overrideEntrySchema = new mongoose.Schema(
  {
    quoteId: { type: String, required: true },
    percentage: { type: Number, required: true, min: 0, max: 100 },
    effectiveFrom: { type: Date, required: true, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false }, _id: true },
);

const royaltyConfigSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, unique: true, index: true },
    history: { type: [historyEntrySchema], default: [] },
    quotationOverrides: { type: [overrideEntrySchema], default: [] },
  },
  { timestamps: true },
);

/** Current rate = the most recent history entry, or null if never configured. */
royaltyConfigSchema.methods.currentPercentage = function () {
  if (!this.history.length) return null;
  return this.history.reduce((latest, h) =>
    !latest || h.effectiveFrom > latest.effectiveFrom ? h : latest
  ).percentage;
};

/**
 * The percentage that was actually in effect on `date` — a quotation-level
 * override wins if one exists for that date, otherwise the tenant-wide
 * history entry with the latest `effectiveFrom` at or before `date`.
 * Returns 0 if nothing was configured yet as of that date (safe default:
 * no configured rate means no royalty is computed, not an error).
 */
royaltyConfigSchema.methods.getEffectivePercentage = function (date, quoteId = null) {
  const at = date instanceof Date ? date : new Date(date);

  if (quoteId) {
    const overrides = this.quotationOverrides
      .filter(o => o.quoteId === String(quoteId) && o.effectiveFrom <= at)
      .sort((a, b) => b.effectiveFrom - a.effectiveFrom);
    if (overrides.length) return overrides[0].percentage;
  }

  const applicable = this.history
    .filter(h => h.effectiveFrom <= at)
    .sort((a, b) => b.effectiveFrom - a.effectiveFrom);

  return applicable.length ? applicable[0].percentage : 0;
};

module.exports = mongoose.model('RoyaltyConfig', royaltyConfigSchema);
