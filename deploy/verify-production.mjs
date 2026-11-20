#!/usr/bin/env node
/**
 * Post-deploy check for the POS app (CRM sync, Tracking, payment routes).
 *
 *   node deploy/verify-production.mjs [baseUrl]            # routing + build checks
 *   POS_TOKEN=<access token> node deploy/verify-production.mjs [baseUrl]
 *                                                          # + CRM data checks for that user
 *
 * baseUrl defaults to https://pos.pantheras.io. POS_TOKEN is the Bearer access
 * token of a logged-in user (DevTools → Network → any /api request →
 * Authorization header, without "Bearer "). It is never printed.
 *
 * What it does — read-only apart from what the app itself does on page load:
 *   - GETs pages, bundles, /api/health and /version.json;
 *   - GETs each non-/api backend path without a token (expects a JSON 401/404,
 *     not the Angular index.html) and POSTs an empty body to
 *     /payments/create-order (rejected by validation before any DB access);
 *   - with POS_TOKEN: GET /api/auth/me, /tenant/quotes/sync-status and
 *     /tenant/quotes (the Tracking page's own request, which may start the
 *     app's normal background CRM refresh).
 * Exit code 1 if any check fails.
 */

const base = (process.argv[2] || 'https://pos.pantheras.io').replace(/\/+$/, '');
const token = process.env.POS_TOKEN || '';
let failures = 0;

const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const info = (msg) => console.log(`  ....  ${msg}`);

async function request(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { Accept: 'application/json, text/plain, */*' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  if (type.includes('application/json')) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
  return { status: res.status, type, text, json, headers: res.headers };
}

const isHtml = (r) => r.type.includes('text/html') || /^\s*</.test(r.text);

async function checkBuilds() {
  console.log('\nBuilds');
  const health = await request('/api/health');
  if (health.json?.success) {
    const started = new Date(Date.now() - health.json.uptime * 1000).toISOString();
    pass(`backend up — environment=${health.json.environment}, commit=${health.json.commit ?? 'not reported (pre-fix build)'}, started ${started}`);
  } else {
    fail(`/api/health did not answer with JSON (HTTP ${health.status})`);
  }

  const index = await request('/');
  info(`frontend index.html Last-Modified: ${index.headers.get('last-modified') ?? 'n/a'}, Cache-Control: ${index.headers.get('cache-control') ?? 'none'}`);
  const version = await request('/version.json');
  info(`frontend /version.json: ${version.json?.commit ?? 'not present (not a Docker build from CI)'}`);

  // Does the live frontend contain the CRM sync UI? Look for its API path in the bundles.
  const scripts = new Set([...index.text.matchAll(/(?:src|href)="((?:main|chunk)-[A-Z0-9]+\.js)"/g)].map(m => m[1]));
  const main = [...scripts].find(s => s.startsWith('main-'));
  if (main) {
    const mainJs = await request(`/${main}`);
    for (const m of mainJs.text.matchAll(/chunk-[A-Z0-9]+\.js/g)) scripts.add(m[0]);
  }
  let hasSyncUi = false;
  for (const s of scripts) {
    const js = await request(`/${s}`);
    if (js.text.includes('/tenant/quotes/sync-status')) { hasSyncUi = true; break; }
  }
  hasSyncUi
    ? pass(`frontend bundle includes the CRM sync UI (${scripts.size} scripts scanned)`)
    : fail(`frontend bundle has no CRM sync UI — an old build is being served (${scripts.size} scripts scanned)`);
}

async function checkRouting() {
  console.log('\nReverse-proxy routing (backend paths must answer JSON, not the Angular page)');
  const apiPaths = [
    ['GET', '/tenant/quotes/sync-status'],
    ['GET', '/tenant/quotes'],
    ['GET', '/tenant/statements/summary'],
    ['GET', '/tenant/royalty'],
    ['GET', '/tenant/margin-jobs'],
    ['GET', '/public/tenant/__route-check__'],
    ['POST', '/payments/create-order'],
  ];
  for (const [method, path] of apiPaths) {
    const r = await request(path, method === 'POST' ? { method, body: {} } : {});
    const label = `${method} ${path} → HTTP ${r.status}`;
    if (r.json) pass(`${label} JSON (reaches the backend)`);
    else fail(`${label} ${isHtml(r) ? 'HTML — served by nginx, not proxied to the backend' : r.type || 'unknown body'}`);
  }

  console.log('\nFrontend pages (must stay with the Angular app)');
  for (const path of ['/tracking', '/settings', '/payments', '/pay/route-check']) {
    const r = await request(path);
    isHtml(r) && r.status === 200
      ? pass(`GET ${path} → Angular page`)
      : fail(`GET ${path} → HTTP ${r.status} ${r.type} (expected the Angular page)`);
  }
}

async function checkCrmData() {
  console.log('\nCRM data for the POS_TOKEN user');
  const me = await request('/api/auth/me', { auth: true });
  if (!me.json?.success) { fail(`/api/auth/me → HTTP ${me.status} ${me.json?.message ?? ''} (token expired?)`); return; }
  const u = me.json.data ?? {};
  info(`user role=${u.role ?? '?'} tenantId=${u.tenantId ?? '?'}${u.isSubUser ? ' (sub-user)' : ''}`);
  if (!u.crm?.isConfigured) { fail('CRM is not configured for this account (crm.isConfigured=false)'); return; }
  pass(`CRM configured — provider=${u.crm.provider ?? 'not set'}`);

  const st = await request('/tenant/quotes/sync-status', { auth: true });
  if (!st.json?.success) {
    fail(`sync-status → HTTP ${st.status} ${isHtml(st) ? 'HTML (not proxied)' : st.json?.message ?? ''}`);
  } else {
    const s = st.json.data;
    const runs = s.lastStats ? `${s.lastStats.fetched} fetched · ${s.lastStats.inserted} new · ${s.lastStats.updated + s.lastStats.restored} updated` : 'no run yet';
    info(`sync status=${s.status} lastSuccessAt=${s.lastSuccessAt ?? 'never'} storedQuotes=${s.storedQuotes ?? '?'} interval=${s.intervalMinutes ?? '?'} min, last run: ${runs}`);
    if (s.lastStatus === 'error') fail(`last sync failed: ${s.lastError}`);
    else if (s.lastSuccessAt) pass('CRM sync has succeeded');
    else info('no successful sync recorded yet — the first Tracking load below performs the initial import');
  }

  const q = await request('/tenant/quotes', { auth: true });
  if (q.json?.success) {
    const quotes = q.json.data?.quotes ?? q.json.data ?? [];
    pass(`/tenant/quotes (Tracking) returned ${Array.isArray(quotes) ? quotes.length : '?'} quotes; sync=${q.json.data?.sync?.status ?? 'n/a'}`);
  } else {
    fail(`/tenant/quotes → HTTP ${q.status} ${isHtml(q) ? 'HTML (not proxied)' : q.json?.message ?? ''}`);
  }
}

console.log(`POS production check — ${base}`);
try {
  await checkBuilds();
  await checkRouting();
  if (token) await checkCrmData();
  else console.log('\n(Set POS_TOKEN to also check the CRM sync status and Tracking data for a user.)');
} catch (err) {
  fail(`check aborted: ${err.message}`);
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
