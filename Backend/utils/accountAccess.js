'use strict';

/**
 * utils/accountAccess.js
 *
 * One answer to "may this account use the POS right now?", shared by login,
 * token refresh and the per-request `protect` middleware so the three can
 * never disagree.
 *
 * Before this, login checked isActive/billingSuspended but refresh did not,
 * and nothing checked a sub-user's owning tenant — so disabling a tenant in
 * Tenant Management left the owner signed in (refresh kept minting tokens)
 * and let every team member of that tenant keep logging in.
 *
 * Also defines the RBAC page keys no role may ever grant: tenant management
 * belongs to the organisation Super Admin account alone.
 */

const Tenant = require('../models/tenant');

/** tenantId of the organisation Super Admin's own space (see utils/seedSuperAdmin.js). */
const SUPERADMIN_TENANT_ID = 'SUPERADMIN';

/**
 * Page keys that are never grantable through RBAC — not by a tenant, and not
 * by the Super Admin to its own staff. Only the Super Admin account itself
 * (role 'superadmin', not a sub-user) reaches Tenant Management.
 */
const RESERVED_PAGE_KEYS = new Set(['tenants']);

const stripReservedPermissions = (permissions) =>
  (Array.isArray(permissions) ? permissions : [])
    .filter(p => p && !RESERVED_PAGE_KEYS.has(p.pageKey));

const DENIED = {
  notFound:    { status: 401, code: 'ACCOUNT_NOT_FOUND',  message: 'This account no longer exists. Contact your administrator.' },
  disabled:    { status: 403, code: 'ACCOUNT_DISABLED',   message: 'Your account has been disabled.' },
  orgDisabled: { status: 403, code: 'ACCOUNT_DISABLED',   message: 'Your organisation’s account has been disabled. Contact your administrator.' },
  billing:     { status: 403, code: 'BILLING_SUSPENDED',  message: 'Your subscription payment is overdue. Please contact the platform admin to resume access.' },
  suspended:   { status: 403, code: 'ACCOUNT_SUSPENDED',  message: 'Your access has been suspended. Contact your administrator.' },
};

/** Fields accountAccessProblem() reads — select at least these. */
const ACCESS_FIELDS = 'role isActive billingSuspended isSubUser subUserStatus parentTenantId tenantId';

/**
 * null when the account may use the app, otherwise { status, code, message }.
 * A sub-user is also refused when its owning tenant is missing, disabled or
 * billing-suspended: disabling a tenant locks out all of its users.
 *
 * @param account  Tenant document / lean object with ACCESS_FIELDS
 */
const accountAccessProblem = async (account) => {
  if (!account) return DENIED.notFound;

  if (account.isSubUser) {
    if (account.subUserStatus === 'suspended') return DENIED.suspended;
    if (account.isActive === false) return DENIED.disabled;

    const parent = account.parentTenantId
      ? await Tenant.findOne({ tenantId: account.parentTenantId, isSubUser: { $ne: true } })
        .select('isActive billingSuspended').lean()
      : null;
    if (!parent) return DENIED.orgDisabled;
    if (parent.isActive === false) return DENIED.orgDisabled;
    if (parent.billingSuspended) return DENIED.billing;
    return null;
  }

  if (account.isActive === false) return DENIED.disabled;
  if (account.billingSuspended) return DENIED.billing;
  return null;
};

/* ── Short per-process cache for the per-request check ─────────────────────
   `protect` runs on every API call; a 15-second cache keeps that to about one
   lookup per user per 15s. Anything in this process that changes access
   (tenant disable/delete, member suspend/remove, billing suspension) calls
   invalidateAccountAccess(), so a single-instance deployment sees changes at
   once; other instances within CACHE_MS. Login and refresh never use the cache. */

const CACHE_MS = 15_000;
const cache = new Map(); // String(_id) -> { at, result: { account, problem } }

/**
 * Cached account + access verdict for the per-request check.
 * Returns { account, problem } where account is a lean object (or null).
 */
const checkAccountAccess = async (accountId) => {
  const key = String(accountId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const account = await Tenant.findById(accountId).select(ACCESS_FIELDS).lean();
  const result = { account, problem: await accountAccessProblem(account) };
  cache.set(key, { at: Date.now(), result });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return result;
};

/** Drops cached verdicts — all of them, or only the given account ids. */
const invalidateAccountAccess = (ids) => {
  if (!ids) { cache.clear(); return; }
  for (const id of [].concat(ids)) cache.delete(String(id));
};

module.exports = {
  SUPERADMIN_TENANT_ID,
  RESERVED_PAGE_KEYS,
  ACCESS_FIELDS,
  stripReservedPermissions,
  accountAccessProblem,
  checkAccountAccess,
  invalidateAccountAccess,
};
