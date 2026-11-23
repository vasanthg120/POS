'use strict';

/**
 * controllers/apiKeyController.js — Settings → API Integration.
 *
 * Mounted on the /api/tenant router (routes/index.js), so `protect` and
 * `requireTenant` already ran. Only the ACCOUNT OWNER manages keys — the
 * tenant owner, or the Super Admin for its own space. Team members
 * (sub-users) are refused whatever their RBAC permissions: a key can read
 * the whole account's data, so it is an owner-level credential.
 *
 * The full key appears in exactly two responses (generate, regenerate), with
 * Cache-Control: no-store. Status reads never include it.
 */

const Tenant = require('../models/tenant');
const logger = require('../utils/logger');
const {
  getKeyStatus, createKey, regenerateKey, revokeActiveKey,
} = require('../services/apiKey.service');

const INTEGRATION = 'haive';
const BASE_PATH = '/api/v1';

const ok = (res, data, message = 'Success', status = 200) =>
  res.status(status).json({ success: true, message, data });

const fail = (res, status, code, message) =>
  res.status(status).json({ success: false, code, message });

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err?.expose) return fail(res, err.status, err.code, err.message);
    return next(err);
  });

/** Route guard: account owners only (not team members). */
exports.ownerOnly = (req, res, next) => {
  if (req.user?.isSubUser) {
    return fail(res, 403, 'FORBIDDEN', 'Only the account owner can manage API keys.');
  }
  return next();
};

const loadOwner = async (req, res) => {
  const tenant = await Tenant.findById(req.user.id).select('tenantId isSubUser role');
  if (!tenant || tenant.isSubUser) {
    fail(res, 403, 'FORBIDDEN', 'Only the account owner can manage API keys.');
    return null;
  }
  return tenant;
};

const statusPayload = async (tenantObjId) => ({
  ...(await getKeyStatus(tenantObjId, INTEGRATION)),
  integration: INTEGRATION,
  basePath: BASE_PATH,
});

/* GET /api/tenant/integrations/api-key */
exports.getStatus = asyncHandler(async (req, res) => {
  const tenant = await loadOwner(req, res);
  if (!tenant) return;
  return ok(res, await statusPayload(tenant._id));
});

/* POST /api/tenant/integrations/api-key — first key (409 if one is active) */
exports.generate = asyncHandler(async (req, res) => {
  const tenant = await loadOwner(req, res);
  if (!tenant) return;
  const { apiKey } = await createKey({ tenant, actorId: req.user.sub, integration: INTEGRATION });
  logger.info(`[ApiKey] generated for tenant=${tenant.tenantId} by account=${req.user.sub}`);
  res.set('Cache-Control', 'no-store');
  return ok(res, { ...(await statusPayload(tenant._id)), apiKey },
    'API key generated. Copy it now — it will not be shown again.', 201);
});

/* POST /api/tenant/integrations/api-key/regenerate — revoke + new key */
exports.regenerate = asyncHandler(async (req, res) => {
  const tenant = await loadOwner(req, res);
  if (!tenant) return;
  const { apiKey, previousKeyId } = await regenerateKey({ tenant, actorId: req.user.sub, integration: INTEGRATION });
  logger.info(`[ApiKey] regenerated for tenant=${tenant.tenantId} by account=${req.user.sub} (previous keyId=${previousKeyId ?? '-'})`);
  res.set('Cache-Control', 'no-store');
  return ok(res, { ...(await statusPayload(tenant._id)), apiKey },
    previousKeyId
      ? 'New API key generated and the previous key revoked. Update it in Haive now — it will not be shown again.'
      : 'API key generated. Copy it now — it will not be shown again.', 201);
});

/* DELETE /api/tenant/integrations/api-key — revoke */
exports.revoke = asyncHandler(async (req, res) => {
  const tenant = await loadOwner(req, res);
  if (!tenant) return;
  const revoked = await revokeActiveKey({ tenantObjId: tenant._id, actorId: req.user.sub, integration: INTEGRATION });
  if (!revoked) return fail(res, 404, 'NO_ACTIVE_KEY', 'There is no active API key to revoke.');
  logger.info(`[ApiKey] revoked for tenant=${tenant.tenantId} by account=${req.user.sub}`);
  return ok(res, await statusPayload(tenant._id), 'API key revoked. Haive can no longer use it.');
});
