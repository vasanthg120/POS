'use strict';

/**
 * Tenant Management access control, end to end over HTTP.
 *
 * Mounts the real routers (routes/index.js + the RBAC/member routers app.js
 * mounts) on an in-process server and calls them like the browser would,
 * against a dedicated throwaway MongoDB database (TEST_MONGODB_URI, default
 * mongodb://127.0.0.1:27017/FP_tenant_access_test). Refuses to run against a
 * database whose name doesn't end in "_test". Emails are mocked.
 */

// uuid is ESM-only: Node 22 loads it, Jest's CommonJS loader can't.
jest.mock('uuid', () => ({ v4: () => require('crypto').randomUUID() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/email', () => ({
  sendWelcomeEmail: jest.fn(async () => {}),
  sendSubUserInviteEmail: jest.fn(async () => {}),
  sendMemberAssignedEmail: jest.fn(async () => {}),
  sendVerificationEmail: jest.fn(async () => {}),
  sendPasswordResetEmail: jest.fn(async () => {}),
}));

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-0123456789abcdef';
process.env.JWT_SECRET = 'test-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789';

const express = require('express');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const Tenant = require('../models/tenant');
const RbacRole = require('../models/rbacRole');
const jwt = require('../utils/jwt');
const emailUtil = require('../utils/email');
const logger = require('../utils/logger');
const { seedTenantRoles } = require('../utils/seedTenantRoles');
const { invalidateAccountAccess } = require('../utils/accountAccess');

const TEST_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/FP_tenant_access_test';
const PASSWORD = 'Str0ng!Passw0rd';

let server;
let base;
const acct = {};   // the accounts every test uses
const roles = {};

/* ── App + HTTP helpers ──────────────────────────────────────────────────── */

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/tenant/rbac/roles', require('../routes/rbac.routes'));
  app.use('/api/tenant/members', require('../routes/member.routes'));
  require('../routes/index')(app);
  app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  return app;
};

/** Same claims authController.buildPayload puts in a real login token. */
const tokenFor = async (account, overrides = {}) => {
  const doc = await Tenant.findById(account._id).populate('rbacRoleId', 'permissions');
  let parentId = String(doc._id);
  if (doc.isSubUser) parentId = String((await Tenant.findOne({ tenantId: doc.parentTenantId }))._id);
  return jwt.generateAccessToken({
    sub: String(doc._id),
    email: doc.email,
    role: doc.role,
    tenantId: doc.tenantId,
    effectiveTenantObjId: parentId,
    effectiveTenantId: doc.isSubUser ? doc.parentTenantId : doc.tenantId,
    firstName: doc.firstName,
    lastName: doc.lastName,
    isSubUser: !!doc.isSubUser,
    parentTenantId: doc.parentTenantId ?? null,
    rbacRoleId: doc.rbacRoleId?._id ?? null,
    permissions: doc.isSubUser ? (doc.rbacRoleId?.permissions ?? []).map(p => ({ pageKey: p.pageKey, actions: [...p.actions] })) : [],
    ...overrides,
  });
};

const call = async (method, path, { token, body, cookie } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
};

const mkAccount = (over) => Tenant.create({
  firstName: 'Test', lastName: 'User', password: PASSWORD, isEmailVerified: true,
  isActive: true, setupStep: 'complete', role: 'tenant', ...over,
});

const mkMember = (parent, role, email) => mkAccount({
  email, tenantId: `sub-${email.replace(/[^a-z0-9]/gi, '-')}`, isSubUser: true, parentTenantId: parent.tenantId,
  rbacRoleId: role._id, rbacRoleName: role.name, subUserStatus: 'active',
});

/* ── Fixture ─────────────────────────────────────────────────────────────── */

beforeAll(async () => {
  const dbName = new URL(TEST_URI).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to run against non-test database "${dbName}"`);
  await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.db.dropDatabase();
  await Tenant.syncIndexes();
  await RbacRole.syncIndexes();

  acct.superAdmin = await mkAccount({ email: 'owner@org.test', tenantId: 'SUPERADMIN', role: 'superadmin', firstName: 'Org', lastName: 'Admin' });
  acct.tenantA = await mkAccount({ email: 'a@store.test', tenantId: 'T-AAAA', businessName: 'Store A' });
  acct.tenantB = await mkAccount({ email: 'b@store.test', tenantId: 'T-BBBB', businessName: 'Store B' });
  await Promise.all(['SUPERADMIN', 'T-AAAA', 'T-BBBB'].map(seedTenantRoles));

  roles.aOwner = await RbacRole.findOne({ tenantId: 'T-AAAA', slug: 'owner' });
  roles.bOwner = await RbacRole.findOne({ tenantId: 'T-BBBB', slug: 'owner' });
  // A legacy Super Admin role that was granted "Tenants" before it became
  // ungrantable — inserted raw so no hook strips it.
  const legacy = await RbacRole.collection.insertOne({
    tenantId: 'SUPERADMIN', name: 'Legacy Manager', slug: 'legacy-manager', isSystem: false, memberCount: 1,
    color: '#1e40af', description: '',
    permissions: [{ pageKey: 'tenants', actions: ['view', 'edit'] }, { pageKey: 'dashboard', actions: ['view'] }, { pageKey: 'rbac', actions: ['view', 'edit'] }],
  });
  roles.legacy = await RbacRole.findById(legacy.insertedId);

  acct.saStaff = await mkMember(acct.superAdmin, roles.legacy, 'manager@org.test');
  acct.aStaff = await mkMember(acct.tenantA, roles.aOwner, 'staff@store-a.test');
  acct.bStaff = await mkMember(acct.tenantB, roles.bOwner, 'staff@store-b.test');

  server = buildApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise(r => server.close(r));
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(() => { invalidateAccountAccess(); jest.clearAllMocks(); });

const newTenantBody = (email) => ({ firstName: 'New', lastName: 'Tenant', email, phone: '+919876543210', businessName: 'New Store', city: 'Chennai' });

/* ── Tenant creation ─────────────────────────────────────────────────────── */

describe('creating tenants — Super Admin only', () => {
  test('without a token → 401, nothing created', async () => {
    const r = await call('POST', '/api/admin/tenants', { body: newTenantBody('x1@new.test') });
    expect(r.status).toBe(401);
    expect(await Tenant.exists({ email: 'x1@new.test' })).toBeNull();
  });

  test.each([
    ['a tenant owner', 'tenantA'],
    ["the Super Admin's own staff (even holding a legacy 'tenants' permission)", 'saStaff'],
    ["a tenant's staff", 'aStaff'],
  ])('%s → 403, nothing created', async (_label, who) => {
    const r = await call('POST', '/api/admin/tenants', { token: await tokenFor(acct[who]), body: newTenantBody(`x-${who}@new.test`) });
    expect(r.status).toBe(403);
    expect(await Tenant.exists({ email: `x-${who}@new.test` })).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Super Admin route denied'));
  });

  test("a token that claims 'superadmin' for an account that isn't the Super Admin → 403", async () => {
    // Simulates a stale or tampered claim: the database is the authority.
    const forged = await tokenFor(acct.tenantA, { role: 'superadmin' });
    const r = await call('POST', '/api/admin/tenants', { token: forged, body: newTenantBody('x2@new.test') });
    expect(r.status).toBe(403);
    expect(await Tenant.exists({ email: 'x2@new.test' })).toBeNull();
  });

  test('the Super Admin creates a tenant: role tenant, own isolated space, roles seeded', async () => {
    const r = await call('POST', '/api/admin/tenants', { token: await tokenFor(acct.superAdmin), body: newTenantBody('fresh@new.test') });
    expect(r.status).toBe(201);
    const t = await Tenant.findOne({ email: 'fresh@new.test' });
    expect(t).toMatchObject({ role: 'tenant', isSubUser: false, parentTenantId: null });
    expect(t.tenantId).toMatch(/^T-[0-9A-F]{8}$/);
    expect(await RbacRole.countDocuments({ tenantId: t.tenantId })).toBe(3);
    expect(emailUtil.sendWelcomeEmail).toHaveBeenCalledTimes(1);
  });

  test('a duplicate email (any case) is refused', async () => {
    const r = await call('POST', '/api/admin/tenants', { token: await tokenFor(acct.superAdmin), body: newTenantBody('A@STORE.TEST') });
    expect(r.status).toBe(409);
  });

  test('there is no self-registration endpoint', async () => {
    const r = await call('POST', '/api/auth/register', { body: { ...newTenantBody('self@new.test'), password: PASSWORD, confirmPassword: PASSWORD } });
    expect(r.status).toBe(404);
    expect(await Tenant.exists({ email: 'self@new.test' })).toBeNull();
  });
});

/* ── Managing tenants ────────────────────────────────────────────────────── */

describe('managing tenants — Super Admin only', () => {
  const endpoints = [
    ['GET', '/api/admin/tenants'],
    ['GET', '/api/admin/tenants/T-BBBB'],
    ['GET', '/api/admin/tenants/overview'],
    ['PATCH', '/api/admin/tenants/T-BBBB/status', { isActive: false }],
    ['PATCH', '/api/admin/tenants/T-BBBB', { businessName: 'Hijacked' }],
    ['POST', '/api/admin/tenants/T-BBBB/reset-password'],
    ['DELETE', '/api/admin/tenants/T-BBBB'],
    ['GET', '/api/admin/quotations'],
    ['GET', '/api/admin/billing/tenants'],
  ];

  test.each(['tenantA', 'saStaff', 'aStaff'])('%s is refused on every Tenant Management endpoint', async (who) => {
    const token = await tokenFor(acct[who]);
    for (const [method, path, body] of endpoints) {
      const r = await call(method, path, { token, body });
      expect([method, path, r.status]).toEqual([method, path, 403]);
    }
    const b = await Tenant.findById(acct.tenantB._id);
    expect(b).toMatchObject({ isActive: true, businessName: 'Store B' });
  });

  test('the Super Admin cannot disable or delete itself from Tenant Management (no lockout)', async () => {
    const token = await tokenFor(acct.superAdmin);
    expect((await call('PATCH', '/api/admin/tenants/SUPERADMIN/status', { token, body: { isActive: false } })).status).toBe(403);
    expect((await call('DELETE', '/api/admin/tenants/SUPERADMIN', { token })).status).toBe(403);
    expect((await call('POST', '/api/admin/tenants/SUPERADMIN/reset-password', { token })).status).toBe(403);
    expect((await Tenant.findById(acct.superAdmin._id)).isActive).toBe(true);
  });

  test("Tenant Management does not act on team members (they belong to their tenant)", async () => {
    const token = await tokenFor(acct.superAdmin);
    const r = await call('PATCH', `/api/admin/tenants/${acct.aStaff.tenantId}/status`, { token, body: { isActive: false } });
    expect(r.status).toBe(403);
    expect((await Tenant.findById(acct.aStaff._id)).isActive).toBe(true);
  });

  test('a disabled Super Admin account loses /api/admin even with a valid token', async () => {
    const token = await tokenFor(acct.superAdmin);
    await Tenant.updateOne({ _id: acct.superAdmin._id }, { isActive: false });
    invalidateAccountAccess();
    try {
      const r = await call('GET', '/api/admin/tenants', { token });
      expect(r.status).toBe(403);
    } finally {
      await Tenant.updateOne({ _id: acct.superAdmin._id }, { isActive: true });
    }
  });
});

/* ── Disabling a tenant really cuts access ───────────────────────────────── */

describe('disabling a tenant', () => {
  test('signs out the tenant and its whole team, and blocks login/refresh/API until re-enabled', async () => {
    const ownerToken = await tokenFor(acct.tenantA);
    const staffToken = await tokenFor(acct.aStaff);
    const refresh = jwt.generateRefreshToken({ sub: String(acct.tenantA._id), role: 'tenant' });
    await Tenant.updateOne({ _id: acct.tenantA._id }, { $push: { refreshTokens: { token: refresh } } });
    await Tenant.updateOne({ _id: acct.aStaff._id }, { $push: { refreshTokens: { token: 'staff-session' } } });

    // Both work before.
    expect((await call('GET', '/api/tenant/rbac/roles', { token: ownerToken })).status).toBe(200);
    expect((await call('GET', '/api/tenant/rbac/roles', { token: staffToken })).status).toBe(200);

    const sa = await tokenFor(acct.superAdmin);
    expect((await call('PATCH', '/api/admin/tenants/T-AAAA/status', { token: sa, body: { isActive: false } })).status).toBe(200);

    // Sessions revoked for owner + team.
    const [owner, staff] = await Promise.all([
      Tenant.findById(acct.tenantA._id).select('+refreshTokens'),
      Tenant.findById(acct.aStaff._id).select('+refreshTokens'),
    ]);
    expect(owner.refreshTokens).toHaveLength(0);
    expect(staff.refreshTokens).toHaveLength(0);

    // Still-valid access tokens stop working immediately.
    const o = await call('GET', '/api/tenant/rbac/roles', { token: ownerToken });
    const s = await call('GET', '/api/tenant/rbac/roles', { token: staffToken });
    expect([o.status, o.body.code]).toEqual([403, 'ACCOUNT_DISABLED']);
    expect([s.status, s.body.code]).toEqual([403, 'ACCOUNT_DISABLED']);

    // Refresh is refused even with a refresh token that is on file.
    await Tenant.updateOne({ _id: acct.tenantA._id }, { $push: { refreshTokens: { token: refresh } } });
    const rf = await call('POST', '/api/auth/refresh', { cookie: `refreshToken=${refresh}` });
    expect([rf.status, rf.body.code]).toEqual([403, 'ACCOUNT_DISABLED']);

    // The team can't sign in either (this used to be allowed).
    const login = await call('POST', '/api/auth/login', { body: { email: acct.aStaff.email, password: PASSWORD } });
    expect([login.status, login.body.code]).toEqual([403, 'ACCOUNT_DISABLED']);

    // Re-enable → the team can sign in again.
    expect((await call('PATCH', '/api/admin/tenants/T-AAAA/status', { token: sa, body: { isActive: true } })).status).toBe(200);
    const again = await call('POST', '/api/auth/login', { body: { email: acct.aStaff.email, password: PASSWORD } });
    expect(again.status).toBe(200);
  });
});

/* ── RBAC can never hand out Tenant Management ───────────────────────────── */

describe("the 'tenants' permission is not grantable", () => {
  const withTenants = [{ pageKey: 'tenants', actions: ['view', 'edit'] }, { pageKey: 'dashboard', actions: ['view'] }];

  test.each([['the Super Admin', 'superAdmin'], ['a tenant owner', 'tenantA']])('%s creating a role cannot include it', async (_l, who) => {
    const r = await call('POST', '/api/tenant/rbac/roles', {
      token: await tokenFor(acct[who]), body: { name: `Ops ${who}`, permissions: withTenants },
    });
    expect(r.status).toBe(201);
    const saved = await RbacRole.findById(r.body.data.id).lean();
    expect(saved.permissions.map(p => p.pageKey)).toEqual(['dashboard']);
  });

  test('editing a role cannot add it either', async () => {
    const token = await tokenFor(acct.superAdmin);
    const role = await RbacRole.findOne({ tenantId: 'SUPERADMIN', slug: 'staff' });
    const r = await call('PATCH', `/api/tenant/rbac/roles/${role._id}`, { token, body: { permissions: withTenants } });
    expect(r.status).toBe(200);
    expect((await RbacRole.findById(role._id).lean()).permissions.map(p => p.pageKey)).toEqual(['dashboard']);
  });

  test('a legacy role that still holds it never exposes it (list, login token)', async () => {
    const list = await call('GET', '/api/tenant/rbac/roles', { token: await tokenFor(acct.superAdmin) });
    const legacy = list.body.data.find(r => r.name === 'Legacy Manager');
    expect(legacy.permissions.map(p => p.pageKey)).not.toContain('tenants');

    const login = await call('POST', '/api/auth/login', { body: { email: acct.saStaff.email, password: PASSWORD } });
    expect(login.status).toBe(200);
    expect(login.body.user.permissions.map(p => p.pageKey)).not.toContain('tenants');
    const claims = jwt.verifyAccessToken(login.body.accessToken);
    expect(claims.permissions.map(p => p.pageKey)).not.toContain('tenants');
    expect(claims.role).toBe('tenant');
  });
});

/* ── Isolation + account invariants ──────────────────────────────────────── */

describe('tenant isolation', () => {
  test("a tenant sees and changes only its own team", async () => {
    const token = await tokenFor(acct.tenantA);
    const list = await call('GET', '/api/tenant/members', { token });
    expect(list.status).toBe(200);
    expect(list.body.data.map(m => m.email)).toEqual([acct.aStaff.email]);

    const r = await call('PATCH', `/api/tenant/members/${acct.bStaff._id}/status`, { token, body: { status: 'suspended' } });
    expect(r.status).toBe(404);
    expect((await Tenant.findById(acct.bStaff._id)).subUserStatus).toBe('active');
  });

  test("a tenant can't pull the Super Admin account into its team", async () => {
    const r = await call('POST', '/api/tenant/members/assign', {
      token: await tokenFor(acct.tenantA), body: { email: acct.superAdmin.email, roleId: String(roles.aOwner._id) },
    });
    expect(r.status).toBe(403);
    expect(await Tenant.countDocuments({ email: acct.superAdmin.email })).toBe(1);
  });
});

describe('account invariants (database level)', () => {
  test('a second Super Admin cannot exist', async () => {
    await expect(mkAccount({ email: 'second@org.test', tenantId: 'SUPERADMIN-2', role: 'superadmin' }))
      .rejects.toMatchObject({ code: 11000 });
  });

  test('a team member can never hold the superadmin role', async () => {
    await expect(mkAccount({
      email: 'sneaky@org.test', tenantId: 'sub-sneaky', role: 'superadmin', isSubUser: true, parentTenantId: 'T-AAAA',
    })).rejects.toThrow(/team member/i);
  });
});
