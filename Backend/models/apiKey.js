'use strict';

/**
 * models/apiKey.js
 *
 * API keys that external systems (first: the Haive AI Agent) use to call the
 * POS integration API (/api/v1). Each key belongs to exactly one tenant
 * account and only ever reads that tenant's data.
 *
 * The key itself is NEVER stored: only its SHA-256 hash (select: false) plus
 * a public `keyId` used to look the record up and the last 4 characters for
 * display. The full key is shown to the user once, when it is generated.
 *
 * Keys are not deleted when revoked or regenerated — they stay as history
 * with status 'revoked', so "when did this stop working and who did it" is
 * always answerable.
 */

const mongoose = require('mongoose');

const API_KEY_STATUSES = ['active', 'revoked'];
const REVOKE_REASONS = ['revoked', 'regenerated', 'tenant_deleted'];

const apiKeySchema = new mongoose.Schema({
  // Owning account (tenant owner or the Super Admin's own space).
  tenant:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  tenantId: { type: String, required: true },

  // Which integration this key is for. One active key per tenant+integration.
  integration: { type: String, required: true, default: 'haive', enum: ['haive'] },
  name:        { type: String, trim: true, maxlength: 60, default: 'Haive AI Agent' },

  // Public, non-secret identifier embedded in the key (pos_live_<keyId>_…).
  keyId:  { type: String, required: true, unique: true },
  // Display only, e.g. "pos_live_1a2b3c4d5e6f7a8b_…x9Yz".
  prefix: { type: String, required: true },
  last4:  { type: String, required: true },
  // SHA-256 (hex) of the full key. Never selected unless asked for.
  hash:   { type: String, required: true, select: false },

  // What the key may read. Checked per route (middleware/requireApiKey.js).
  scopes: { type: [String], default: [] },

  status:        { type: String, enum: API_KEY_STATUSES, default: 'active' },
  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  revokedAt:     { type: Date, default: null },
  revokedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null },
  revokedReason: { type: String, enum: [...REVOKE_REASONS, null], default: null },

  // Last successful use (written at most once a minute per key — see
  // services/apiKey.service.js recordUsage).
  lastUsedAt: { type: Date, default: null },
}, {
  timestamps: true,
  toJSON: {
    transform(_doc, ret) { delete ret.hash; delete ret.__v; return ret; },
  },
});

// At most one ACTIVE key per tenant and integration, enforced by the database.
apiKeySchema.index(
  { tenant: 1, integration: 1 },
  { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_key_per_tenant' },
);
apiKeySchema.index({ tenant: 1, createdAt: -1 });

const ApiKey = mongoose.model('ApiKey', apiKeySchema);

ApiKey.on('index', (err) => {
  if (err) require('../utils/logger').error(`[ApiKey] Index build failed: ${err.message}`);
});

module.exports = ApiKey;
module.exports.API_KEY_STATUSES = API_KEY_STATUSES;
