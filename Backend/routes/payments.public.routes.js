'use strict';
/**
 * routes/payments.public.routes.js
 *
 * PUBLIC payment flow endpoints — no auth required.
 *
 * Mount in server.js:
 *   const paymentsPublic = require('./routes/payments.public.routes');
 *   app.use('/payments', paymentsPublic);
 *
 * Exposes:
 *   POST /payments/create-order              → create internal Order doc
 *   POST /payments/razorpay/create-order     → create Razorpay order for an existing orderId
 *   POST /payments/razorpay/verify           → verify signature & mark order paid
 *   GET  /payments/receipt/:orderId          → PDF/HTML receipt
 */

const express  = require('express');
const router   = express.Router();
const Razorpay = require('razorpay');
const crypto   = require('crypto');
const { escapeRegex, isValidPhone } = require('../utils/validation');

// ── Lazy-load models ───────────────────────────────────────────────────────────
const getTenant = () => require('../models/tenant');
const getOrder  = () => require('../models/order');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ── Helper: load tenant as a full model instance (needed for getRazorpayKeys())
//    NEVER use .lean() here — lean strips instance methods
async function loadTenantById(tenantId) {
  const Tenant = getTenant();
  return Tenant.findById(tenantId)
    .select('+razorpay.keyId +razorpay.keySecret');
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /payments/create-order
// ─────────────────────────────────────────────────────────────────────────────
router.post('/create-order', asyncHandler(async (req, res) => {
  const {
    slug,
    items        = [],
    customerInfo = {},
    currency     = 'INR',
    notes        = '',
    quotationNo  = '',
  } = req.body;

  // Customer-facing messages — these used to read like API docs
  // ("customerInfo.name and email are required.").
  const bad = (message) => res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message });

  if (!slug || typeof slug !== 'string' || slug.length > 100)
    return bad('This payment link is incomplete. Please use the link the business sent you.');

  if (!Array.isArray(items) || !items.length || items.length > 50)
    return bad('There is nothing to pay for in this order. Please look up your quotation again.');

  for (const i of items) {
    const qty = Number(i?.quantity ?? 1);
    const price = Number(i?.unitPrice);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100000)
      return bad('Item quantity must be a whole number of at least 1.');
    if (!Number.isFinite(price) || price <= 0 || price > 10_000_000)
      return bad('Enter a valid amount to pay.');
  }

  const custName = String(customerInfo?.name ?? '').trim();
  const custEmail = String(customerInfo?.email ?? '').trim();
  const custPhone = String(customerInfo?.phone ?? '').trim();
  if (!custName || !custEmail)
    return bad('This quotation has no customer name or email on file, so it can’t be paid online yet. Please ask the business to update the quotation.');
  if (custName.length > 100)
    return bad('Customer name must be at most 100 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(custEmail) || custEmail.length > 100)
    return bad('The email address on this quotation is not valid. Please ask the business to correct it.');
  if (custPhone && !isValidPhone(custPhone))
    return bad('The phone number on this quotation is not valid. Please ask the business to correct it.');
  if (String(notes ?? '').length > 1000 || String(quotationNo ?? '').length > 50)
    return bad('The quotation details are too long. Please contact the business.');
  if (!['INR', 'USD', 'EUR', 'GBP', 'AED'].includes(currency))
    return bad('This currency is not supported for online payment.');

  // Resolve tenant — only need _id + isConfigured flag here, no keys yet
  const Tenant = getTenant();
  const tenant = await Tenant.findOne({
    $or: [
      { paymentPageSlug: slug },
      { city: { $regex: new RegExp(`^${escapeRegex(slug)}$`, 'i') } },
    ],
  }).lean();

  if (!tenant)
    return res.status(404).json({ success: false, message: 'Payment page not found.' });

  if (!tenant.razorpay?.isConfigured)
    return res.status(400).json({ success: false, message: 'Payment gateway not configured for this tenant.' });

  // Calculate total
  const total = items.reduce((sum, item) => {
    return sum + ((parseFloat(item.quantity) || 1) * (parseFloat(item.unitPrice) || 0));
  }, 0);

  const totalInPaise = Math.round(total * 100);
  if (totalInPaise < 100)
    return res.status(400).json({ success: false, message: 'Minimum payable amount is ₹1.00.' });

  // Create Order document
  const Order       = getOrder();
  const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const order = await Order.create({
    tenant      : tenant._id,
    orderNumber,
    items       : items.map(i => ({
      name     : i.name      || quotationNo || 'Payment',
      quantity : parseFloat(i.quantity)  || 1,
      unitPrice: parseFloat(i.unitPrice) || 0,
    })),
    total,
    currency,
    notes,
    quotationNo,
    customerInfo: {
      name : customerInfo.name,
      email: customerInfo.email,
      phone: customerInfo.phone || '',
    },
    status : 'pending',
    gateway: 'razorpay',
  });

  console.log('[payments/create-order] created order:', order._id, '| total:', total);

  return res.status(201).json({
    success: true,
    data   : {
      order: {
        _id        : order._id,
        orderNumber: order.orderNumber,
        total      : order.total,
        currency   : order.currency,
      },
    },
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /payments/razorpay/create-order
// ─────────────────────────────────────────────────────────────────────────────
router.post('/razorpay/create-order', asyncHandler(async (req, res) => {
  const { orderId } = req.body;

  if (!orderId)
    return res.status(400).json({ success: false, message: 'orderId is required.' });

  // Load order WITHOUT populate — tenant loaded separately below
  const Order = getOrder();
  const order = await Order.findById(orderId).lean();

  if (!order) {
    console.error('[razorpay/create-order] order not found:', orderId);
    return res.status(404).json({ success: false, message: 'Order not found.' });
  }

  console.log('[razorpay/create-order] order:', order._id, '| tenant ref:', order.tenant);

  // Load tenant as a FULL MODEL INSTANCE (not lean) so getRazorpayKeys() is available
  const tenant = await loadTenantById(order.tenant);

  if (!tenant) {
    console.error('[razorpay/create-order] tenant not found for id:', order.tenant);
    return res.status(404).json({ success: false, message: 'Tenant not found.' });
  }

  console.log('[razorpay/create-order] tenant:', tenant._id, '| isConfigured:', tenant.razorpay?.isConfigured);

  if (!tenant.razorpay?.isConfigured)
    return res.status(400).json({ success: false, message: 'Payment gateway not configured.' });

  // Decrypt Razorpay credentials via model method
  let keyId, keySecret;
  try {
    const keys = tenant.getRazorpayKeys();
    keyId      = keys.keyId;
    keySecret  = keys.keySecret;
  } catch (err) {
    console.error('[razorpay/create-order] getRazorpayKeys() threw:', err.message);
    return res.status(500).json({ success: false, message: 'Could not decrypt Razorpay credentials.' });
  }

  console.log('[razorpay/create-order] keyId present:', !!keyId, '| keySecret present:', !!keySecret);

  if (!keyId || !keySecret)
    return res.status(500).json({ success: false, message: 'Razorpay keys are missing or could not be decrypted.' });

  // Create Razorpay order
  const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });

  let razorpayOrder;
  try {
    razorpayOrder = await rzp.orders.create({
      amount  : Math.round(order.total * 100),   // must be in paise
      currency: order.currency || 'INR',
      notes   : {
        orderId    : String(order._id),
        quotationNo: order.quotationNo || '',
        tenantId   : String(tenant._id),
      },
    });
  } catch (err) {
    console.error('[razorpay/create-order] Razorpay API error:', err.message, err?.error);
    return res.status(502).json({
      success: false,
      message: err?.error?.description || err.message || 'Failed to create Razorpay order.',
    });
  }

  console.log('[razorpay/create-order] razorpayOrder.id:', razorpayOrder.id);

  // Persist Razorpay order ID and advance status
  await Order.findByIdAndUpdate(orderId, {
    razorpayOrderId: razorpayOrder.id,
    status         : 'initiated',
  });

  return res.json({
    success: true,
    data   : {
      razorpayOrderId: razorpayOrder.id,
      amount         : razorpayOrder.amount,
      currency       : razorpayOrder.currency,
      keyId,
      paymentId      : String(order._id),   // returned as reference for the verify step
      prefill        : {
        name   : order.customerInfo?.name  || '',
        email  : order.customerInfo?.email || '',
        contact: order.customerInfo?.phone || '',
      },
    },
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /payments/razorpay/verify
// ─────────────────────────────────────────────────────────────────────────────
router.post('/razorpay/verify', asyncHandler(async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    orderId,
  } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ success: false, message: 'Missing Razorpay verification fields.' });

  if (!orderId)
    return res.status(400).json({ success: false, message: 'orderId is required.' });

  const Order = getOrder();
  const order = await Order.findById(orderId).lean();

  if (!order)
    return res.status(404).json({ success: false, message: 'Order not found.' });

  // Load tenant as model instance for getRazorpayKeys()
  const tenant = await loadTenantById(order.tenant);

  if (!tenant)
    return res.status(404).json({ success: false, message: 'Tenant not found.' });

  let keySecret;
  try {
    keySecret = tenant.getRazorpayKeys().keySecret;
  } catch (err) {
    console.error('[razorpay/verify] getRazorpayKeys() threw:', err.message);
    return res.status(500).json({ success: false, message: 'Could not decrypt gateway credentials.' });
  }

  if (!keySecret)
    return res.status(500).json({ success: false, message: 'Razorpay key secret missing.' });

  // HMAC-SHA256 verification
  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    console.error('[razorpay/verify] signature mismatch — order:', orderId);
    return res.status(400).json({ success: false, message: 'Payment signature verification failed.' });
  }

  // Mark order paid
  await Order.findByIdAndUpdate(orderId, {
    status            : 'paid',
    razorpayPaymentId : razorpay_payment_id,
    razorpaySignature : razorpay_signature,
    paidAt            : new Date(),
  });

  console.log('[razorpay/verify] ✅ payment verified — order:', orderId, '| paymentId:', razorpay_payment_id);

  return res.json({ success: true, message: 'Payment verified successfully.' });
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /payments/receipt/:orderId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/receipt/:orderId', asyncHandler(async (req, res) => {
  const Order = getOrder();
  const order = await Order.findById(req.params.orderId).lean();

  if (!order)
    return res.status(404).json({ success: false, message: 'Order not found.' });

  if (order.status !== 'paid')
    return res.status(400).json({ success: false, message: 'Receipt is only available for paid orders.' });

  // Lean is fine here — only need branding fields
  const Tenant = getTenant();
  const tenant = await Tenant.findById(order.tenant).lean() || {};
  const customer = order.customerInfo || {};

  const fmtINR = (n) => {
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency', currency: 'INR',
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      }).format(n);
    } catch {
      return `₹${Number(n).toFixed(2)}`;
    }
  };

  // ── Try pdfkit ──────────────────────────────────────────────────────────────
  let PDFDocument;
  try { PDFDocument = require('pdfkit'); } catch { PDFDocument = null; }

  if (PDFDocument) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${order._id}.pdf"`);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(22).font('Helvetica-Bold')
       .text(tenant.businessName || 'Payment Receipt', { align: 'center' });
    doc.moveDown(0.3);
    if (tenant.businessAddress)
      doc.fontSize(10).font('Helvetica').text(tenant.businessAddress, { align: 'center' });
    if (tenant.gstNumber)
      doc.fontSize(10).font('Helvetica').text(`GSTIN: ${tenant.gstNumber}`, { align: 'center' });
    if (tenant.phone)
      doc.fontSize(10).font('Helvetica').text(`Phone: ${tenant.phone}`, { align: 'center' });

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fontSize(16).font('Helvetica-Bold').text('PAYMENT RECEIPT');
    doc.moveDown(0.5);

    const row = (label, value) => {
      doc.fontSize(10).font('Helvetica-Bold').text(label, { continued: true, width: 180 });
      doc.font('Helvetica').text(String(value || '—'));
    };

    row('Order Number:',   order.orderNumber);
    row('Quotation No.:',  order.quotationNo || '—');
    row('Transaction ID:', order.razorpayPaymentId || '—');
    row('Date:',           order.paidAt
      ? new Date(order.paidAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      : '—');
    row('Gateway:',        'Razorpay');
    row('Status:',         'PAID ✓');

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').text('Customer Details');
    doc.moveDown(0.3);
    row('Name:',  customer.name);
    row('Email:', customer.email);
    if (customer.phone) row('Phone:', customer.phone);

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').text('Items');
    doc.moveDown(0.3);

    (order.items || []).forEach(item => {
      const lineTotal = (item.quantity || 1) * (item.unitPrice || 0);
      doc.fontSize(10).font('Helvetica')
         .text(`${item.name}  ×${item.quantity}  @  ${fmtINR(item.unitPrice)}  =  ${fmtINR(lineTotal)}`);
    });

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);
    doc.fontSize(13).font('Helvetica-Bold')
       .text(`Total: ${fmtINR(order.total)}`, { align: 'right' });

    doc.moveDown(2);
    doc.fontSize(9).font('Helvetica').fillColor('#888')
       .text('This is a computer-generated receipt and does not require a signature.', { align: 'center' });

    doc.end();
    return;
  }

  // ── Fallback: HTML receipt ─────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${order._id}.html"`);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Receipt — ${order.orderNumber}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:sans-serif;max-width:620px;margin:40px auto;padding:0 16px;color:#222;}
  h1{text-align:center;font-size:1.5rem;margin-bottom:4px;}
  .sub{text-align:center;color:#555;font-size:.85rem;margin-bottom:4px;}
  hr{border:none;border-top:1px solid #ddd;margin:18px 0;}
  h2{font-size:1.1rem;margin-bottom:10px;}
  h3{font-size:.95rem;margin:14px 0 8px;}
  table{width:100%;border-collapse:collapse;}
  td{padding:5px 6px;font-size:.88rem;vertical-align:top;}
  td:first-child{font-weight:600;width:170px;color:#444;}
  .items-table td{padding:5px 6px;}
  .items-table td:last-child{text-align:right;}
  .total-row td{font-weight:700;font-size:1rem;border-top:2px solid #ddd;padding-top:10px;}
  .badge{display:inline-block;background:#e6f4ea;color:#1e7e34;
         padding:2px 10px;border-radius:12px;font-size:.8rem;font-weight:600;}
  .footer{text-align:center;color:#aaa;font-size:.75rem;margin-top:24px;}
  @media print{body{margin:0;}}
</style>
</head>
<body>
  <h1>${tenant.businessName || 'Payment Receipt'}</h1>
  ${tenant.businessAddress ? `<p class="sub">${tenant.businessAddress}</p>` : ''}
  ${tenant.gstNumber       ? `<p class="sub">GSTIN: ${tenant.gstNumber}</p>` : ''}
  ${tenant.phone           ? `<p class="sub">Phone: ${tenant.phone}</p>`    : ''}

  <hr/>
  <h2>Payment Receipt</h2>
  <table>
    <tr><td>Order Number</td>   <td>${order.orderNumber}</td></tr>
    <tr><td>Quotation No.</td>  <td>${order.quotationNo || '—'}</td></tr>
    <tr><td>Transaction ID</td> <td>${order.razorpayPaymentId || '—'}</td></tr>
    <tr><td>Date</td>
        <td>${order.paidAt
              ? new Date(order.paidAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
              : '—'}</td></tr>
    <tr><td>Gateway</td>        <td>Razorpay</td></tr>
    <tr><td>Status</td>         <td><span class="badge">✓ PAID</span></td></tr>
  </table>

  <hr/>
  <h3>Customer</h3>
  <table>
    <tr><td>Name</td>  <td>${customer.name  || '—'}</td></tr>
    <tr><td>Email</td> <td>${customer.email || '—'}</td></tr>
    ${customer.phone ? `<tr><td>Phone</td><td>${customer.phone}</td></tr>` : ''}
  </table>

  <hr/>
  <h3>Items</h3>
  <table class="items-table">
    <tr style="border-bottom:1px solid #eee;font-size:.8rem;color:#666;">
      <td>Description</td><td>Qty</td><td>Unit Price</td><td>Amount</td>
    </tr>
    ${(order.items || []).map(i => `
    <tr>
      <td>${i.name}</td>
      <td>${i.quantity}</td>
      <td>${fmtINR(i.unitPrice)}</td>
      <td>${fmtINR((i.quantity || 1) * (i.unitPrice || 0))}</td>
    </tr>`).join('')}
    <tr class="total-row">
      <td colspan="3" style="text-align:right;">Total</td>
      <td>${fmtINR(order.total)}</td>
    </tr>
  </table>

  <p class="footer">Computer-generated receipt — no signature required.</p>
</body>
</html>`);
}));

module.exports = router;