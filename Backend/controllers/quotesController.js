'use strict';

const Tenant = require('../models/tenant');
const logger = require('../utils/logger');

// ── Helper: fetch from ProspectConnect ───────────────────────────────────────
const fetchProspectConnect = async (apiKey, { limit = 200, search = '', startAfter = 0 } = {}) => {
  const res = await fetch('https://api.prospectconnect.ai/quotes/getQuotes', {
    method : 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body   : JSON.stringify({ limit, search, startAfter }),
    signal : AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ProspectConnect ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data?.quotes ?? data?.data ?? (Array.isArray(data) ? data : []);
};

// ── Helper: fetch all pages ───────────────────────────────────────────────────
const fetchAllQuotes = async (apiKey, search = '') => {
  if (search) {
    return fetchProspectConnect(apiKey, { limit: 200, search, startAfter: 0 });
  }

  let all = [];
  let cursor = 0;
  let safety = 15; // max 3000 quotes

  while (safety-- > 0) {
    const page = await fetchProspectConnect(apiKey, { limit: 200, search: '', startAfter: cursor });
    if (!page.length) break;
    all = all.concat(page);
    if (page.length < 200) break;
    cursor += 200;
  }

  return all;
};

// ── GET /tenant/quotes ────────────────────────────────────────────────────────
exports.getQuotes = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.id).select('+crm.apiKey');
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

    if (!tenant.crm.isConfigured) {
      return res.status(400).json({ success: false, code: 'CRM_NOT_CONFIGURED', message: 'CRM is not configured. Please add your CRM credentials in Settings.' });
    }

    const apiKey = tenant.getCRMKey();
    if (!apiKey) {
      return res.status(500).json({ success: false, message: 'CRM key could not be decrypted.' });
    }

    const search = String(req.query.search || '').trim();
    const quotes = await fetchAllQuotes(apiKey, search);

    logger.info(`[Quotes] ${tenant.email} fetched ${quotes.length} quotes`);
    return res.status(200).json({ success: true, data: quotes, quotes, total: quotes.length });
  } catch (err) {
    logger.error(`[Quotes.get] ${err.message}`);
    return res.status(500).json({ success: false, message: err.message || 'Failed to fetch quotes.' });
  }
};

// ── GET /tenant/quotes/:quoteId ───────────────────────────────────────────────
exports.getQuote = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.id).select('+crm.apiKey');
    if (!tenant || !tenant.crm.isConfigured) {
      return res.status(400).json({ success: false, message: 'CRM not configured.' });
    }

    const apiKey   = tenant.getCRMKey();
    const quoteId  = req.params.quoteId;
    const quotes   = await fetchProspectConnect(apiKey, { limit: 25, search: quoteId, startAfter: 0 });
    const decoded  = (() => { try { return decodeURIComponent(quoteId); } catch { return quoteId; } })();

    const quote = quotes.find(q =>
      q._id === quoteId || q._id === decoded ||
      String(q.ticket_number) === quoteId ||
      String(q.ticket_number) === decoded ||
      q.id === quoteId
    );

    if (!quote) {
      return res.status(404).json({ success: false, message: `Quote "${quoteId}" not found.` });
    }

    const clientDetails = quote.client_details ?? {};
    const contactDetail = quote.contact_detail ?? {};

    const sanitised = {
      quoteId      : quote._id ?? quote.id ?? quoteId,
      quotationNo  : String(quote.ticket_number ?? quoteId),
      customerName : clientDetails.name ?? clientDetails.fullName ?? contactDetail.name ?? '',
      customerEmail: clientDetails.email ?? contactDetail.email ?? '',
      customerPhone: clientDetails.phone ?? contactDetail.phone ?? '',
      amount       : quote.quote_amount ?? quote.total ?? 0,
      status       : quote.quote_status ?? quote.status ?? '',
      raw          : quote,
    };

    return res.status(200).json({ success: true, data: { quote: sanitised } });
  } catch (err) {
    logger.error(`[Quotes.getOne] ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── SEARCH (for tracking page) ─────────────────────────────────────────────
exports.search = async (req, res) => {
  try {
    const q   = String(req.query.q || '').trim();
    const key = req.user ? await getTenantCRMKey(req.user.tenantId) : null;

    if (!q) return res.status(400).json({ success: false, message: 'Search query required.' });
    if (!key) return res.status(400).json({ success: false, message: 'CRM not configured.' });

    const upstream = await fetch('https://api.prospectconnect.ai/quotes/getQuotes', {
      method : 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body   : JSON.stringify({ limit: 25, search: q, startAfter: 0 }),
    });
    const data = await upstream.json();
    const quotes = data?.quotes ?? data?.data ?? [];

    return res.json({ success: true, data: quotes });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// helper to get decrypted CRM key for tenant
async function getTenantCRMKey(tenantId) {
  try {
    const Tenant = require('../models/tenant');
    const t = await Tenant.findOne({ tenantId }).select('+crm.apiKey');
    if (!t || !t.crm?.isConfigured) return null;
    return t.getCRMKey();
  } catch { return null; }
}