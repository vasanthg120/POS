'use strict';

const Razorpay = require('razorpay');
const crypto   = require('crypto');
const Tenant   = require('../models/tenant');
const Payment  = require('../models/payment');
const Order    = require('../models/order');
const logger   = require('../utils/logger');
const { sendPaymentReceipt } = require('../services/receipt.service');

// ── Helper: get Razorpay instance for a tenant ────────────────────────────────
const getRazorpay = async (tenantId) => {
  const tenant = await Tenant.findOne({ tenantId }).select('+razorpay.keyId +razorpay.keySecret');
  if (!tenant || !tenant.razorpay.isConfigured) {
    throw Object.assign(new Error('Razorpay is not configured for this tenant.'), { status: 400 });
  }
  const { keyId, keySecret } = tenant.getRazorpayKeys();
  return { razorpay: new Razorpay({ key_id: keyId, key_secret: keySecret }), tenant, keyId };
};

// ── GET /payments/config/:slug ────────────────────────────────────────────────
// Public: returns Razorpay key ID for the payment page
exports.getConfig = async (req, res) => {
  try {
    const tenant = await Tenant.findOne({ paymentPageSlug: req.params.slug })
      .select('+razorpay.keyId');
    if (!tenant) return res.status(404).json({ success: false, message: 'Payment page not found.' });
    if (!tenant.razorpay.isConfigured) {
      return res.status(400).json({ success: false, message: 'Payments not configured for this tenant.' });
    }
    const { keyId } = tenant.getRazorpayKeys();
    return res.status(200).json({
      success: true,
      data: {
        keyId,
        businessName : tenant.businessName,
        city         : tenant.city,
        currency     : tenant.currency,
        tenantId     : tenant.tenantId,
      },
    });
  } catch (err) {
    logger.error(`[Payment.config] ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ── POST /payments/create-order ───────────────────────────────────────────────
exports.createOrder = async (req, res) => {
  try {
    const { items, customerInfo, notes, quotationNo, tenantId } = req.body;

    // Resolve tenant
    const tenant = await Tenant.findOne({ tenantId });
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

    const total = Math.round(items.reduce((s, i) => s + i.unitPrice * i.quantity, 0) * 100) / 100;
    const orderNotes = [quotationNo, notes].filter(Boolean).join(' — ') || '';
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    const order = new Order({
      tenant      : tenant._id,
      orderNumber,
      items: items.map(i => ({
        name      : i.name,
        quantity  : i.quantity,
        unitPrice : i.unitPrice,
      })),
      total,
      currency    : tenant.currency || 'INR',
      customerInfo: { name: customerInfo.name, email: customerInfo.email, phone: customerInfo.phone || '' },
      notes       : orderNotes,
      status      : 'pending',
      gateway     : 'razorpay',
      quotationNo : quotationNo || '',
    });

    await order.save();
    return res.status(201).json({ success: true, data: { order } });
  } catch (err) {
    logger.error(`[Payment.createOrder] ${err.message}`);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ── POST /payments/razorpay/create-order ──────────────────────────────────────
exports.createRazorpayOrder = async (req, res) => {
  try {
    const { orderId, tenantId } = req.body;

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.status === 'paid') return res.status(400).json({ success: false, message: 'Order already paid.' });

    const { razorpay, tenant, keyId } = await getRazorpay(tenantId || order.tenantId);

    // Reuse existing pending Razorpay order if exists
    const existingPay = await Payment.findOne({
      orderId: order._id,
      gateway: 'razorpay',
      status : { $in: ['pending', 'processing'] },
    });

    if (existingPay?.gatewayOrderId) {
      try {
        const existing = await razorpay.orders.fetch(existingPay.gatewayOrderId);
        if (existing.status !== 'paid') {
          return res.json({
            success: true,
            data: {
              razorpayOrderId: existing.id,
              amount         : existing.amount,
              currency       : existing.currency,
              keyId,
              paymentId      : existingPay._id,
              prefill: { name: order.customerInfo.name, email: order.customerInfo.email, contact: order.customerInfo.phone || '' },
            },
          });
        }
      } catch (_) { /* stale — create new */ }
    }

    const amountInPaise = Math.round(order.total * 100);
    const rzpOrder = await razorpay.orders.create({
      amount  : amountInPaise,
      currency: 'INR',
      receipt : (order.quotationNo || order.orderNumber || order._id.toString()).substring(0, 40),
      notes: { orderId: order._id.toString(), quotationNo: order.quotationNo || '', tenantId: tenant.tenantId },
    });

    const payment = new Payment({
      orderId          : order._id,
      tenantId         : tenant.tenantId,
      gateway          : 'razorpay',
      gatewayPaymentId : 'pending',
      gatewayOrderId   : rzpOrder.id,
      amount           : amountInPaise,
      currency         : 'INR',
      status           : 'pending',
      billingDetails   : { name: order.customerInfo.name, email: order.customerInfo.email },
      ipAddress        : req.ip,
      userAgent        : req.headers['user-agent'],
    });
    await payment.save();

    return res.json({
      success: true,
      data: {
        razorpayOrderId: rzpOrder.id,
        amount         : amountInPaise,
        currency       : 'INR',
        keyId,
        paymentId      : payment._id,
        prefill: { name: order.customerInfo.name, email: order.customerInfo.email, contact: order.customerInfo.phone || '' },
      },
    });
  } catch (err) {
    logger.error(`[Payment.createRazorpayOrder] ${err.message}`);
    const status = err.status || 500;
    return res.status(status).json({ success: false, message: err.message });
  }
};

// ── POST /payments/razorpay/verify ────────────────────────────────────────────
exports.verifyRazorpay = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId, paymentId, tenantId } = req.body;

    const [payment, order] = await Promise.all([
      Payment.findById(paymentId),
      Order.findById(orderId),
    ]);

    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });
    if (!order)   return res.status(404).json({ success: false, message: 'Order not found.' });

    // Verify signature using tenant's webhook secret or key secret
    const tenantDoc = await Tenant.findOne({ tenantId: tenantId || order.tenantId })
      .select('+razorpay.keySecret +razorpay.webhookSecret');

    const { keySecret } = tenantDoc.getRazorpayKeys();
    const expected = crypto.createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature.' });
    }

    if (payment.status === 'succeeded') {
      return res.json({ success: true, message: 'Already verified.', data: { payment, order } });
    }

    // Fetch full payment details
    const { razorpay } = await getRazorpay(tenantId || order.tenantId);
    const rzpPay = await razorpay.payments.fetch(razorpay_payment_id);

    if (rzpPay.status !== 'captured' && rzpPay.status !== 'authorized') {
      await payment.markFailed(rzpPay.error_code, rzpPay.error_description);
      return res.status(400).json({ success: false, message: rzpPay.error_description || `Status: ${rzpPay.status}` });
    }

    payment.gatewayPaymentId = razorpay_payment_id;
    payment.status           = 'succeeded';
    payment.paymentMethod    = { type: rzpPay.method };
    await payment.save();

    order.status    = 'paid';
    order.paymentId = payment._id;
    await order.save();

    // Send receipt
    try {
      const downloadUrl = `${process.env.APP_BASE_URL}/api/payments/receipt/${order._id}`;
      const { receiptNumber } = await sendPaymentReceipt({ order, payment, downloadUrl, tenant: tenantDoc });
      payment.receiptNumber = receiptNumber;
      await payment.save({ validateBeforeSave: false });
    } catch (mailErr) {
      logger.error(`[Receipt] Email failed (non-fatal): ${mailErr.message}`);
    }

    return res.json({ success: true, message: 'Payment verified.', data: { payment, order } });
  } catch (err) {
    logger.error(`[Payment.verify] ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ── GET /payments (tenant's own payments) ─────────────────────────────────────
exports.getTenantPayments = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.id);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter = { tenantId: tenant.tenantId };
    if (req.query.status)  filter.status  = req.query.status;
    if (req.query.gateway) filter.gateway = req.query.gateway;

    // Date range
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   filter.createdAt.$lte = new Date(req.query.to + 'T23:59:59');
    }

    // Search
    if (req.query.search) {
      filter.$or = [
        { gatewayPaymentId: { $regex: req.query.search, $options: 'i' } },
        { 'billingDetails.email': { $regex: req.query.search, $options: 'i' } },
      ];
    }

    const sortField = req.query.sortField || 'createdAt';
    const sortDir   = req.query.sortDir === 'asc' ? 1 : -1;

    const [payments, total] = await Promise.all([
      Payment.find(filter)
        .populate({ path: 'orderId', select: 'orderNumber customerInfo notes quotationNo' })
        .sort({ [sortField]: sortDir })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payment.countDocuments(filter),
    ]);

    // Dashboard summary
    const summaryPipeline = [
      { $match: { tenantId: tenant.tenantId } },
      {
        $group: {
          _id          : null,
          totalRevenue : { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, '$amount', 0] } },
          monthRevenue : {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$status', 'succeeded'] },
                  { $gte: ['$createdAt', new Date(new Date().getFullYear(), new Date().getMonth(), 1)] },
                ] },
                '$amount', 0,
              ],
            },
          },
          todayRevenue: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$status', 'succeeded'] },
                  { $gte: ['$createdAt', new Date(new Date().toISOString().split('T')[0])] },
                ] },
                '$amount', 0,
              ],
            },
          },
          totalPayments: { $sum: 1 },
          pendingCount : { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          failedCount  : { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          monthPayments: {
            $sum: {
              $cond: [
                { $gte: ['$createdAt', new Date(new Date().getFullYear(), new Date().getMonth(), 1)] },
                1, 0,
              ],
            },
          },
        },
      },
    ];

    const [summaryResult] = await Payment.aggregate(summaryPipeline);
    const summary = summaryResult || {
      totalRevenue: 0, monthRevenue: 0, todayRevenue: 0,
      totalPayments: 0, pendingCount: 0, failedCount: 0, monthPayments: 0,
    };

    // Gateway breakdown
    const gatewayBreakdown = await Payment.aggregate([
      { $match: { tenantId: tenant.tenantId, status: 'succeeded' } },
      { $group: { _id: '$gateway', revenue: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $project: { gateway: '$_id', revenue: 1, count: 1, _id: 0 } },
    ]);

    return res.status(200).json({
      success: true,
      data: {
        payments,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
        summary,
        charts: { revenueByGateway: gatewayBreakdown },
      },
    });
  } catch (err) {
    logger.error(`[Payments.getTenantPayments] ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ── POST /payments/refund ─────────────────────────────────────────────────────
exports.refund = async (req, res) => {
  try {
    const { paymentId, amount, reason = 'requested_by_customer' } = req.body;
    const payment = await Payment.findById(paymentId);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });
    if (payment.status !== 'succeeded') return res.status(400).json({ success: false, message: 'Payment is not refundable.' });

    // Ensure tenant owns this payment
    const tenant = await Tenant.findById(req.user.id);
    if (payment.tenantId !== tenant.tenantId) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const { razorpay } = await getRazorpay(payment.tenantId);
    const refundAmt = amount ? Math.round(amount * 100) : payment.amount;

    const result = await razorpay.payments.refund(payment.gatewayPaymentId, {
      amount: refundAmt,
      notes : { reason },
    });

    payment.refunds.push({ refundId: result.id, amount: refundAmt, reason, status: 'succeeded' });
    payment.status = refundAmt >= payment.amount ? 'refunded' : 'partially_refunded';
    await payment.save();

    const order = await Order.findById(payment.orderId);
    if (order && payment.status === 'refunded') { order.status = 'refunded'; await order.save(); }

    return res.json({ success: true, message: 'Refund processed.', data: { refund: result, payment } });
  } catch (err) {
    logger.error(`[Payment.refund] ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── SEARCH (for tracking page) ─────────────────────────────────────────────
exports.search = async (req, res) => {
  try {
    const q        = String(req.query.q || '').trim();
    const tenantId = req.user.tenantId;
    if (!q) return res.status(400).json({ success: false, message: 'Search query required.' });


    const payments = await Payment.find({
      tenantId,
      $or: [
        { gatewayPaymentId: { $regex: q, $options: 'i' } },
      ],
    }).populate({ path: 'orderId', select: 'customerInfo notes quotationNo orderNumber' })
      .sort({ createdAt: -1 }).limit(10).lean();

    // Also search by quotation no via orders
    const orders = await Order.find({
      tenantId,
      $or: [
        { quotationNo: { $regex: q, $options: 'i' } },
        { notes      : { $regex: q, $options: 'i' } },
        { 'customerInfo.email': { $regex: q, $options: 'i' } },
        { 'customerInfo.name' : { $regex: q, $options: 'i' } },
      ],
    }).select('_id quotationNo notes customerInfo').limit(20).lean();

    const orderIds = orders.map(o => o._id.toString());
    const byOrder  = await Payment.find({
      tenantId, orderId: { $in: orderIds },
    }).populate({ path: 'orderId', select: 'customerInfo notes quotationNo orderNumber' })
      .sort({ createdAt: -1 }).limit(10).lean();

    // Deduplicate
    const seen    = new Set(payments.map(p => p._id.toString()));
    const combined = [...payments, ...byOrder.filter(p => !seen.has(p._id.toString()))];

    return res.json({ success: true, data: combined });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};