'use strict';

/**
 * Margin calculator jobs API, end to end over HTTP against a throwaway
 * database (TEST_MONGODB_URI, default mongodb://127.0.0.1:27017/FP_margin_test;
 * refuses any database not ending in "_test").
 */

jest.mock('uuid', () => ({ v4: () => require('crypto').randomUUID() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-0123456789abcdef';
process.env.JWT_SECRET = 'test-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789';

const express = require('express');
const mongoose = require('mongoose');
const Tenant = require('../models/tenant');
const MarginJob = require('../models/margin');
const jwt = require('../utils/jwt');
const { invalidateAccountAccess } = require('../utils/accountAccess');

const TEST_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/FP_margin_test';

let server;
let base;
const acct = {};

const buildApp = () => {
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  const router = require('../routes/margin');
  app.use('/api/tenant/margin-jobs', router);
  app.use('/tenant/margin-jobs', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  return app;
};

const tokenFor = (doc, permissions = []) => jwt.generateAccessToken({
  sub: String(doc._id), email: doc.email, role: doc.role, tenantId: doc.tenantId,
  effectiveTenantObjId: String(doc.isSubUser ? acct.tenantA._id : doc._id),
  effectiveTenantId: doc.isSubUser ? doc.parentTenantId : doc.tenantId,
  isSubUser: !!doc.isSubUser, parentTenantId: doc.parentTenantId ?? null, permissions,
});

const call = async (method, path, { token, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
};

const mkAccount = (over) => Tenant.create({
  firstName: 'Test', lastName: 'User', password: 'Str0ng!Passw0rd', isEmailVerified: true,
  isActive: true, setupStep: 'complete', role: 'tenant', ...over,
});

const API = '/api/tenant/margin-jobs';
const simpleJob = (over = {}) => ({
  jobName: 'V-Mart Clothing', gstRate: 18,
  rows: [{ item: 'Tee', qty: 1, unitCost: 100, quoteUnit: 200 }],
  ...over,
});

beforeAll(async () => {
  const dbName = new URL(TEST_URI).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to run against non-test database "${dbName}"`);
  await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.db.dropDatabase();
  await Promise.all([Tenant.syncIndexes(), MarginJob.syncIndexes()]);

  acct.tenantA = await mkAccount({ email: 'a@store.test', tenantId: 'T-AAAA' });
  acct.tenantB = await mkAccount({ email: 'b@store.test', tenantId: 'T-BBBB' });
  acct.viewer = await mkAccount({
    email: 'viewer@store-a.test', tenantId: 'sub-viewer', isSubUser: true, parentTenantId: 'T-AAAA', subUserStatus: 'active',
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

describe('saving recalculates on the server', () => {
  test("a client-sent summary is ignored: cost 100, sold at 200 → 100% margin", async () => {
    const r = await call('POST', API, {
      token: tokenFor(acct.tenantA),
      body: simpleJob({ summary: { grandTotal: 999999, overallMarginPct: 0.99, profitSubtotal: 999999 } }),
    });
    expect(r.status).toBe(201);
    expect(r.body.data.summary).toMatchObject({
      grandTotal: 200, profitSubtotal: 100, marginPct: 1, invoiceTotal: 236,
    });
  });

  test('updates recalculate, junk numbers become 0, and new job fields are stored', async () => {
    const token = tokenFor(acct.tenantA);
    const { body: { data: job } } = await call('POST', API, { token, body: simpleJob({ jobName: 'Edit me' }) });
    const r = await call('PUT', `${API}/${job._id}`, {
      token,
      body: {
        discountPct: 10, otherCost: 20, paymentFeePct: 2, targetPct: 80, priceRounding: 5,
        rows: [{ item: 'Tee', qty: 2, unitCost: 100, quoteUnit: 200 }, { item: 'Junk', qty: -4, unitCost: 'abc', quoteUnit: 50 }],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.rows[1]).toMatchObject({ qty: 0, unitCost: 0, quoteUnit: 50 });
    expect(r.body.data).toMatchObject({ discountPct: 10, otherCost: 20, paymentFeePct: 2, targetPct: 80, priceRounding: 5 });
    // taxable 400 − 10% = 360; invoice 424.80; fee 8.496; all-in 200 + 20 + 8.50
    expect(r.body.data.summary).toMatchObject({ taxableValue: 360, discountAmount: 40, paymentFee: 8.5 });
    expect(r.body.data.summary.netProfit).toBeCloseTo(131.5, 1);
  });

  test('validation: too many rows, a bad status, and an unknown id', async () => {
    const token = tokenFor(acct.tenantA);
    const many = Array.from({ length: 301 }, () => ({ qty: 1, unitCost: 1, quoteUnit: 2 }));
    expect((await call('POST', API, { token, body: simpleJob({ rows: many }) })).status).toBe(422);
    expect((await call('POST', API, { token, body: simpleJob({ status: 'paid' }) })).status).toBe(422);
    expect((await call('GET', `${API}/not-an-id`, { token })).status).toBe(404);
    const missing = await call('GET', `${API}/${new mongoose.Types.ObjectId()}`, { token });
    expect([missing.status, missing.body.message]).toEqual([404, 'Job not found.']);
  });
});

describe('listing, search and stats', () => {
  test('archived jobs stay archived; search matches part of a name', async () => {
    const token = tokenFor(acct.tenantA);
    const { body: { data: arch } } = await call('POST', API, { token, body: simpleJob({ jobName: 'Old Archive Job' }) });
    await call('PATCH', `${API}/${arch._id}/status`, { token, body: { status: 'archived' } });

    const list = await call('GET', API, { token });
    expect(list.body.data.map(j => j.jobName)).not.toContain('Old Archive Job');
    const archived = await call('GET', `${API}?status=archived`, { token });
    expect(archived.body.data.map(j => j.jobName)).toEqual(['Old Archive Job']);

    const search = await call('GET', `${API}?q=mart`, { token });
    expect(search.body.data.map(j => j.jobName)).toContain('V-Mart Clothing');
    const regexSafe = await call('GET', `${API}?q=${encodeURIComponent('V-Mart (')}`, { token });
    expect(regexSafe.status).toBe(200);
  });

  test('stats: margin on cost across active jobs only (weighted, not an average of %)', async () => {
    const token = tokenFor(acct.tenantB);
    // Small job: 100 → 200 (100%); big job: 9000 → 10000 (11.1%). Σ profit ÷ Σ cost = 1100 / 9100.
    await call('POST', API, { token, body: simpleJob({ jobName: 'Small' }) });
    await call('POST', API, { token, body: simpleJob({ jobName: 'Big', rows: [{ qty: 100, unitCost: 90, quoteUnit: 100 }] }) });
    const { body: { data: arch } } = await call('POST', API, { token, body: simpleJob({ jobName: 'Archived huge', rows: [{ qty: 1, unitCost: 1, quoteUnit: 100000 }] }) });
    await call('PATCH', `${API}/${arch._id}/status`, { token, body: { status: 'archived' } });

    const r = await call('GET', `${API}/stats/summary`, { token });
    expect(r.body.data).toMatchObject({ totalJobs: 2, totalRevenue: 10200, totalProfit: 1100, archivedCount: 1 });
    expect(r.body.data.avgMarginPct).toBeCloseTo(1100 / 9100, 4);   // not (1 + 0.111) / 2
  });
});

describe('access', () => {
  test("a tenant can't read or change another tenant's job", async () => {
    const { body: { data: job } } = await call('POST', API, { token: tokenFor(acct.tenantA), body: simpleJob({ jobName: 'Private A' }) });
    const tokenB = tokenFor(acct.tenantB);
    expect((await call('GET', `${API}/${job._id}`, { token: tokenB })).status).toBe(404);
    expect((await call('PUT', `${API}/${job._id}`, { token: tokenB, body: { jobName: 'Hijack' } })).status).toBe(404);
    expect((await MarginJob.findById(job._id)).jobName).toBe('Private A');
  });

  test('a view-only team member can read but not save', async () => {
    const token = tokenFor(acct.viewer, [{ pageKey: 'margin-calculator', actions: ['view'] }]);
    expect((await call('GET', API, { token })).status).toBe(200);
    expect((await call('POST', API, { token, body: simpleJob() })).status).toBe(403);
  });

  test('the legacy /tenant/margin-jobs path still works', async () => {
    expect((await call('GET', '/tenant/margin-jobs', { token: tokenFor(acct.tenantA) })).status).toBe(200);
  });
});
