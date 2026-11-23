'use strict';

/**
 * Integration API keys (Settings → API Integration) and the POS Integration
 * API v1, end to end over HTTP against a dedicated throwaway MongoDB database
 * (TEST_MONGODB_URI, default mongodb://127.0.0.1:27017/FP_api_keys_test).
 * Refuses to run against a database whose name doesn't end in "_test".
 */

// uuid is ESM-only: Node 22 loads it, Jest's CommonJS loader can't.
jest.mock('uuid', () => ({ v4: () => require('crypto').randomUUID() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/email', () => ({
  sendWelcomeEmail: jest.fn(async () => {}),
  sendSubUserInviteEmail: jest.fn(async () => {}),
  sendMemberAssignedEmail: jest.fn(async () => {}),
}));

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-0123456789abcdef';
process.env.JWT_SECRET = 'test-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789';
process.env.INTEGRATION_KEY_RATE_LIMIT_PER_MIN = '25';
process.env.INTEGRATION_IP_RATE_LIMIT_PER_MIN = '1000';

const express = require('express');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const Tenant = require('../models/tenant');
const ApiKey = require('../models/apiKey');
const CrmQuote = require('../models/crmQuote');
const QuoteTracking = require('../models/quote.tracking');
const jwt = require('../utils/jwt');
const logger = require('../utils/logger');
const { invalidateAccountAccess } = require('../utils/accountAccess');
const { KEY_PATTERN, verifyApiKey, _internal: { sha256 } } = require('../services/apiKey.service');

const TEST_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/FP_api_keys_test';

let server;
let base;
const acct = {};
const issuedKeys = [];   // every full key handed out, to prove none is ever logged

/* ── Harness ─────────────────────────────────────────────────────────────── */

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1', require('../routes/integration.v1.routes'));
  require('../routes/index')(app);
  app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: err.message }));
  return app;
};

const jwtFor = (doc) => jwt.generateAccessToken({
  sub: String(doc._id), email: doc.email, role: doc.role, tenantId: doc.tenantId,
  effectiveTenantObjId: doc.isSubUser ? String(acct.tenantA._id) : String(doc._id),
  effectiveTenantId: doc.isSubUser ? doc.parentTenantId : doc.tenantId,
  isSubUser: !!doc.isSubUser, parentTenantId: doc.parentTenantId ?? null,
  permissions: doc.isSubUser ? [{ pageKey: 'settings', actions: ['view', 'edit'] }] : [],
});

const call = async (method, path, { token, key, xKey, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers.Authorization = `Bearer ${key}`;
  if (xKey) headers['X-API-Key'] = xKey;
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
};

/** Generates (or regenerates) a key for an account through the Settings API. */
const issueKey = async (who, { regenerate = false } = {}) => {
  const r = await call('POST', `/api/tenant/integrations/api-key${regenerate ? '/regenerate' : ''}`, { token: jwtFor(acct[who]) });
  expect(r.status).toBe(201);
  issuedKeys.push(r.body.data.apiKey);
  return r.body.data.apiKey;
};

const mkAccount = (over) => Tenant.create({
  firstName: 'Test', lastName: 'User', password: 'Str0ng!Passw0rd', isEmailVerified: true,
  isActive: true, setupStep: 'complete', role: 'tenant', ...over,
});

const mkQuote = (tenant, n, over = {}) => CrmQuote.create({
  tenantId: tenant._id,
  crmQuoteId: `${tenant.tenantId}-q${n}`,
  quoteNumber: String(100 + n),
  amount: 1000 * n,
  contentHash: `hash-${tenant.tenantId}-${n}`,
  crmCreatedAt: new Date(Date.UTC(2026, 9, n)),
  raw: {
    _id: `${tenant.tenantId}-q${n}`, ticket_number: 100 + n, quote_name: `Deal ${n}`,
    quote_status: 'published', client_approval_status: n === 1 ? 'approved' : 'awaiting_response',
    quote_amount: 1000 * n, currency: 'INR', created_at: new Date(Date.UTC(2026, 9, n)).toISOString(),
    expiration_date: new Date(Date.UTC(2027, 0, 1)).toISOString(),
    tax: [{ tax_name: 'GST', currency: '%', tax_input: '18', tax_amount: 0 }],
    client_details: { id: `c${n}`, name: `Customer ${n}`, email: `c${n}@example.test`, company_name: 'Acme' },
    quote_owner: { name: 'Owner', email: 'owner@example.test' },
  },
  ...over,
});

beforeAll(async () => {
  const dbName = new URL(TEST_URI).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to run against non-test database "${dbName}"`);
  await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.db.dropDatabase();
  await Promise.all([Tenant.syncIndexes(), ApiKey.syncIndexes(), CrmQuote.syncIndexes(), QuoteTracking.syncIndexes()]);

  acct.superAdmin = await mkAccount({ email: 'owner@org.test', tenantId: 'SUPERADMIN', role: 'superadmin', businessName: 'Org' });
  acct.tenantA = await mkAccount({ email: 'a@store.test', tenantId: 'T-AAAA', businessName: 'Store A' });
  acct.tenantB = await mkAccount({ email: 'b@store.test', tenantId: 'T-BBBB', businessName: 'Store B' });
  acct.tenantC = await mkAccount({ email: 'c@store.test', tenantId: 'T-CCCC', businessName: 'Store C' });
  acct.aStaff = await mkAccount({
    email: 'staff@store-a.test', tenantId: 'sub-staff-a', isSubUser: true, parentTenantId: 'T-AAAA', subUserStatus: 'active',
  });

  await Promise.all([1, 2, 3].map(n => mkQuote(acct.tenantA, n)));
  await Promise.all([1, 2].map(n => mkQuote(acct.tenantB, n)));
  await QuoteTracking.create({
    tenantId: acct.tenantA._id, quoteId: 'T-AAAA-q1', paymentStatus: 'paid', paidAmount: 1000,
    paymentMethod: 'UPI', paidAt: new Date('2026-10-05T10:00:00Z'),
  });

  server = buildApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise(r => server.close(r));
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
});

beforeEach(() => invalidateAccountAccess());

/* ── Key storage ─────────────────────────────────────────────────────────── */

describe('key generation and storage', () => {
  let key;
  beforeAll(async () => { key = await issueKey('tenantC'); });

  test('a key is long, random, and in the documented format', () => {
    expect(key).toMatch(KEY_PATTERN);
    // pos_<env>_ (9) + keyId (16) + _ (1) + secret (43 chars = 256 random bits)
    expect(key.length).toBe(69);
  });

  test('only a SHA-256 hash is stored — the key and its secret appear nowhere in the database', async () => {
    const raw = await ApiKey.collection.findOne({ tenant: acct.tenantC._id });
    expect(raw.hash).toBe(sha256(key));
    const stored = JSON.stringify(raw);
    const secret = key.split('_').slice(3).join('_');
    expect(stored).not.toContain(key);
    expect(stored).not.toContain(secret);
  });

  test('verification: exact key passes; a wrong secret or malformed key fails', async () => {
    expect((await verifyApiKey(key)).key?.tenantId).toBe('T-CCCC');
    const tampered = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
    expect((await verifyApiKey(tampered)).error).toBe('mismatch');
    expect((await verifyApiKey('pos_live_nothex_abc')).error).toBe('malformed');
    expect((await verifyApiKey(undefined)).error).toBe('malformed');
  });
});

/* ── Settings → API Integration (management API) ─────────────────────────── */

describe('Settings → API Integration endpoints', () => {
  test('require a signed-in account owner', async () => {
    expect((await call('GET', '/api/tenant/integrations/api-key')).status).toBe(401);
    const staff = jwtFor(acct.aStaff);
    for (const [m, p] of [['GET', ''], ['POST', ''], ['POST', '/regenerate'], ['DELETE', '']]) {
      const r = await call(m, `/api/tenant/integrations/api-key${p}`, { token: staff });
      expect([m, p, r.status]).toEqual([m, p, 403]);
    }
    expect(await ApiKey.countDocuments({ tenant: acct.tenantA._id })).toBe(0);
  });

  test('generate → shown once; status never includes it; a second generate is refused', async () => {
    const token = jwtFor(acct.tenantA);
    expect((await call('GET', '/api/tenant/integrations/api-key', { token })).body.data.status).toBe('none');

    const gen = await call('POST', '/api/tenant/integrations/api-key', { token });
    expect(gen.status).toBe(201);
    expect(gen.headers.get('cache-control')).toBe('no-store');
    const key = gen.body.data.apiKey;
    issuedKeys.push(key);
    expect(key).toMatch(KEY_PATTERN);
    expect(gen.body.data).toMatchObject({ status: 'active', basePath: '/api/v1' });

    const status = await call('GET', '/api/tenant/integrations/api-key', { token });
    expect(status.body.data.status).toBe('active');
    expect(status.text).not.toContain(key);
    expect(status.body.data.key.maskedKey).toMatch(/^pos_test_[a-f0-9]{16}_•+.{4}$/);
    expect(status.body.data.key.maskedKey.slice(-4)).toBe(key.slice(-4));

    const again = await call('POST', '/api/tenant/integrations/api-key', { token });
    expect([again.status, again.body.code]).toEqual([409, 'API_KEY_EXISTS']);
  });

  test('regenerate → the old key stops working immediately, the new one works', async () => {
    const oldKey = issuedKeys[issuedKeys.length - 1];   // tenant A's key from the previous test
    expect((await call('GET', '/api/v1', { key: oldKey })).status).toBe(200);

    const newKey = await issueKey('tenantA', { regenerate: true });
    expect(newKey).not.toBe(oldKey);

    const old = await call('GET', '/api/v1', { key: oldKey });
    expect([old.status, old.body.code]).toEqual([401, 'API_KEY_REVOKED']);
    expect((await call('GET', '/api/v1', { key: newKey })).status).toBe(200);

    const docs = await ApiKey.find({ tenant: acct.tenantA._id }).lean();
    expect(docs.filter(d => d.status === 'active')).toHaveLength(1);
    expect(docs.find(d => d.status === 'revoked').revokedReason).toBe('regenerated');
  });

  test('revoke → the key stops working and the status says Revoked', async () => {
    const key = await issueKey('tenantB');
    const token = jwtFor(acct.tenantB);
    const r = await call('DELETE', '/api/tenant/integrations/api-key', { token });
    expect([r.status, r.body.data.status]).toEqual([200, 'revoked']);
    expect(r.body.data.key.revokedAt).toBeTruthy();

    const use = await call('GET', '/api/v1', { key });
    expect([use.status, use.body.code]).toEqual([401, 'API_KEY_REVOKED']);
    expect((await call('DELETE', '/api/tenant/integrations/api-key', { token })).status).toBe(404);

    // A fresh key can be generated afterwards.
    await issueKey('tenantB');
  });

  test('the Super Admin can issue a key for its own space', async () => {
    const key = await issueKey('superAdmin');
    const r = await call('GET', '/api/v1', { key });
    expect(r.body.data.account.tenantId).toBe('SUPERADMIN');
  });
});

/* ── POS Integration API v1 ──────────────────────────────────────────────── */

describe('/api/v1 authentication', () => {
  test('no key → 401; garbage → 401; key in the URL → 400 (never accepted there)', async () => {
    const none = await call('GET', '/api/v1/quotations');
    expect([none.status, none.body.code]).toEqual([401, 'API_KEY_MISSING']);
    const bad = await call('GET', '/api/v1/quotations', { key: 'pos_live_0123456789abcdef_' + 'x'.repeat(43) });
    expect([bad.status, bad.body.code]).toEqual([401, 'INVALID_API_KEY']);
    const inUrl = await call('GET', `/api/v1/quotations?api_key=${encodeURIComponent(issuedKeys[0])}`);
    expect([inUrl.status, inUrl.body.code]).toEqual([400, 'API_KEY_IN_URL']);
  });

  test('discovery works with Bearer or X-API-Key and describes the API', async () => {
    const key = await currentKey('tenantA');
    const viaX = await call('GET', '/api/v1', { xKey: key });
    expect(viaX.status).toBe(200);
    const d = viaX.body.data;
    expect(d).toMatchObject({ version: 'v1', authenticated: true, account: { tenantId: 'T-AAAA', businessName: 'Store A' } });
    const byName = Object.fromEntries(d.resources.map(r => [r.name, r]));
    expect(byName.quotations).toMatchObject({ status: 'available', path: '/api/v1/quotations', scope: 'quotations:read' });
    for (const planned of ['sales', 'products', 'customers', 'inventory', 'orders', 'reports']) {
      expect(byName[planned].status).toBe('planned');
    }
    expect(viaX.headers.get('cache-control')).toBe('no-store');
  });

  test('planned resources answer 501, unknown paths 404 — both still require a key', async () => {
    const key = await currentKey('tenantA');
    const planned = await call('GET', '/api/v1/orders', { key });
    expect([planned.status, planned.body.code]).toEqual([501, 'NOT_IMPLEMENTED']);
    expect((await call('GET', '/api/v1/orders/123', { key })).status).toBe(501);
    expect((await call('GET', '/api/v1/nope', { key })).status).toBe(404);
    expect((await call('GET', '/api/v1/orders')).status).toBe(401);
  });
});

describe('/api/v1/quotations — tenant isolation and shape', () => {
  test("a key only ever sees its own tenant's quotations", async () => {
    const a = await call('GET', '/api/v1/quotations', { key: await currentKey('tenantA') });
    expect(a.status).toBe(200);
    expect(a.body.meta).toMatchObject({ total: 3, page: 1, hasMore: false });
    expect(a.body.data.every(q => q.id.startsWith('T-AAAA-'))).toBe(true);

    const b = await call('GET', '/api/v1/quotations', { key: await currentKey('tenantB') });
    expect(b.body.meta.total).toBe(2);
    expect(b.body.data.every(q => q.id.startsWith('T-BBBB-'))).toBe(true);
  });

  test("another tenant's quotation is a 404 (same as one that doesn't exist)", async () => {
    const key = await currentKey('tenantA');
    const foreign = await call('GET', '/api/v1/quotations/T-BBBB-q1', { key });
    expect([foreign.status, foreign.body.code]).toEqual([404, 'NOT_FOUND']);
    const own = await call('GET', '/api/v1/quotations/101', { key });   // by quotation number
    expect(own.status).toBe(200);
    expect(own.body.data.id).toBe('T-AAAA-q1');
  });

  test('the public shape: POS payment status merged, no raw CRM document', async () => {
    const r = await call('GET', '/api/v1/quotations/T-AAAA-q1', { key: await currentKey('tenantA') });
    const q = r.body.data;
    expect(q).toMatchObject({
      number: '101', title: 'Deal 1',
      status: { approval: 'approved', payment: 'paid' },
      customer: { name: 'Customer 1', company: 'Acme', email: 'c1@example.test' },
      amounts: { currency: 'INR', total: 1000, paid: 1000, balanceDue: 0 },
      payment: { method: 'UPI', paidAt: '2026-10-05T10:00:00.000Z' },
    });
    expect(q.raw).toBeUndefined();
    expect(JSON.stringify(q)).not.toContain('client_details');
  });

  test('pagination, sorting, filters and validation', async () => {
    const key = await currentKey('tenantA');
    const p1 = await call('GET', '/api/v1/quotations?limit=2&sort=amount', { key });
    expect(p1.body.data.map(q => q.amounts.total)).toEqual([1000, 2000]);
    expect(p1.body.meta).toMatchObject({ page: 1, limit: 2, total: 3, pages: 2, hasMore: true });
    const p2 = await call('GET', '/api/v1/quotations?limit=2&page=2&sort=amount', { key });
    expect(p2.body.data.map(q => q.amounts.total)).toEqual([3000]);

    const since = await call('GET', `/api/v1/quotations?updatedSince=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, { key });
    expect(since.body.meta.total).toBe(0);
    await QuoteTracking.updateOne({ tenantId: acct.tenantA._id, quoteId: 'T-AAAA-q1' }, { $set: { notes: 'touched' } });
    const touched = await call('GET', `/api/v1/quotations?updatedSince=${encodeURIComponent(new Date(Date.now() - 5_000).toISOString())}`, { key });
    expect(touched.body.data.map(q => q.id)).toContain('T-AAAA-q1');

    for (const bad of ['limit=500', 'page=0', 'sort=hack', 'createdFrom=yesterday']) {
      const r = await call('GET', `/api/v1/quotations?${bad}`, { key });
      expect([bad, r.status, r.body.code]).toEqual([bad, 422, 'VALIDATION_ERROR']);
    }
  });
});

describe('/api/v1 account state and limits', () => {
  test("a disabled tenant's key stops working, and works again when re-enabled", async () => {
    const key = await currentKey('tenantB');
    await Tenant.updateOne({ _id: acct.tenantB._id }, { isActive: false });
    const r = await call('GET', '/api/v1', { key });
    expect([r.status, r.body.code]).toEqual([403, 'TENANT_INACTIVE']);
    await Tenant.updateOne({ _id: acct.tenantB._id }, { isActive: true });
    expect((await call('GET', '/api/v1', { key })).status).toBe(200);
  });

  test("deleting a tenant revokes its keys", async () => {
    const victim = await mkAccount({ email: 'gone@store.test', tenantId: 'T-GONE', businessName: 'Gone' });
    acct.victim = victim;
    const key = await issueKey('victim');
    const del = await call('DELETE', '/api/admin/tenants/T-GONE', { token: jwtFor(acct.superAdmin) });
    expect(del.status).toBe(200);
    const doc = await ApiKey.findOne({ tenantId: 'T-GONE' }).lean();
    expect(doc).toMatchObject({ status: 'revoked', revokedReason: 'tenant_deleted' });
    expect((await call('GET', '/api/v1', { key })).status).toBe(401);
  });

  test('per-key rate limit → 429 with Retry-After', async () => {
    const key = await currentKey('superAdmin');
    let last;
    for (let i = 0; i < 26; i++) last = await call('GET', '/api/v1', { key });
    expect([last.status, last.body.code]).toEqual([429, 'RATE_LIMITED']);
    expect(last.headers.get('retry-after')).toBeTruthy();
  });

  test('lastUsedAt is recorded', async () => {
    const doc = await ApiKey.findOne({ tenant: acct.tenantA._id, status: 'active' }).lean();
    expect(doc.lastUsedAt).toBeInstanceOf(Date);
  });

  test('no issued key ever reached a log line', () => {
    const logged = [logger.info, logger.warn, logger.error, logger.debug]
      .flatMap(fn => fn.mock.calls.flat().map(String)).join('\n');
    expect(issuedKeys.length).toBeGreaterThan(5);
    for (const k of issuedKeys) expect(logged).not.toContain(k);
    expect(logged).toContain('[ApiKey] rejected');   // rejections ARE logged, by keyId
  });
});

/** The active key issued last for an account (from issuedKeys). */
async function currentKey(who) {
  const active = await ApiKey.findOne({ tenant: acct[who]._id, status: 'active' }).lean();
  const key = issuedKeys.slice().reverse().find(k => k.includes(`_${active.keyId}_`));
  if (!key) throw new Error(`no active key issued for ${who}`);
  return key;
}
