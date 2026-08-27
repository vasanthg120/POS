'use strict';

const mongoose = require('mongoose');

/**
 * Structured follow-up entry — spec §12. `type`/`contactMethod` describe how
 * the tenant was reached; `followUpStatus` tracks the outcome independent of
 * the invoice's own payment status.
 */
const followUpSchema = new mongoose.Schema(
  {
    note: { type: String, required: true, trim: true, maxlength: 500 },
    type: { type: String, enum: ['call', 'email', 'whatsapp', 'sms', 'in_person', 'other'], default: 'call' },
    contactMethod: { type: String, default: '', maxlength: 120 },
    assignedStaffName: { type: String, default: '', maxlength: 100 },
    followUpStatus: {
      type: String,
      enum: ['pending', 'contacted', 'promised_to_pay', 'payment_received', 'escalated', 'no_response', 'closed'],
      default: 'pending',
    },
    nextFollowUpDate: { type: Date, default: null },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    addedByName: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, _id: true },
);

const refundSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0.01 },
    reason: { type: String, default: '', maxlength: 300 },
    refundedAt: { type: Date, default: Date.now },
    refundedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    refundedByName: { type: String, default: '' },
  },
  { _id: true },
);

/** Manual credit/debit adjustment applied to an invoice's total (spec §9). */
const adjustmentSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0.01 },
    type: { type: String, enum: ['credit', 'debit'], required: true },
    reason: { type: String, default: '', maxlength: 300 },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    addedByName: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, _id: true },
);

/**
 * One invoice per billing period. Amounts are broken out (base / discount /
 * GST / total) and frozen at generation time — later plan or tax-rate
 * changes never rewrite historical invoices. Payments are recorded manually
 * by the superadmin (bank transfer / UPI / cheque / cash); `status` reflects
 * payment completion first (pending → partially_paid → paid) with `overdue`
 * as the terminal "past due, unresolved" bucket reached from either state
 * once the due date passes without full payment.
 */
const invoiceSchema = new mongoose.Schema(
  {
    // NOT declared unique at the schema/index level on purpose: Mongo indexes
    // an empty subdocument array as a single implicit `null` entry, so a
    // non-sparse unique index here breaks the moment a second subscription
    // document has zero invoices (extremely common — every unenrolled
    // tenant). True uniqueness is already guaranteed by construction via the
    // atomic counter in generateInvoiceNumber() (services/billing.service.js).
    invoiceNumber: { type: String, required: true, index: true },
    periodMonth: { type: Number, required: true, min: 1, max: 12 },
    periodYear: { type: Number, required: true },

    planName: { type: String, default: '' },
    baseAmount: { type: Number, required: true, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    gstPercent: { type: Number, default: 0, min: 0 },
    gstAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },

    dueDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ['draft', 'generated', 'pending', 'partially_paid', 'paid', 'overdue', 'failed', 'cancelled', 'refunded'],
      default: 'pending',
      index: true,
    },

    paidAmount: { type: Number, default: 0 },
    paidAt: { type: Date, default: null },
    paymentMethod: { type: String, default: '' },
    referenceNumber: { type: String, default: '' },
    paymentNotes: { type: String, default: '' },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    recordedByName: { type: String, default: '' },

    failedAt: { type: Date, default: null },
    failureReason: { type: String, default: '' },

    refunds: { type: [refundSchema], default: [] },
    adjustments: { type: [adjustmentSchema], default: [] },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },

    // Set the moment the billing sweep suspends the tenant over this invoice.
    suspendedAt: { type: Date, default: null },
    // Milestone keys already fired for this invoice — e.g. '7d_before',
    // '3d_before', '1d_before', 'due_today', '1d_overdue', '3d_overdue',
    // 'final_warning' — each sent at most once (see billing.service.js).
    remindersSent: { type: [String], default: [] },

    followUps: { type: [followUpSchema], default: [] },
  },
  { timestamps: true, _id: true },
);

const tenantSubscriptionSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, unique: true, index: true },

    // Billing is opt-in per tenant — while false, the tenant is never
    // touched by the sweep and can never be suspended by it.
    isEnrolled: { type: Boolean, default: false },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan', default: null },
    planName: { type: String, default: '' },

    // The tenant's OWN effective pricing — copied from the plan at
    // assignment time, then independently editable (custom/negotiated
    // pricing). This, not the plan document, is what invoices are generated
    // from.
    monthlyFee: { type: Number, default: 0, min: 0 },
    gstPercent: { type: Number, default: 18, min: 0, max: 100 },
    discountType: { type: String, enum: ['percent', 'flat'], default: 'percent' },
    discountValue: { type: Number, default: 0, min: 0 },

    billingDay: { type: Number, default: 1, min: 1, max: 28 },
    // Per-tenant override of the platform default grace period (see
    // DEFAULT_GRACE_PERIOD_DAYS in billing.service.js). Null = use default.
    gracePeriodDays: { type: Number, default: null, min: 0 },

    trialEndsAt: { type: Date, default: null },

    // Tenant-level status — deliberately separate from each invoice's own
    // payment status (spec §21). This is what drives Tenant.billingSuspended,
    // which is what the login check actually reads.
    tenantStatus: {
      type: String,
      enum: ['trial', 'active', 'grace_period', 'suspended', 'cancelled'],
      default: 'active',
      index: true,
    },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },

    invoices: { type: [invoiceSchema], default: [] },
  },
  { timestamps: true },
);

tenantSubscriptionSchema.methods.currentInvoice = function () {
  if (!this.invoices.length) return null;
  return this.invoices.reduce((latest, inv) => {
    if (!latest) return inv;
    if (inv.periodYear !== latest.periodYear) return inv.periodYear > latest.periodYear ? inv : latest;
    return inv.periodMonth > latest.periodMonth ? inv : latest;
  });
};

module.exports = mongoose.model('TenantSubscription', tenantSubscriptionSchema);
