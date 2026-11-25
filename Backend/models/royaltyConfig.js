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

/**
 * Start of the UTC calendar day containing `d`. Rates are compared on whole
 * days, not timestamps: a payment recorded with a plain date (Tracking's date
 * picker stores "2026-11-24" as 2026-11-24T00:00Z) must still get a rate set
 * at 3 pm that same day. Comparing raw timestamps made every such payment
 * resolve to "no rate yet" → 0%.
 */
const dayStart = (d) => {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  return t;
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The latest history entry (the rate in force today), or null. */
royaltyConfigSchema.methods.currentEntry = function () {
  if (!this.history.length) return null;
  return this.history.reduce((latest, h) =>
    !latest || h.effectiveFrom > latest.effectiveFrom ? h : latest
  );
};

/** Current rate = the most recent history entry, or null if never configured. */
royaltyConfigSchema.methods.currentPercentage = function () {
  return this.currentEntry()?.percentage ?? null;
};

/**
 * Which rate applies to a payment made on `date`, and why:
 *   - `override`   — a quotation-level rate in force on that day
 *   - `history`    — the tenant rate in force on that day
 *   - `first-rate` — the payment predates the first rate ever set, so that
 *                    first rate applies. "Not configured yet" is an admin
 *                    data-entry gap, not a 0% agreement: treating it as 0%
 *                    zeroed out every payment recorded before the platform
 *                    admin got round to entering the rate.
 *   - `unset`      — no rate has ever been configured → 0%.
 * Later rate *changes* still only apply from the day they were made, so past
 * periods keep the rate that was actually in force.
 */
royaltyConfigSchema.methods.resolveRate = function (date, quoteId = null) {
  const at = date instanceof Date ? date : new Date(date);
  const onOrBefore = (e) => dayStart(e.effectiveFrom) <= at;
  const newestFirst = (a, b) => b.effectiveFrom - a.effectiveFrom;

  if (quoteId) {
    const override = this.quotationOverrides
      .filter(o => o.quoteId === String(quoteId) && onOrBefore(o))
      .sort(newestFirst)[0];
    if (override) return { percentage: override.percentage, effectiveFrom: override.effectiveFrom, basis: 'override' };
  }

  if (!this.history.length) return { percentage: 0, effectiveFrom: null, basis: 'unset' };

  const inForce = this.history.filter(onOrBefore).sort(newestFirst)[0];
  if (inForce) return { percentage: inForce.percentage, effectiveFrom: inForce.effectiveFrom, basis: 'history' };

  const first = [...this.history].sort((a, b) => a.effectiveFrom - b.effectiveFrom)[0];
  return { percentage: first.percentage, effectiveFrom: first.effectiveFrom, basis: 'first-rate' };
};

/** The percentage in effect on `date` (see resolveRate for the rules). */
royaltyConfigSchema.methods.getEffectivePercentage = function (date, quoteId = null) {
  return this.resolveRate(date, quoteId).percentage;
};

/**
 * Royalty owed on one payment — the single calculation the Royalty page and
 * the Super Admin dashboard both use, so their totals always reconcile.
 */
royaltyConfigSchema.methods.royaltyFor = function (amount, date, quoteId = null) {
  const rate = this.resolveRate(date, quoteId);
  return { ...rate, amount: round2(((Number(amount) || 0) * rate.percentage) / 100) };
};

module.exports = mongoose.model('RoyaltyConfig', royaltyConfigSchema);
