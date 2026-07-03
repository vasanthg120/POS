'use strict';
// models/payment.model.js
const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  tenantId: { type: String, required: true, index: true },  // <-- tenant isolation
  gateway: { type: String, enum: ['razorpay', 'stripe', 'bank_transfer', 'manual'], required: true },
  gatewayPaymentId: { type: String, required: true, index: true },
  gatewayOrderId: { type: String, index: true },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, required: true, uppercase: true, default: 'INR' },
  status: {
    type: String,
    enum: ['pending', 'processing', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'disputed'],
    default: 'pending',
    index: true,
  },
  paymentMethod: {
    type: { type: String },
    brand: String, last4: String, expMonth: Number, expYear: Number,
    bank: String, vpa: String, wallet: String,
  },
  billingDetails: {
    name: String, email: String, phone: String,
  },
  refunds: [{
    refundId: String,
    amount: Number,
    reason: String,
    status: { type: String, enum: ['pending', 'succeeded', 'failed'] },
    createdAt: { type: Date, default: Date.now },
  }],
  failureCode: String,
  failureMessage: String,
  receiptUrl: String,
  receiptNumber: String,
  idempotencyKey: { type: String, unique: true, sparse: true },
  ipAddress: String,
  userAgent: String,
}, {
  timestamps: true,
  toJSON: { virtuals: true },
});

paymentSchema.virtual('formattedAmount').get(function () {
  return (this.amount / 100).toFixed(2);
});

paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ tenantId: 1, status: 1 });
paymentSchema.index({ tenantId: 1, createdAt: -1 });

paymentSchema.methods.markFailed = async function (code, message) {
  this.status = 'failed';
  this.failureCode = code;
  this.failureMessage = message;
  return this.save();
};

module.exports = mongoose.model('Payment', paymentSchema);