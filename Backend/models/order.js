'use strict';

/**
 * models/order.js
 *
 * Order document created during the public payment flow.
 * One Order = one payment attempt for one quotation.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── Sub-schemas ────────────────────────────────────────────────────────────────

const OrderItemSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0.001, default: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number },   // stored for quick reads; computed on save
  },
  { _id: false }
);

const CustomerInfoSchema = new Schema(
  {
    name: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

// ── Main schema ────────────────────────────────────────────────────────────────

const OrderSchema = new Schema(
  {
    // ── Tenant ─────────────────────────────────────────────────────────────────
    tenant: {
      type: Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },

    // ── Reference numbers ──────────────────────────────────────────────────────
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      // Generated in the route: ORD-<timestamp>-<random>
    },

    quotationNo: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    // ── Items & financials ─────────────────────────────────────────────────────
    items: {
      type: [OrderItemSchema],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'Order must have at least one item.',
      },
    },

    total: {
      type: Number,
      required: true,
      min: 0,
    },

    currency: {
      type: String,
      trim: true,
      uppercase: true,
      default: 'INR',
    },

    notes: {
      type: String,
      trim: true,
      default: '',
      maxlength: 1000,
    },

    // ── Customer ───────────────────────────────────────────────────────────────
    customerInfo: {
      type: CustomerInfoSchema,
      default: () => ({}),
    },

    // ── Status lifecycle ───────────────────────────────────────────────────────
    //   pending   → order created, Razorpay checkout not yet opened
    //   initiated → Razorpay order created, checkout open
    //   paid      → payment verified via HMAC signature
    //   failed    → payment failed at gateway
    //   cancelled → user cancelled checkout
    //   refunded  → fully refunded
    status: {
      type: String,
      enum: ['pending', 'initiated', 'paid', 'failed', 'cancelled', 'refunded'],
      default: 'pending',
      index: true,
    },

    // ── Gateway ────────────────────────────────────────────────────────────────
    gateway: {
      type: String,
      enum: ['razorpay', 'manual'],
      default: 'razorpay',
    },

    // Razorpay order ID (set after POST /payments/razorpay/create-order)
    razorpayOrderId: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    // Razorpay payment ID (set after successful verification)
    razorpayPaymentId: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    // Razorpay signature stored for audit trail
    razorpaySignature: {
      type: String,
      trim: true,
      default: '',
    },

    // ── Timestamps ─────────────────────────────────────────────────────────────
    paidAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    refundedAt: {
      type: Date,
      default: null,
    },

    // ── Refund details (populated if status → refunded) ───────────────────────
    refund: {
      razorpayRefundId: { type: String, default: '' },
      amount: { type: Number, default: 0 },
      reason: { type: String, default: '' },
      processedAt: { type: Date, default: null },
    },

    // ── Failure details ────────────────────────────────────────────────────────
    failureReason: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,   // adds createdAt, updatedAt automatically
    versionKey: false,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

OrderSchema.index({ tenant: 1, createdAt: -1 });          // dashboard list
OrderSchema.index({ tenant: 1, status: 1 });               // filter by status
OrderSchema.index({ tenant: 1, quotationNo: 1 });          // look up by quote
OrderSchema.index({ razorpayOrderId: 1 }, { sparse: true });
OrderSchema.index({ razorpayPaymentId: 1 }, { sparse: true });

// ── Pre-save hook: compute lineTotals ─────────────────────────────────────────

OrderSchema.pre('save', function (next) {
  if (this.isModified('items') || this.isNew) {
    this.items.forEach(item => {
      item.lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
    });
  }
  next();
});

// ── Instance methods ──────────────────────────────────────────────────────────

/**
 * Mark order as initiated (Razorpay checkout opened).
 */
OrderSchema.methods.markInitiated = function (razorpayOrderId) {
  this.status = 'initiated';
  this.razorpayOrderId = razorpayOrderId;
  return this.save();
};

/**
 * Mark order as paid after successful Razorpay verification.
 */
OrderSchema.methods.markPaid = function ({ razorpayPaymentId, razorpaySignature } = {}) {
  this.status = 'paid';
  this.razorpayPaymentId = razorpayPaymentId || this.razorpayPaymentId;
  this.razorpaySignature = razorpaySignature || this.razorpaySignature;
  this.paidAt = new Date();
  return this.save();
};

/**
 * Mark order as failed.
 */
OrderSchema.methods.markFailed = function (reason = '') {
  this.status = 'failed';
  this.failureReason = reason;
  this.failedAt = new Date();
  return this.save();
};

/**
 * Mark order as cancelled.
 */
OrderSchema.methods.markCancelled = function () {
  this.status = 'cancelled';
  return this.save();
};

// ── Static helpers ────────────────────────────────────────────────────────────

/**
 * Find all orders for a tenant, newest first.
 * Usage: Order.forTenant(tenantId, { status: 'paid', limit: 25 })
 */
OrderSchema.statics.forTenant = function (tenantId, { status, limit = 25, skip = 0 } = {}) {
  const q = this.find({ tenant: tenantId });
  if (status) q.where('status').equals(status);
  return q.sort({ createdAt: -1 }).skip(skip).limit(limit).lean();
};

/**
 * Sum of all paid orders for a tenant (in the Order's currency unit, not paise).
 */
OrderSchema.statics.totalCollected = async function (tenantId) {
  const result = await this.aggregate([
    { $match: { tenant: new mongoose.Types.ObjectId(tenantId), status: 'paid' } },
    { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } },
  ]);
  return result[0] ?? { total: 0, count: 0 };
};

// ── Virtual: formatted total ──────────────────────────────────────────────────

OrderSchema.virtual('formattedTotal').get(function () {
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: this.currency || 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(this.total);
  } catch {
    return `${this.currency} ${this.total.toFixed(2)}`;
  }
});

// ── Model ─────────────────────────────────────────────────────────────────────

const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);

module.exports = Order;