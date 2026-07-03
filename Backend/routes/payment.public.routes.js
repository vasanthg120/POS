'use strict';

/**
 * Public Payment Routes  —  NO authentication needed
 * Mount in server.js as:
 *   app.use('/pay', require('./routes/payment.public.routes'));
 *
 * These routes power https://payment.pantheras.io/:slug
 */

const express   = require('express');
const router    = express.Router();
const Razorpay  = require('razorpay');   // npm i razorpay
const crypto    = require('crypto');
const Tenant    = require('../models/tenant');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─────────────────────────────────────────────────────────────────────────────
// GET /pay/:slug
// Returns the public tenant profile (NO secrets)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:slug', asyncHandler(async (req, res) => {
  const tenant = await Tenant.findOne({ paymentPageSlug: req.params.slug, isActive: true });

  if (!tenant || tenant.setupStep !== 'complete') {
    return res.status(404).json({ success: false, message: 'Payment page not found' });
  }

  // Return only public-safe fields
  res.json({
    success: true,
    data: {
      businessName   : tenant.businessName,
      businessAddress: tenant.businessAddress,
      currency       : tenant.currency,
      gstNumber      : tenant.gstNumber,
      phone          : tenant.phone,
      paymentPageSlug: tenant.paymentPageSlug,
      // Fetch the decrypted key ID (public key only — safe to expose)
      razorpayKeyId  : tenant.getRazorpayKeys().keyId,
    },
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /pay/:slug/order
// Creates a Razorpay order server-side (required before checkout opens)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:slug/order', asyncHandler(async (req, res) => {
  const { amount, currency, description } = req.body;

  if (!amount || amount < 100) {
    return res.status(400).json({ success: false, message: 'Amount must be at least ₹1 (100 paise)' });
  }

  const tenant = await Tenant.findOne({ paymentPageSlug: req.params.slug, isActive: true })
    .select('+razorpay.keyId +razorpay.keySecret');

  if (!tenant || tenant.setupStep !== 'complete') {
    return res.status(404).json({ success: false, message: 'Payment page not found' });
  }

  if (!tenant.razorpay?.isConfigured) {
    return res.status(400).json({ success: false, message: 'Payment gateway not configured' });
  }

  const { keyId, keySecret } = tenant.getRazorpayKeys();

  const rzp   = new Razorpay({ key_id: keyId, key_secret: keySecret });
  const order = await rzp.orders.create({
    amount  : amount,
    currency: currency || tenant.currency,
    notes   : { description: description || 'Payment', tenantId: String(tenant._id) },
  });

  res.json({
    success: true,
    data: {
      orderId : order.id,
      amount  : order.amount,
      currency: order.currency,
    },
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /pay/:slug/verify
// Verifies Razorpay signature after successful payment
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:slug/verify', asyncHandler(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, message: 'Missing payment verification data' });
  }

  const tenant = await Tenant.findOne({ paymentPageSlug: req.params.slug })
    .select('+razorpay.keySecret');

  if (!tenant) {
    return res.status(404).json({ success: false, message: 'Tenant not found' });
  }

  const { keySecret } = tenant.getRazorpayKeys();

  // HMAC-SHA256 verification
  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ success: false, message: 'Payment signature verification failed' });
  }

  // ── (Optional) Save payment record to DB here ─────────────────────────────
  // await Payment.create({ tenant: tenant._id, orderId, paymentId, amount, ... });

  res.json({ success: true, message: 'Payment verified successfully.' });
}));

module.exports = router;