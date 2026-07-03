'use strict';

const Tenant = require('../models/tenant');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const ok = (res, data = {}, message = 'Success') =>
  res.json({ success: true, message, data });

const fail = (res, message = 'Something went wrong', status = 400) =>
  res.status(status).json({ success: false, message });

// ── Razorpay API helper ───────────────────────────────────────────────────────
const razorpayFetch = async (path, keyId, keySecret, params = {}) => {
  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const url = new URL(`https://api.razorpay.com/v1/${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  const res = await fetch(url.toString(), {
    method : 'GET',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
    signal : AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(
      new Error(body?.error?.description || `Razorpay API error ${res.status}`),
      { status: res.status },
    );
  }
  return res.json();
};

/**
 * Resolves the tenant document that holds Razorpay keys.
 * req.user.id is set by auth middleware to the parent's _id for sub-users,
 * so this always returns the document with the real Razorpay credentials.
 * We select the encrypted key fields explicitly.
 */
const resolveRazorpayTenant = (req) =>
  Tenant.findById(req.user.id).select('+razorpay.keyId +razorpay.keySecret');

// ── GET /tenant/statements/summary ───────────────────────────────────────────
exports.getSummary = asyncHandler(async (req, res) => {
  const tenant = await resolveRazorpayTenant(req);
  if (!tenant) return fail(res, 'Tenant not found', 404);
  if (!tenant.razorpay?.isConfigured) return fail(res, 'Razorpay is not configured', 400);

  const { keyId, keySecret } = tenant.getRazorpayKeys();
  if (!keyId || !keySecret) return fail(res, 'Razorpay keys could not be decrypted', 500);

  const now           = Math.floor(Date.now() / 1000);
  const todayStart    = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const monthStart    = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);
  const lastMonthStart = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).getTime() / 1000);
  const lastMonthEnd  = monthStart - 1;

  const [allPayments, refunds] = await Promise.all([
    razorpayFetch('payments', keyId, keySecret, { count: 100, status: 'captured' }),
    razorpayFetch('refunds',  keyId, keySecret, { count: 100 }),
  ]);

  const payments    = allPayments.items || [];
  const refundItems = refunds.items     || [];

  const total          = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const totalFees      = payments.reduce((s, p) => s + (p.fee || 0) + (p.tax || 0), 0);
  const todayAmt       = payments.filter(p => p.created_at >= todayStart).reduce((s, p) => s + p.amount, 0);
  const monthAmt       = payments.filter(p => p.created_at >= monthStart).reduce((s, p) => s + p.amount, 0);
  const lastMonthAmt   = payments.filter(p => p.created_at >= lastMonthStart && p.created_at <= lastMonthEnd)
                                 .reduce((s, p) => s + p.amount, 0);
  const totalRefunds   = refundItems.reduce((s, r) => s + (r.amount || 0), 0);
  const avgTicket      = payments.length ? Math.round(total / payments.length) : 0;

  const momGrowth = lastMonthAmt > 0
    ? (((monthAmt - lastMonthAmt) / lastMonthAmt) * 100).toFixed(1)
    : null;

  const methodMap = {};
  payments.forEach(p => {
    const m = p.method || 'other';
    methodMap[m] = (methodMap[m] || 0) + p.amount;
  });

  const dailyMap = {};
  const thirtyDaysAgo = now - 30 * 86400;
  payments.filter(p => p.created_at >= thirtyDaysAgo).forEach(p => {
    const day = new Date(p.created_at * 1000).toISOString().slice(0, 10);
    dailyMap[day] = (dailyMap[day] || 0) + p.amount;
  });

  return ok(res, {
    currency       : tenant.currency || 'INR',
    totalCollected : total,
    totalCount     : payments.length,
    totalFees,
    totalRefunds,
    refundCount    : refundItems.length,
    todayAmount    : todayAmt,
    monthAmount    : monthAmt,
    lastMonthAmount: lastMonthAmt,
    momGrowth,
    avgTicket,
    methodBreakdown: methodMap,
    dailyTrend: Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, amount]) => ({ date, amount })),
  });
});

// ── GET /tenant/statements/payments ──────────────────────────────────────────
exports.getPayments = asyncHandler(async (req, res) => {
  const tenant = await resolveRazorpayTenant(req);
  if (!tenant) return fail(res, 'Tenant not found', 404);
  if (!tenant.razorpay?.isConfigured) return fail(res, 'Razorpay is not configured', 400);

  const { keyId, keySecret } = tenant.getRazorpayKeys();
  if (!keyId || !keySecret) return fail(res, 'Razorpay keys could not be decrypted', 500);

  const { from, to, count = 25, skip = 0, status, method } = req.query;

  const params = {
    count: Math.min(100, parseInt(count) || 25),
    skip : parseInt(skip) || 0,
  };
  if (from) params.from = from;
  if (to)   params.to   = to;

  const data  = await razorpayFetch('payments', keyId, keySecret, params);
  let items   = data.items || [];

  if (status) items = items.filter(p => p.status === status);
  if (method) items = items.filter(p => p.method === method);

  return ok(res, {
    items     : items.map(formatPayment),
    count     : items.length,
    totalCount: data.count || items.length,
  });
});

// ── GET /tenant/statements/payments/:paymentId ────────────────────────────────
exports.getPaymentDetail = asyncHandler(async (req, res) => {
  const tenant = await resolveRazorpayTenant(req);
  if (!tenant) return fail(res, 'Tenant not found', 404);
  if (!tenant.razorpay?.isConfigured) return fail(res, 'Razorpay is not configured', 400);

  const { keyId, keySecret } = tenant.getRazorpayKeys();
  const payment = await razorpayFetch(`payments/${req.params.paymentId}`, keyId, keySecret);
  return ok(res, formatPayment(payment));
});

// ── GET /tenant/statements/refunds ───────────────────────────────────────────
exports.getRefunds = asyncHandler(async (req, res) => {
  const tenant = await resolveRazorpayTenant(req);
  if (!tenant) return fail(res, 'Tenant not found', 404);
  if (!tenant.razorpay?.isConfigured) return fail(res, 'Razorpay is not configured', 400);

  const { keyId, keySecret } = tenant.getRazorpayKeys();
  const { count = 25, skip = 0 } = req.query;

  const data = await razorpayFetch('refunds', keyId, keySecret, {
    count: Math.min(100, parseInt(count) || 25),
    skip : parseInt(skip) || 0,
  });

  return ok(res, {
    items: (data.items || []).map(r => ({
      id       : r.id,
      paymentId: r.payment_id,
      amount   : r.amount,
      currency : r.currency,
      status   : r.status,
      speed    : r.speed_processed,
      createdAt: r.created_at,
      notes    : r.notes,
    })),
    count: data.count || 0,
  });
});

// ── Formatter ─────────────────────────────────────────────────────────────────
const formatPayment = (p) => ({
  id          : p.id,
  amount      : p.amount,
  currency    : p.currency,
  status      : p.status,
  method      : p.method,
  description : p.description,
  email       : p.email,
  contact     : p.contact,
  createdAt   : p.created_at,
  fee         : p.fee,
  tax         : p.tax,
  orderId     : p.order_id,
  invoiceId   : p.invoice_id,
  refundStatus: p.refund_status,
  captured    : p.captured,
  errorCode   : p.error_code,
  errorDesc   : p.error_description,
  vpa         : p.vpa,
  bank        : p.bank,
  wallet      : p.wallet,
  card        : p.card ? {
    name         : p.card.name,
    network      : p.card.network,
    last4        : p.card.last4,
    type         : p.card.type,
    issuer       : p.card.issuer,
    international: p.card.international,
  } : null,
  notes       : p.notes || {},
  acquirerData: p.acquirer_data || {},
});