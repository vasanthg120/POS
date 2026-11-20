'use strict';

/**
 * Runs a CRM → MongoDB sync from the command line and prints the result.
 *
 *   npm run crm:sync                 # every account with a CRM connection
 *   npm run crm:sync -- T-1234       # one account, by tenantId
 *
 * Uses the same .env / .env.production selection as app.js. Prints counts
 * and status only — never API keys or customer data.
 */

const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '..', process.env.NODE_ENV === 'production' ? '.env.production' : '.env'),
});

const mongoose = require('mongoose');
const Tenant = require('../models/tenant');
const { syncTenant, syncAllTenants, getSyncStatus } = require('../services/crmSync.service');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  const onlyTenantId = process.argv[2];

  const tenants = onlyTenantId
    ? await Tenant.find({ tenantId: onlyTenantId }).select('+crm.apiKey')
    : null;

  if (onlyTenantId) {
    if (!tenants.length) throw new Error(`No account with tenantId "${onlyTenantId}".`);
    const t = tenants[0];
    if (!t.crm?.isConfigured) throw new Error(`Account "${onlyTenantId}" has no CRM connected.`);
    const r = await syncTenant(t, { trigger: 'cli', apiKey: t.getCRMKey() || undefined });
    console.log(JSON.stringify({ tenantId: onlyTenantId, status: r.status, error: r.error, stats: r.stats, issues: r.issues, durationMs: r.durationMs }, null, 2));
  } else {
    console.log(JSON.stringify(await syncAllTenants({ trigger: 'cli' }), null, 2));
  }

  const all = await Tenant.find({ 'crm.isConfigured': true, isSubUser: { $ne: true } }).select('tenantId role');
  for (const t of all) {
    const s = await getSyncStatus(t._id);
    console.log(`${t.tenantId} (${t.role}): status=${s.status} storedQuotes=${s.storedQuotes} lastSuccessAt=${s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : '-'}${s.lastError ? ` lastError="${s.lastError}"` : ''}`);
  }

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(`CRM sync failed: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
