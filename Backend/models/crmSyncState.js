'use strict';

/**
 * models/crmSyncState.js
 *
 * One document per tenant recording CRM synchronisation health: when the last
 * attempt / last success happened, what the last run did (fetched, inserted,
 * updated, unchanged, skipped, failed, marked deleted), the exact failure
 * reason, and a short history of recent runs. Also carries the lock that
 * stops two syncs for the same tenant running at once.
 *
 * Never stores credentials.
 */

const mongoose = require('mongoose');

const statsSchema = new mongoose.Schema(
  {
    fetched:          { type: Number, default: 0 },
    crmReportedCount: { type: Number, default: null },
    inserted:         { type: Number, default: 0 },
    updated:          { type: Number, default: 0 },
    unchanged:        { type: Number, default: 0 },
    restored:         { type: Number, default: 0 },
    skipped:          { type: Number, default: 0 },
    failed:           { type: Number, default: 0 },
    markedDeleted:    { type: Number, default: 0 },
  },
  { _id: false },
);

const runSchema = new mongoose.Schema(
  {
    trigger:    { type: String, default: 'manual' },   // manual | scheduled | initial | stale-read | connect
    status:     { type: String, enum: ['success', 'partial', 'error'], required: true },
    startedAt:  { type: Date, required: true },
    finishedAt: { type: Date, required: true },
    durationMs: { type: Number, default: 0 },
    error:      { type: String, default: null },
    issues:     { type: [String], default: [] },
    stats:      { type: statsSchema, default: () => ({}) },
  },
  { _id: false },
);

const crmSyncStateSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, unique: true },

    lockedUntil: { type: Date, default: null },     // a sync is running while this is in the future
    lockedBy:    { type: String, default: null },

    lastStatus:      { type: String, enum: ['success', 'partial', 'error', null], default: null },
    lastTrigger:     { type: String, default: null },
    lastAttemptAt:   { type: Date, default: null },
    lastFinishedAt:  { type: Date, default: null },
    lastSuccessAt:   { type: Date, default: null },  // last run that wrote a usable dataset (success or partial)
    lastDurationMs:  { type: Number, default: null },
    lastError:       { type: String, default: null },
    lastIssues:      { type: [String], default: [] },
    lastStats:       { type: statsSchema, default: () => ({}) },
    consecutiveFailures: { type: Number, default: 0 },

    runs: { type: [runSchema], default: [] },        // most recent first, capped
  },
  { timestamps: true },
);

module.exports = mongoose.model('CrmSyncState', crmSyncStateSchema);
