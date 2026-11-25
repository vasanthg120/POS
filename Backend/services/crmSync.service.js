'use strict';

/**
 * services/crmSync.service.js
 *
 * Synchronises each tenant's CRM (ProspectConnect) quotations into MongoDB
 * (models/crmQuote.js) and records the health of every run
 * (models/crmSyncState.js).
 *
 *   CRM ──fetchAllQuotesWithMeta──▶ syncTenant ──upsert──▶ crmquotes
 *                                        │
 *                                        └──▶ crmsyncstates (status, counts, errors, history)
 *
 * Reads are live: getSyncedQuotes() pulls from the CRM before answering
 * whenever the stored copy is older than CRM_LIVE_MAX_AGE_SECONDS (default
 * 15), waiting at most CRM_LIVE_WAIT_MS (default 6000) — a slow CRM never
 * stalls a page; it gets the stored copy and the pull finishes in the
 * background. A never-synced tenant waits for its first import. A scheduled
 * job (jobs/crmSyncCron.js) keeps every tenant fresh between page loads.
 * There is no manual "sync" action.
 *
 * Guarantees:
 *   - Idempotent: one row per (tenantId, crmQuoteId) — re-syncing never
 *     duplicates quotes. Unchanged records (same content hash) are not rewritten.
 *   - Deletions are soft (isDeletedInCrm) and only inferred from a COMPLETE
 *     fetch; a truncated or empty fetch never hides previously synced quotes.
 *   - One sync per tenant at a time (DB lock + in-process de-duplication).
 *   - The CRM API key is never logged or persisted outside the Tenant record.
 */

const crypto = require('crypto');
const os = require('os');
const Tenant = require('../models/tenant');
const CrmQuote = require('../models/crmQuote');
const CrmSyncState = require('../models/crmSyncState');
const logger = require('../utils/logger');
const { fetchAllQuotesWithMeta, stripHeavyFields } = require('./quoteTracking.service');

/* ── Configuration ───────────────────────────────────────────────────────── */

const intEnv = (name, def, min, max) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

const LOCK_MS        = 10 * 60_000;   // a crashed run releases its lock after this
const FAILURE_BACKOFF_MS = 60_000;    // after a failed run, reads wait this long before calling the CRM again
const RUN_HISTORY    = 20;
const MAX_ISSUES     = 20;
/** A read refreshes from the CRM first when the stored copy is older than this. */
const liveMaxAgeMs   = () => intEnv('CRM_LIVE_MAX_AGE_SECONDS', 15, 0, 3600) * 1000;
/** How long a read waits for that refresh before serving the stored copy. */
const liveWaitMs     = () => intEnv('CRM_LIVE_WAIT_MS', 6000, 0, 30_000);
const intervalMinutes = () => intEnv('CRM_SYNC_INTERVAL_MINUTES', 1, 1, 59);

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const inFlight = new Map();   // String(tenant._id) -> Promise<result>

const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const hashOf = (obj) => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex');

// tenantId string (e.g. "SUPERADMIN", "T-…") — never the email, to keep PII out of logs.
const tenantLabel = (tenant) => tenant?.tenantId || String(tenant?._id);

const crmSyncError = (message, status = 502) =>
  Object.assign(new Error(message), { status, isCrmError: true });

/** CRM record → CrmQuote fields. */
const toRecord = (q) => {
  const raw = stripHeavyFields(q);
  return {
    crmQuoteId:           String(q._id ?? q.id),
    quoteNumber:          q.ticket_number != null ? String(q.ticket_number) : '',
    quoteStatus:          String(q.quote_status ?? q.status ?? ''),
    clientApprovalStatus: String(q.client_approval_status ?? ''),
    amount:               Number(q.quote_amount ?? q.amount ?? q.total ?? 0) || 0,
    currency:             q.currency || 'INR',
    crmCreatedAt:         toDate(q.created_at ?? q.createdAt ?? q.date_created),
    crmUpdatedAt:         toDate(q.date_modified ?? q.updated_at ?? q.updatedAt),
    isDeletedInCrm:       q.is_delete === true,
    raw,
    contentHash:          hashOf(raw),
  };
};

const loadApiKey = async (tenantObjId) => {
  const t = await Tenant.findById(tenantObjId).select('+crm.apiKey');
  if (!t?.crm?.isConfigured) return null;
  try { return t.getCRMKey(); } catch { return null; }
};

/* ── Lock ────────────────────────────────────────────────────────────────── */

/**
 * Atomically takes the per-tenant lock. Returns null when another process
 * holds it: the filter doesn't match a locked document, so the upsert tries
 * to insert a second state row for the tenant and hits the unique index.
 */
const acquireLock = async (tenantObjId, trigger) => {
  const now = new Date();
  try {
    return await CrmSyncState.findOneAndUpdate(
      { tenantId: tenantObjId, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
      {
        $set: {
          lockedUntil:   new Date(now.getTime() + LOCK_MS),
          lockedBy:      `${os.hostname()}:${process.pid}`,
          lastAttemptAt: now,
          lastTrigger:   trigger,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
};

/* ── One tenant ──────────────────────────────────────────────────────────── */

const runSync = async (tenant, { trigger, apiKey }) => {
  const tenantObjId = tenant._id;
  const label = tenantLabel(tenant);
  const startedAt = new Date();

  const lock = await acquireLock(tenantObjId, trigger);
  if (!lock) {
    logger.info(`[CRM Sync] tenant=${label} trigger=${trigger} skipped: a sync is already running`);
    return { status: 'skipped', error: null, reason: 'A sync is already running for this account.' };
  }

  const stats = {
    fetched: 0, crmReportedCount: null, inserted: 0, updated: 0, unchanged: 0,
    restored: 0, skipped: 0, failed: 0, markedDeleted: 0,
  };
  const issues = [];
  const note = (msg) => { if (issues.length < MAX_ISSUES) issues.push(msg); };
  let status = 'success';
  let errorMessage = null;

  try {
    const key = apiKey || (await loadApiKey(tenantObjId));
    if (!key) throw crmSyncError('CRM API key is missing or could not be decrypted. Reconnect the CRM in Settings.', 400);

    const { quotes, reportedCount, complete } = await fetchAllQuotesWithMeta(key);
    stats.fetched = quotes.length;
    stats.crmReportedCount = reportedCount;

    const existing = await CrmQuote.find({ tenantId: tenantObjId })
      .select('crmQuoteId contentHash isDeletedInCrm').lean();
    const existingById = new Map(existing.map(e => [e.crmQuoteId, e]));

    const now = new Date();
    const seen = new Set();
    const ops = [];
    const opKinds = [];

    for (const q of quotes) {
      const id = q?._id ?? q?.id;
      if (!id) { stats.skipped++; note('Skipped a CRM record that has no _id.'); continue; }
      const crmQuoteId = String(id);
      if (seen.has(crmQuoteId)) {
        stats.skipped++;
        note(`Skipped duplicate of quote ${crmQuoteId} (the CRM returned it more than once).`);
        continue;
      }
      seen.add(crmQuoteId);

      let rec;
      try { rec = toRecord(q); } catch (err) {
        stats.failed++;
        note(`Quote ${crmQuoteId}: could not be transformed (${err.message}).`);
        continue;
      }

      const prev = existingById.get(crmQuoteId);
      if (prev && prev.contentHash === rec.contentHash && prev.isDeletedInCrm === rec.isDeletedInCrm) {
        stats.unchanged++;
        continue;
      }

      ops.push({
        updateOne: {
          filter: { tenantId: tenantObjId, crmQuoteId },
          update: {
            $set: {
              ...rec,
              provider: 'prospectconnect',
              lastSyncedAt: now,
              deletedDetectedAt: rec.isDeletedInCrm ? now : null,
            },
            $setOnInsert: { firstSyncedAt: now },
          },
          upsert: true,
        },
      });
      opKinds.push(!prev ? 'inserted' : (prev.isDeletedInCrm && !rec.isDeletedInCrm ? 'restored' : 'updated'));
    }

    if (ops.length) {
      const failedIdx = new Map();   // op index -> reason
      let result = null;
      try {
        result = await CrmQuote.bulkWrite(ops, { ordered: false });
      } catch (err) {
        const writeErrors = err?.writeErrors ?? err?.result?.getWriteErrors?.() ?? [];
        if (!writeErrors.length) throw err;
        for (const we of writeErrors) failedIdx.set(we.index, we.errmsg ?? we.message ?? 'write error');
      }
      // Mongoose (ordered:false) reports per-op cast/validation failures here instead of throwing.
      const perOp = result?.mongoose?.results;
      if (Array.isArray(perOp)) perOp.forEach((r, i) => { if (r instanceof Error) failedIdx.set(i, r.message); });

      opKinds.forEach((kind, i) => {
        if (failedIdx.has(i)) {
          stats.failed++;
          note(`Quote ${ops[i].updateOne.filter.crmQuoteId}: database write failed (${failedIdx.get(i)}).`);
        } else {
          stats[kind]++;
        }
      });
    }

    // Deletion detection — only on a complete, non-empty fetch.
    const activeBefore = existing.filter(e => !e.isDeletedInCrm);
    const missing = activeBefore.filter(e => !seen.has(e.crmQuoteId)).map(e => e.crmQuoteId);
    if (!complete) {
      status = 'partial';
      note(`CRM returned ${seen.size} unique quotes but reports ${reportedCount ?? 'an unknown total'}; deletion detection skipped for this run.`);
    } else if (seen.size === 0 && activeBefore.length > 0) {
      status = 'partial';
      note(`CRM returned no quotes although ${activeBefore.length} were synced before; they were kept as a safety measure.`);
    } else if (missing.length) {
      const r = await CrmQuote.updateMany(
        { tenantId: tenantObjId, crmQuoteId: { $in: missing }, isDeletedInCrm: false },
        { $set: { isDeletedInCrm: true, deletedDetectedAt: now } },
      );
      stats.markedDeleted = r.modifiedCount ?? missing.length;
    }

    if (stats.failed > 0 && status === 'success') status = 'partial';
  } catch (err) {
    status = 'error';
    errorMessage = err?.message || String(err);
  }

  const finishedAt = new Date();
  const durationMs = finishedAt - startedAt;
  const run = { trigger, status, startedAt, finishedAt, durationMs, error: errorMessage, issues, stats };

  const $set = {
    lockedUntil: null, lockedBy: null,
    lastStatus: status, lastFinishedAt: finishedAt, lastDurationMs: durationMs,
    lastError: errorMessage, lastIssues: issues,
  };
  if (status !== 'error') {
    $set.lastSuccessAt = finishedAt;
    $set.lastStats = stats;
    $set.consecutiveFailures = 0;
  }
  const update = { $set, $push: { runs: { $each: [run], $position: 0, $slice: RUN_HISTORY } } };
  if (status === 'error') update.$inc = { consecutiveFailures: 1 };

  try {
    await CrmSyncState.updateOne({ tenantId: tenantObjId }, update);
  } catch (err) {
    logger.error(`[CRM Sync] tenant=${label} could not record sync state: ${err.message}`);
  }

  const summary = `[CRM Sync] tenant=${label} trigger=${trigger} status=${status}`
    + ` fetched=${stats.fetched} crmCount=${stats.crmReportedCount ?? '?'}`
    + ` inserted=${stats.inserted} updated=${stats.updated} unchanged=${stats.unchanged}`
    + ` restored=${stats.restored} skipped=${stats.skipped} failed=${stats.failed}`
    + ` markedDeleted=${stats.markedDeleted} durationMs=${durationMs}`;
  if (status === 'error') logger.error(`${summary} error="${errorMessage}"`);
  else if (status === 'partial') logger.warn(`${summary} issues="${issues.join(' | ')}"`);
  else logger.info(summary);

  if (status !== 'error') {
    // Let the Super Admin views pick the new data up immediately instead of
    // after their 60s cache expires. Lazy require: that service requires this one.
    try { require('./superAdminAggregation.service').invalidateTenantQuoteCache(tenant.tenantId); } catch { /* optional */ }
  }

  return { status, error: errorMessage, stats, issues, startedAt, finishedAt, durationMs };
};

/**
 * Syncs one tenant now. Concurrent calls for the same tenant in this process
 * share a single run; across processes the DB lock makes the loser return
 * { status: 'skipped' }. Never throws for CRM/API failures — those come back
 * as { status: 'error', error }. Only infrastructure failures (DB down) reject.
 *
 * @param tenant  Tenant document (needs _id, tenantId)
 * @param opts.apiKey  decrypted CRM key, if the caller already has it
 */
const syncTenant = (tenant, { trigger = 'manual', apiKey } = {}) => {
  const key = String(tenant._id);
  if (inFlight.has(key)) return inFlight.get(key);
  const p = runSync(tenant, { trigger, apiKey }).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
};

/* ── All tenants (scheduled) ─────────────────────────────────────────────── */

let allRunning = false;

const syncAllTenants = async ({ trigger = 'scheduled' } = {}) => {
  if (allRunning) {
    logger.info(`[CRM Sync] ${trigger} run skipped: the previous run is still in progress`);
    return { skipped: true };
  }
  allRunning = true;
  const startedAt = Date.now();
  const summary = { tenants: 0, success: 0, partial: 0, error: 0, skipped: 0 };

  try {
    // Every account that owns a CRM connection — store tenants and, when it
    // has connected one, the superadmin account. Sub-users share their
    // parent's connection.
    const tenants = await Tenant
      .find({ 'crm.isConfigured': true, isSubUser: { $ne: true }, isActive: { $ne: false } })
      .select('+crm.apiKey');

    for (const t of tenants) {
      summary.tenants++;
      let key = null;
      try { key = t.getCRMKey(); } catch { key = null; }
      try {
        const r = await syncTenant(t, { trigger, apiKey: key || undefined });
        summary[r.status] = (summary[r.status] ?? 0) + 1;
      } catch (err) {
        summary.error++;
        logger.error(`[CRM Sync] tenant=${tenantLabel(t)} trigger=${trigger} crashed: ${err.message}`);
      }
    }
  } finally {
    allRunning = false;
  }

  const line = `[CRM Sync] ${trigger} run finished: tenants=${summary.tenants} success=${summary.success}`
    + ` partial=${summary.partial} error=${summary.error} skipped=${summary.skipped} durationMs=${Date.now() - startedAt}`;
  if (summary.error) logger.warn(line); else logger.info(line);
  return summary;
};

/* ── Status ──────────────────────────────────────────────────────────────── */

const summariseState = (state) => {
  const running = !!(state?.lockedUntil && new Date(state.lockedUntil).getTime() > Date.now());
  return {
    status:              running ? 'running' : (state?.lastStatus ?? 'never'),
    running,
    lastStatus:          state?.lastStatus ?? null,
    lastTrigger:         state?.lastTrigger ?? null,
    lastAttemptAt:       state?.lastAttemptAt ?? null,
    lastSuccessAt:       state?.lastSuccessAt ?? null,
    lastFinishedAt:      state?.lastFinishedAt ?? null,
    lastDurationMs:      state?.lastDurationMs ?? null,
    lastError:           state?.lastError ?? null,
    lastIssues:          state?.lastIssues ?? [],
    lastStats:           state?.lastStats ?? null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
  };
};

const getSyncStatus = async (tenantObjId, { includeRuns = false } = {}) => {
  const [state, storedQuotes] = await Promise.all([
    CrmSyncState.findOne({ tenantId: tenantObjId }).lean(),
    CrmQuote.countDocuments({ tenantId: tenantObjId, isDeletedInCrm: false }),
  ]);
  return {
    ...summariseState(state),
    storedQuotes,
    intervalMinutes: intervalMinutes(),
    liveMaxAgeSeconds: liveMaxAgeMs() / 1000,
    ...(includeRuns ? { recentRuns: (state?.runs ?? []).slice(0, 10) } : {}),
  };
};

/**
 * True when a read should pull from the CRM before answering: the stored
 * copy is older than the live window, and the CRM isn't in its back-off
 * after a failed run (a down CRM isn't called on every page load).
 */
const needsLiveRefresh = (state) => {
  const now = Date.now();
  const lastSuccess = state?.lastSuccessAt ? new Date(state.lastSuccessAt).getTime() : 0;
  if (now - lastSuccess <= liveMaxAgeMs()) return false;
  const lastAttempt = state?.lastAttemptAt ? new Date(state.lastAttemptAt).getTime() : 0;
  if (state?.lastStatus === 'error' && now - lastAttempt < FAILURE_BACKOFF_MS) return false;
  return true;
};

/** Resolves with the promise's result, or null after `ms` (the promise keeps running). */
const within = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), ms);
  promise.then(
    (r) => { clearTimeout(timer); resolve(r); },
    () => { clearTimeout(timer); resolve(null); },
  );
});

/* ── Read path ───────────────────────────────────────────────────────────── */

/**
 * The tenant's quotes as raw CRM records (same shape fetchAllQuotes()
 * returned), served from MongoDB, plus a sync-status summary.
 *
 * - Never synced → blocks on a first import; if that import fails the CRM's
 *   error is thrown (isCrmError) so the screen shows it instead of zeros.
 * - Older than the live window → pulls from the CRM first (concurrent reads
 *   share one pull), waiting at most liveWaitMs(); past that, or if the pull
 *   fails, the stored copy is served and the summary carries the failure.
 */
const getSyncedQuotes = async (tenant, apiKey) => {
  const tenantId = tenant._id;
  let state = await CrmSyncState.findOne({ tenantId }).lean();

  if (!state?.lastSuccessAt) {
    const result = await syncTenant(tenant, { trigger: 'initial', apiKey });
    if (result.status === 'error') throw crmSyncError(`CRM sync failed: ${result.error}`);
    state = await CrmSyncState.findOne({ tenantId }).lean();
  } else if (needsLiveRefresh(state)) {
    const refresh = syncTenant(tenant, { trigger: 'live-read', apiKey });
    refresh.catch(err =>
      logger.error(`[CRM Sync] tenant=${tenantLabel(tenant)} live refresh crashed: ${err.message}`));
    const result = await within(refresh, liveWaitMs());
    if (result && result.status !== 'skipped') state = await CrmSyncState.findOne({ tenantId }).lean();
  }

  const docs = await CrmQuote.find({ tenantId, isDeletedInCrm: false })
    .sort({ crmCreatedAt: -1 })
    .select('raw')
    .lean();

  return { quotes: docs.map(d => d.raw), sync: summariseState(state) };
};

/** Looks a single synced quote up by CRM _id or quote number. */
const findSyncedQuote = async (tenantObjId, idOrNumber) => {
  const doc = await CrmQuote.findOne({
    tenantId: tenantObjId,
    isDeletedInCrm: false,
    $or: [{ crmQuoteId: String(idOrNumber) }, { quoteNumber: String(idOrNumber) }],
  }).select('raw').lean();
  return doc?.raw ?? null;
};

/** Drops a tenant's mirrored CRM data (used when the CRM is disconnected).
 *  POS-owned QuoteTracking records are left untouched. */
const purgeTenantCrmData = async (tenantObjId) => {
  const [q] = await Promise.all([
    CrmQuote.deleteMany({ tenantId: tenantObjId }),
    CrmSyncState.deleteOne({ tenantId: tenantObjId }),
  ]);
  return { deletedQuotes: q.deletedCount ?? 0 };
};

module.exports = {
  syncTenant,
  syncAllTenants,
  getSyncedQuotes,
  getSyncStatus,
  findSyncedQuote,
  purgeTenantCrmData,
  intervalMinutes,
  // exported for tests
  _internal: { toRecord, needsLiveRefresh, summariseState, inFlight },
};
