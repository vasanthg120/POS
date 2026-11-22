'use strict';

/**
 * Integration tests for services/crmSync.service.js against a real MongoDB.
 *
 * Uses a dedicated throwaway database (TEST_MONGODB_URI, default
 * mongodb://127.0.0.1:27017/FP_crm_sync_test) and refuses to run against any
 * database whose name doesn't end in "_test". The CRM is simulated by mocking
 * global fetch with ProspectConnect's real response shape.
 */

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-0123456789abcdef';

const mongoose = require('mongoose');
const Tenant = require('../models/tenant');
const CrmQuote = require('../models/crmQuote');
const CrmSyncState = require('../models/crmSyncState');
const sync = require('../services/crmSync.service');
const logger = require('../utils/logger');

const TEST_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/FP_crm_sync_test';

const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
const mkQuote = (n, over = {}) => ({
  _id: `q${n}`,
  ticket_number: 1000 + n,
  quote_name: `Quote ${n}`,
  quote_status: 'published',
  client_approval_status: 'awaiting_response',
  quote_amount: 100 * n,
  currency: 'INR',
  created_at: new Date(Date.UTC(2026, 10, n)).toISOString(),
  expiration_date: future,
  is_delete: false,
  is_active: true,
  tax: [],
  client_details: { id: `c${n}`, name: `Customer ${n}`, email: `c${n}@example.com` },
  contact_detail: { teamDetail: {} },
  quote_owner: { name: 'Owner' },
  deal: { name: 'Deal' },
  purchase_terms: '<p>terms</p>'.repeat(200),
  ...over,
});

// Simulated ProspectConnect: { quotes, count } pages, or an error status.
const crm = { quotes: [], count: undefined, status: 200, body: null, delayMs: 0 };
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const installCrm = () => {
  global.fetch = jest.fn(async (_url, opts) => {
    if (crm.delayMs) await new Promise(r => setTimeout(r, crm.delayMs));
    if (crm.status !== 200) return response(crm.body ?? '<html>error</html>', crm.status);
    if (crm.body) return response(crm.body);
    const { limit, startAfter } = JSON.parse(opts.body);
    return response({ quotes: crm.quotes.slice(startAfter, startAfter + limit), count: crm.count ?? crm.quotes.length });
  });
};

const newTenant = (tenantId = 'T-TEST') => ({ _id: new mongoose.Types.ObjectId(), tenantId });

beforeAll(async () => {
  const dbName = new URL(TEST_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to run sync tests against "${dbName}" — use a *_test database.`);
  await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 4000 });
  await mongoose.connection.db.dropDatabase();
  await Promise.all([CrmQuote.syncIndexes(), CrmSyncState.syncIndexes(), Tenant.syncIndexes()]);
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(() => {
  Object.assign(crm, { quotes: [], count: undefined, status: 200, body: null, delayMs: 0 });
  jest.clearAllMocks();
  installCrm();
});

describe('syncTenant()', () => {
  test('initial import stores every quote once, without the heavy HTML fields', async () => {
    const t = newTenant();
    crm.quotes = [1, 2, 3].map(n => mkQuote(n));

    const r = await sync.syncTenant(t, { apiKey: 'k', trigger: 'test' });

    expect(r.status).toBe('success');
    expect(r.stats).toMatchObject({ fetched: 3, inserted: 3, updated: 0, unchanged: 0, failed: 0, markedDeleted: 0 });
    const docs = await CrmQuote.find({ tenantId: t._id }).lean();
    expect(docs).toHaveLength(3);
    expect(docs[0].raw.purchase_terms).toBeUndefined();
    expect(docs[0].raw.contact_detail).toEqual({ teamDetail: {} });   // empty objects kept
    const state = await CrmSyncState.findOne({ tenantId: t._id }).lean();
    expect(state.lastStatus).toBe('success');
    expect(state.lastSuccessAt).toBeTruthy();
    expect(state.lockedUntil).toBeNull();
    expect(state.runs).toHaveLength(1);
  });

  test('re-sync is idempotent: no duplicates, unchanged records not rewritten', async () => {
    const t = newTenant();
    crm.quotes = [1, 2, 3].map(n => mkQuote(n));
    await sync.syncTenant(t, { apiKey: 'k' });
    const before = await CrmQuote.findOne({ tenantId: t._id, crmQuoteId: 'q1' }).lean();

    const r = await sync.syncTenant(t, { apiKey: 'k' });

    expect(r.stats).toMatchObject({ fetched: 3, inserted: 0, updated: 0, unchanged: 3 });
    expect(await CrmQuote.countDocuments({ tenantId: t._id })).toBe(3);
    const after = await CrmQuote.findOne({ tenantId: t._id, crmQuoteId: 'q1' }).lean();
    expect(after.lastSyncedAt).toEqual(before.lastSyncedAt);
  });

  test('picks up updates, new quotes and deletions; restores a quote that comes back', async () => {
    const t = newTenant();
    crm.quotes = [1, 2, 3].map(n => mkQuote(n));
    await sync.syncTenant(t, { apiKey: 'k' });

    crm.quotes = [mkQuote(1, { quote_amount: 999, client_approval_status: 'approved' }), mkQuote(2), mkQuote(4)];
    const r = await sync.syncTenant(t, { apiKey: 'k' });
    expect(r.stats).toMatchObject({ inserted: 1, updated: 1, unchanged: 1, markedDeleted: 1 });

    const q1 = await CrmQuote.findOne({ tenantId: t._id, crmQuoteId: 'q1' }).lean();
    expect(q1.amount).toBe(999);
    expect(q1.clientApprovalStatus).toBe('approved');
    const q3 = await CrmQuote.findOne({ tenantId: t._id, crmQuoteId: 'q3' }).lean();
    expect(q3.isDeletedInCrm).toBe(true);

    const { quotes } = await sync.getSyncedQuotes(t, 'k');
    expect(quotes.map(q => q._id).sort()).toEqual(['q1', 'q2', 'q4']);

    crm.quotes = [mkQuote(1, { quote_amount: 999, client_approval_status: 'approved' }), mkQuote(2), mkQuote(3), mkQuote(4)];
    const r2 = await sync.syncTenant(t, { apiKey: 'k' });
    expect(r2.stats.restored).toBe(1);
    expect((await CrmQuote.findOne({ tenantId: t._id, crmQuoteId: 'q3' }).lean()).isDeletedInCrm).toBe(false);
  });

  test('CRM-flagged is_delete records are stored as deleted', async () => {
    const t = newTenant();
    crm.quotes = [mkQuote(1), mkQuote(2, { is_delete: true })];
    await sync.syncTenant(t, { apiKey: 'k' });
    const { quotes } = await sync.getSyncedQuotes(t, 'k');
    expect(quotes.map(q => q._id)).toEqual(['q1']);
  });

  test('an incomplete fetch never marks quotes deleted', async () => {
    const t = newTenant();
    crm.quotes = [1, 2, 3].map(n => mkQuote(n));
    await sync.syncTenant(t, { apiKey: 'k' });

    crm.quotes = [mkQuote(1)];
    crm.count = 3;   // CRM says 3 exist, only 1 came back
    const r = await sync.syncTenant(t, { apiKey: 'k' });

    expect(r.status).toBe('partial');
    expect(r.stats.markedDeleted).toBe(0);
    expect(r.issues.join(' ')).toMatch(/deletion detection skipped/);
    expect(await CrmQuote.countDocuments({ tenantId: t._id, isDeletedInCrm: false })).toBe(3);
  });

  test('an empty CRM response keeps previously synced quotes', async () => {
    const t = newTenant();
    crm.quotes = [1, 2].map(n => mkQuote(n));
    await sync.syncTenant(t, { apiKey: 'k' });

    crm.quotes = [];
    const r = await sync.syncTenant(t, { apiKey: 'k' });
    expect(r.status).toBe('partial');
    expect(await CrmQuote.countDocuments({ tenantId: t._id, isDeletedInCrm: false })).toBe(2);
  });

  test('duplicate and id-less records are skipped and reported', async () => {
    const t = newTenant();
    crm.quotes = [mkQuote(1), mkQuote(1), { quote_name: 'no id' }];
    const r = await sync.syncTenant(t, { apiKey: 'k' });
    expect(r.stats).toMatchObject({ fetched: 3, inserted: 1, skipped: 2 });
    expect(await CrmQuote.countDocuments({ tenantId: t._id })).toBe(1);
  });

  test('a CRM failure is recorded with its reason and leaves stored data intact', async () => {
    const t = newTenant();
    crm.quotes = [1, 2].map(n => mkQuote(n));
    await sync.syncTenant(t, { apiKey: 'k' });

    crm.status = 401;
    crm.body = '<html>401 Authorization Required</html>';
    const r = await sync.syncTenant(t, { apiKey: 'secret-key-value' });

    expect(r.status).toBe('error');
    expect(r.error).toMatch(/ProspectConnect 401/);
    const state = await CrmSyncState.findOne({ tenantId: t._id }).lean();
    expect(state.lastStatus).toBe('error');
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastStats.inserted).toBe(2);           // last good run's stats kept
    expect(await CrmQuote.countDocuments({ tenantId: t._id, isDeletedInCrm: false })).toBe(2);
    expect(logger.error).toHaveBeenCalled();
    const logged = logger.error.mock.calls.map(c => c[0]).join('\n');
    expect(logged).toMatch(/status=error/);
    expect(logged).not.toMatch(/secret-key-value/);

    // Reads still serve the last good data and expose the failure.
    const { quotes, sync: s } = await sync.getSyncedQuotes(t, 'secret-key-value');
    expect(quotes).toHaveLength(2);
    expect(s.lastStatus).toBe('error');
    expect(s.lastError).toMatch(/401/);
  });

  test('concurrent calls in one process share a single run', async () => {
    const t = newTenant();
    crm.quotes = [mkQuote(1)];
    crm.delayMs = 50;
    const [a, b] = await Promise.all([sync.syncTenant(t, { apiKey: 'k' }), sync.syncTenant(t, { apiKey: 'k' })]);
    expect(a).toBe(b);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a lock held by another process makes the run skip', async () => {
    const t = newTenant();
    await CrmSyncState.create({ tenantId: t._id, lockedUntil: new Date(Date.now() + 60_000), lockedBy: 'other:1' });
    const r = await sync.syncTenant(t, { apiKey: 'k' });
    expect(r.status).toBe('skipped');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an expired lock (crashed run) is taken over', async () => {
    const t = newTenant();
    crm.quotes = [mkQuote(1)];
    await CrmSyncState.create({ tenantId: t._id, lockedUntil: new Date(Date.now() - 1000), lockedBy: 'dead:1' });
    const r = await sync.syncTenant(t, { apiKey: 'k' });
    expect(r.status).toBe('success');
  });
});

describe('getSyncedQuotes()', () => {
  test('never-synced tenant: blocks on the first import', async () => {
    const t = newTenant();
    crm.quotes = [1, 2].map(n => mkQuote(n));
    const { quotes, sync: s } = await sync.getSyncedQuotes(t, 'k');
    expect(quotes).toHaveLength(2);
    expect(s.lastStatus).toBe('success');
  });

  test('never-synced tenant + CRM down: throws the CRM error instead of returning nothing', async () => {
    const t = newTenant();
    crm.status = 503;
    await expect(sync.getSyncedQuotes(t, 'k')).rejects.toMatchObject({ isCrmError: true });
    await expect(sync.getSyncedQuotes(t, 'k')).rejects.toThrow(/CRM sync failed: ProspectConnect 503/);
  });

  test('stale data is served immediately and refreshed in the background', async () => {
    const t = newTenant();
    crm.quotes = [mkQuote(1)];
    await sync.syncTenant(t, { apiKey: 'k' });
    const old = new Date(Date.now() - 60 * 60_000);
    await CrmSyncState.updateOne({ tenantId: t._id }, { $set: { lastSuccessAt: old, lastAttemptAt: old } });
    crm.quotes = [mkQuote(1), mkQuote(2)];
    global.fetch.mockClear();

    const { quotes } = await sync.getSyncedQuotes(t, 'k');
    expect(quotes).toHaveLength(1);                     // served from the DB right away
    await sync._internal.inFlight.get(String(t._id));   // let the background refresh finish
    expect(global.fetch).toHaveBeenCalled();
    expect((await sync.getSyncedQuotes(t, 'k')).quotes).toHaveLength(2);
  });
});

describe('syncAllTenants() and status', () => {
  test('syncs every account with a CRM connection, including a CRM-connected superadmin', async () => {
    crm.quotes = [mkQuote(1), mkQuote(2)];
    const mk = async (over) => {
      const t = new Tenant({ firstName: 'A', lastName: 'B', password: 'Password1!', ...over });
      if (over.withCrm) t.setCRMKeys({ apiKey: 'k', apiUrl: 'https://example.com', provider: 'prospectconnect' });
      return t.save();
    };
    const store = await mk({ email: 'store@example.com', tenantId: 'T-STORE', withCrm: true });
    const admin = await mk({ email: 'admin@example.com', tenantId: 'SUPERADMIN-T', role: 'superadmin', withCrm: true });
    await mk({ email: 'nocrm@example.com', tenantId: 'T-NOCRM' });

    const summary = await sync.syncAllTenants({ trigger: 'test' });

    expect(summary).toMatchObject({ tenants: 2, success: 2, error: 0 });
    expect(await CrmQuote.countDocuments({ tenantId: store._id })).toBe(2);
    expect(await CrmQuote.countDocuments({ tenantId: admin._id })).toBe(2);
    // the stored key is the one sent to the CRM
    expect(global.fetch.mock.calls.every(([, o]) => o.headers.Authorization === 'k')).toBe(true);
  });

  test('getSyncStatus reports counts, history and config', async () => {
    const t = newTenant();
    crm.quotes = [mkQuote(1)];
    await sync.syncTenant(t, { apiKey: 'k', trigger: 'manual' });
    const s = await sync.getSyncStatus(t._id, { includeRuns: true });
    expect(s).toMatchObject({ status: 'success', storedQuotes: 1, lastTrigger: 'manual' });
    expect(s.recentRuns[0].stats.inserted).toBe(1);
    expect(s.intervalMinutes).toBeGreaterThan(0);
  });

  test('purgeTenantCrmData removes mirrored data only', async () => {
    const t = newTenant();
    crm.quotes = [mkQuote(1)];
    await sync.syncTenant(t, { apiKey: 'k' });
    const r = await sync.purgeTenantCrmData(t._id);
    expect(r.deletedQuotes).toBe(1);
    expect(await CrmSyncState.countDocuments({ tenantId: t._id })).toBe(0);
  });
});
