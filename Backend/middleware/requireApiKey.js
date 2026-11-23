'use strict';

/**
 * Authenticates calls to the integration API (/api/v1) with an API key from
 * Settings → API Integration, and scopes the request to that key's tenant.
 *
 * Accepted:   Authorization: Bearer <key>   or   X-API-Key: <key>
 * Refused:    a key in the URL query string (it would end up in proxy and
 *             access logs) — the request is rejected before any lookup.
 *
 * Sets req.integration = { keyId, keyObjId, scopes, tenant: { _id, tenantId, ... } }.
 * Every data handler must read only req.integration.tenant's data.
 *
 * Logs record the public keyId and the reason for a rejection — never the
 * key itself.
 */

const Tenant = require('../models/tenant');
const logger = require('../utils/logger');
const { verifyApiKey, recordUsage, hasScope } = require('../services/apiKey.service');
const { accountAccessProblem, ACCESS_FIELDS } = require('../utils/accountAccess');

const URL_KEY_PARAMS = ['api_key', 'apikey', 'api-key', 'apiKey', 'key', 'token', 'access_token'];

const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });

const presentedKey = (req) => {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const header = req.headers['x-api-key'];
  return typeof header === 'string' ? header.trim() : null;
};

const requireApiKey = async (req, res, next) => {
  try {
    if (URL_KEY_PARAMS.some(p => Object.prototype.hasOwnProperty.call(req.query, p))) {
      return fail(res, 400, 'API_KEY_IN_URL',
        'Do not put the API key in the URL. Send it in the Authorization header (Bearer) or in X-API-Key.');
    }

    const raw = presentedKey(req);
    if (!raw) {
      return fail(res, 401, 'API_KEY_MISSING',
        'API key required. Send it in the Authorization header (Bearer) or in X-API-Key.');
    }

    const { key, error, keyId } = await verifyApiKey(raw);
    if (error) {
      logger.warn(`[ApiKey] rejected ${req.method} ${req.originalUrl.split('?')[0]} reason=${error} keyId=${keyId ?? '-'} ip=${req.ip}`);
      return error === 'revoked'
        ? fail(res, 401, 'API_KEY_REVOKED', 'This API key has been revoked. Generate a new one in POS Settings → API Integration.')
        : fail(res, 401, 'INVALID_API_KEY', 'Invalid API key.');
    }

    // The owning account must still be allowed to use the POS: a disabled or
    // billing-suspended tenant's key stops working with it.
    const tenant = await Tenant.findById(key.tenant)
      .select(`${ACCESS_FIELDS} businessName currency timezone`).lean();
    const problem = tenant?.isSubUser
      ? { status: 403, code: 'ACCOUNT_DISABLED' }
      : await accountAccessProblem(tenant);
    if (problem) {
      logger.warn(`[ApiKey] keyId=${key.keyId} refused: tenant ${key.tenantId} ${problem.code}`);
      return fail(res, problem.status === 401 ? 401 : 403, 'TENANT_INACTIVE',
        'The POS account this API key belongs to is not active.');
    }

    req.integration = {
      keyId: key.keyId,
      keyObjId: key._id,
      scopes: key.scopes ?? [],
      tenant,
    };
    recordUsage(key);
    return next();
  } catch (err) {
    return next(err);
  }
};

/** Route guard: the key must carry `scope` (e.g. 'quotations:read'). */
const requireScope = (scope) => (req, res, next) => {
  if (hasScope(req.integration?.scopes, scope)) return next();
  return fail(res, 403, 'INSUFFICIENT_SCOPE', `This API key does not have the "${scope}" scope.`);
};

module.exports = { requireApiKey, requireScope };
