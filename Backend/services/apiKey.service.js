'use strict';

/**
 * services/apiKey.service.js
 *
 * Generation, verification and lifecycle of integration API keys
 * (models/apiKey.js). Used by the Settings → API Integration endpoints
 * (controllers/apiKeyController.js) and the /api/v1 auth middleware
 * (middleware/requireApiKey.js).
 *
 * Key format:  pos_<env>_<keyId>_<secret>
 *   env    live | test   (informational: which kind of deployment issued it)
 *   keyId  16 hex chars  (public; indexes the record — safe to log)
 *   secret 43 chars      (32 random bytes, base64url — never stored or logged)
 *
 * Only SHA-256(full key) is stored. The secret is 256 bits of CSPRNG output,
 * so a fast hash is the right tool here (a slow password hash adds nothing
 * against brute force and would cost on every API call); comparison is
 * constant-time.
 */

const crypto = require('crypto');
const ApiKey = require('../models/apiKey');
const logger = require('../utils/logger');

const KEY_PATTERN = /^pos_(live|test)_([a-f0-9]{16})_([A-Za-z0-9_-]{43})$/;

/**
 * Scopes a new key gets. 'read' = read access to every resource of the
 * integration API, including resources added in later releases, so Haive
 * keeps working as the API grows without a key rotation. Write scopes
 * (e.g. 'orders:write') will have to be granted explicitly.
 */
const DEFAULT_SCOPES = ['read'];

const USAGE_WRITE_INTERVAL_MS = 60_000;

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const keyEnvironment = () => (process.env.NODE_ENV === 'production' ? 'live' : 'test');

const serviceError = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });

/** A new random key and the values stored for it. */
const mintKey = () => {
  const env = keyEnvironment();
  const keyId = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');   // 43 chars
  const key = `pos_${env}_${keyId}_${secret}`;
  return { key, keyId, hash: sha256(key), prefix: `pos_${env}_${keyId}`, last4: secret.slice(-4) };
};

/** What the Settings page may see about a key — never the key or its hash. */
const publicView = (doc) => (doc ? {
  id:            String(doc._id),
  keyId:         doc.keyId,
  name:          doc.name,
  integration:   doc.integration,
  status:        doc.status,
  maskedKey:     `${doc.prefix}_${'•'.repeat(12)}${doc.last4}`,
  scopes:        doc.scopes ?? [],
  createdAt:     doc.createdAt ?? null,
  lastUsedAt:    doc.lastUsedAt ?? null,
  revokedAt:     doc.revokedAt ?? null,
  revokedReason: doc.revokedReason ?? null,
} : null);

/**
 * The tenant's key state for one integration:
 *   { status: 'active' | 'revoked' | 'none', key: publicView | null }
 * 'revoked' shows the most recent (revoked) key so the page can say when.
 */
const getKeyStatus = async (tenantObjId, integration = 'haive') => {
  const active = await ApiKey.findOne({ tenant: tenantObjId, integration, status: 'active' }).lean();
  if (active) return { status: 'active', key: publicView(active) };
  const latest = await ApiKey.findOne({ tenant: tenantObjId, integration }).sort({ createdAt: -1 }).lean();
  return { status: latest ? 'revoked' : 'none', key: publicView(latest) };
};

/**
 * Creates the tenant's key. Fails with 409 API_KEY_EXISTS when an active key
 * already exists (the partial unique index makes that race-safe).
 * Returns { apiKey, key } — `apiKey` is the full key, returned this once.
 */
const createKey = async ({ tenant, actorId, integration = 'haive', name }) => {
  const minted = mintKey();
  try {
    const doc = await ApiKey.create({
      tenant: tenant._id,
      tenantId: tenant.tenantId,
      integration,
      ...(name ? { name } : {}),
      keyId: minted.keyId,
      prefix: minted.prefix,
      last4: minted.last4,
      hash: minted.hash,
      scopes: DEFAULT_SCOPES,
      createdBy: actorId,
    });
    logger.info(`[ApiKey] created keyId=${minted.keyId} tenant=${tenant.tenantId} integration=${integration}`);
    return { apiKey: minted.key, key: publicView(doc) };
  } catch (err) {
    if (err?.code === 11000) {
      throw serviceError(409, 'API_KEY_EXISTS', 'An API key is already active. Regenerate it or revoke it first.');
    }
    throw err;
  }
};

/** Revokes the tenant's active key, if any. Returns the revoked document or null. */
const revokeActiveKey = async ({ tenantObjId, actorId, integration = 'haive', reason = 'revoked' }) => {
  const doc = await ApiKey.findOneAndUpdate(
    { tenant: tenantObjId, integration, status: 'active' },
    { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: actorId ?? null, revokedReason: reason } },
    { new: true },
  ).lean();
  if (doc) logger.info(`[ApiKey] revoked keyId=${doc.keyId} tenant=${doc.tenantId} reason=${reason}`);
  return doc;
};

/**
 * Regenerate = revoke the active key, then issue a new one. The old key stops
 * working before the new one exists, so there is never a moment with two.
 */
const regenerateKey = async ({ tenant, actorId, integration = 'haive' }) => {
  const previous = await revokeActiveKey({ tenantObjId: tenant._id, actorId, integration, reason: 'regenerated' });
  const created = await createKey({ tenant, actorId, integration, name: previous?.name });
  return { ...created, previousKeyId: previous?.keyId ?? null };
};

/** Revokes every active key of a tenant (used when the tenant is deleted). */
const revokeAllForTenant = async (tenantObjId, { actorId = null, reason = 'tenant_deleted' } = {}) => {
  const r = await ApiKey.updateMany(
    { tenant: tenantObjId, status: 'active' },
    { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: actorId, revokedReason: reason } },
  );
  return r.modifiedCount ?? 0;
};

/**
 * Checks a presented key. Returns { key } (lean doc, no hash) when it is a
 * known, active key, else { error, keyId } with error one of
 * 'malformed' | 'unknown' | 'mismatch' | 'revoked'. 'revoked' is only
 * reported once the secret matched, so it reveals nothing to a guesser.
 */
const verifyApiKey = async (presented) => {
  const match = KEY_PATTERN.exec(typeof presented === 'string' ? presented : '');
  if (!match) return { error: 'malformed', keyId: null };
  const keyId = match[2];

  const doc = await ApiKey.findOne({ keyId }).select('+hash').lean();
  if (!doc) return { error: 'unknown', keyId };

  const given = Buffer.from(sha256(presented), 'hex');
  const stored = Buffer.from(doc.hash, 'hex');
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return { error: 'mismatch', keyId };

  delete doc.hash;
  if (doc.status !== 'active') return { error: 'revoked', keyId };
  return { key: doc };
};

/** Stamps lastUsedAt, at most once a minute per key. Never throws. */
const recordUsage = (keyDoc) => {
  const cutoff = new Date(Date.now() - USAGE_WRITE_INTERVAL_MS);
  if (keyDoc.lastUsedAt && new Date(keyDoc.lastUsedAt) > cutoff) return;
  ApiKey.updateOne(
    { _id: keyDoc._id, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lt: cutoff } }] },
    { $set: { lastUsedAt: new Date() } },
  ).catch(err => logger.warn(`[ApiKey] could not record usage for keyId=${keyDoc.keyId}: ${err.message}`));
};

/** True when the key's scopes allow `scope` (e.g. 'quotations:read'). */
const hasScope = (scopes, scope) => {
  const list = Array.isArray(scopes) ? scopes : [];
  if (list.includes(scope)) return true;
  return scope.endsWith(':read') && list.includes('read');
};

module.exports = {
  KEY_PATTERN,
  DEFAULT_SCOPES,
  getKeyStatus,
  createKey,
  regenerateKey,
  revokeActiveKey,
  revokeAllForTenant,
  verifyApiKey,
  recordUsage,
  hasScope,
  publicView,
  _internal: { mintKey, sha256 },
};
