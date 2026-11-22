'use strict';
/**
 * routes/payment-page.public.routes.js
 *
 * PUBLIC endpoints — no auth required.
 *
 * Mount in server.js BEFORE registerRoutes(app):
 *   const paymentPagePublic = require('./routes/payment-page.public.routes');
 *   app.use('/public', paymentPagePublic);
 *
 * Exposes:
 *   GET  /public/tenant/:slug          → tenant branding (safe fields only)
 *   GET  /public/quotes?search=&slug=  → CRM proxy (credentials stay server-side)
 */

const express = require('express');
const router  = express.Router();

// ── ProspectConnect API endpoint (same as crm.quotes.controller.js) ───────────
const PC_API = 'https://api.prospectconnect.ai/quotes/getQuotes';

// ── Lazy-load Tenant model so this file can be required before mongoose connects
const getTenant = () => require('../models/tenant');
const { escapeRegex } = require('../utils/validation');

// ── Helper: find tenant by payment-page slug OR city
//    NOT .lean() — we need the model instance so getCRMKey() works
async function tenantBySlug(slug) {
  const Tenant = getTenant();
  return Tenant.findOne({
    $or: [
      { paymentPageSlug: slug },
      { city: { $regex: new RegExp(`^${escapeRegex(slug)}$`, 'i') } },
    ],
  // Force-include whichever encrypted key field the schema marks select:false
  }).select('+crm.encryptedApiKey +crm.apiKey +crm.key');
}

// ─── GET /public/quotes?search=22&slug=fp-cc441b ─────────────────────────────
// ⚠️  MUST be registered BEFORE /tenant/:slug — Express would otherwise
//     match the literal string "quotes" as a :slug param.
router.get('/quotes', async (req, res, next) => {
  try {
    const { search = '', slug = '', limit = 25, startAfter = 0 } = req.query;

    console.log('[public/quotes] params:', { search, slug, limit, startAfter });

    if (!search.toString().trim())
      return res.status(400).json({ success: false, message: 'search param is required.' });

    if (!slug.toString().trim())
      return res.status(400).json({ success: false, message: 'slug param is required.' });

    const tenant = await tenantBySlug(slug.toString().trim());
    console.log('[public/quotes] tenant found:', tenant ? tenant._id : 'NOT FOUND');

    if (!tenant)
      return res.status(404).json({ success: false, message: 'Payment page not found. Slug: ' + slug });

    console.log('[public/quotes] tenant.crm:', JSON.stringify(tenant.crm, null, 2));
    console.log('[public/quotes] tenant.paymentPageSlug:', tenant.paymentPageSlug);
    console.log('[public/quotes] tenant.city:', tenant.city);

    if (!tenant.crm?.isConfigured)
      return res.status(422).json({
        success: false,
        message: 'CRM not configured for this tenant.',
        debug  : { crmBlock: tenant.crm },
      });

    // ── Use the model's getCRMKey() method — same as crm.quotes.controller.js ──
    //    This handles decryption correctly regardless of which field stores the key.
    const apiKey = tenant.getCRMKey();

    console.log('[public/quotes] apiKey present:', !!apiKey, '| length:', apiKey?.length);

    if (!apiKey)
      return res.status(422).json({
        success: false,
        message: 'CRM API key could not be decrypted. Please re-save CRM credentials in Settings.',
        debug  : { crmKeys: Object.keys(tenant.crm || {}) },
      });

    // ── Always use the ProspectConnect API directly (stored apiUrl is the
    //    dashboard UI URL, not the API base — don't use it for fetch) ──────────
    console.log('[public/quotes] fetching:', PC_API);

    const crmRes = await fetch(PC_API, {
      method : 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        limit     : Number(limit),
        search    : search.toString().trim(),
        startAfter: Number(startAfter),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    console.log('[public/quotes] CRM status:', crmRes.status);

    if (!crmRes.ok) {
      const text = await crmRes.text().catch(() => '');
      console.log('[public/quotes] CRM error body:', text.slice(0, 500));
      return res.status(502).json({
        success: false,
        message: `CRM returned ${crmRes.status}`,
        detail : text.slice(0, 300),
      });
    }

    const crmData = await crmRes.json();
    console.log('[public/quotes] CRM response keys:', Object.keys(crmData ?? {}));

    // Normalise to the same shape the authenticated controller uses
    const raw    = crmData?.quotes ?? crmData?.data ?? (Array.isArray(crmData) ? crmData : []);
    console.log('[public/quotes] quotes count:', Array.isArray(raw) ? raw.length : 'not an array');

    // Map to the shape expected by the Angular front-end (QuotePreview)
    const quotes = Array.isArray(raw) ? raw.map(q => {
      const client  = q.client_details ?? {};
      const contact = q.contact_detail ?? {};
      return {
        quotationNo  : q.ticket_number  ?? q._id          ?? q.id          ?? '',
        customerName : client.name      ?? client.fullName ?? contact.name  ?? q.customerName ?? '',
        customerEmail: client.email     ?? contact.email   ?? q.customerEmail ?? '',
        customerPhone: client.phone     ?? contact.phone   ?? q.customerPhone ?? '',
        amount       : parseFloat(q.quote_amount ?? q.amount ?? 0) || 0,
        status       : q.quote_status   ?? q.status        ?? '',
        notes        : q.notes          ?? '',
      };
    }) : [];

    res.json({ success: true, data: quotes });

  } catch (err) {
    console.error('[public/quotes] EXCEPTION:', err.message, err.stack);
    next(err);
  }
});

// ─── GET /public/tenant/:slug ─────────────────────────────────────────────────
// Safe branding info — never exposes keys or secrets.
router.get('/tenant/:slug', async (req, res, next) => {
  try {
    // .lean() is fine here — we only need plain fields, no model methods
    const Tenant = getTenant();
    const tenant = await Tenant.findOne({
      $or: [
        { paymentPageSlug: req.params.slug },
        { city: { $regex: new RegExp(`^${escapeRegex(req.params.slug)}$`, 'i') } },
      ],
    }).lean();

    if (!tenant)
      return res.status(404).json({ success: false, message: 'Payment page not found.' });

    res.json({
      success: true,
      data: {
        businessName   : tenant.businessName    || 'Secure Payment',
        businessAddress: tenant.businessAddress || '',
        city           : tenant.city            || '',
        currency       : tenant.currency        || 'INR',
        gstNumber      : tenant.gstNumber       || '',
        phone          : tenant.phone           || '',
        razorpayKeyId  : tenant.razorpay?.keyId || '',
        logoUrl        : tenant.logoUrl         || '',
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;