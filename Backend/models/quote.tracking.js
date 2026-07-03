'use strict';

const mongoose = require('mongoose');

/* ── Timeline entry sub-schema ───────────────────────────────────────────── */

const timelineEntrySchema = new mongoose.Schema(
  {
    event: {
      type:      String,
      required:  true,
      trim:      true,
      maxlength: 500,
    },
    // Human-readable date string for display (e.g. "12 May 2026")
    date: {
      type:    String,
      default: () =>
        new Date().toLocaleDateString('en-IN', {
          day: '2-digit', month: 'short', year: 'numeric',
        }),
    },
    by: {
      type:    String,
      default: 'System',
      trim:    true,
    },
    type: {
      type:    String,
      enum:    ['status', 'payment', 'note', 'warning', 'error'],
      default: 'note',
    },
  },
  {
    timestamps: { createdAt: 'insertedAt', updatedAt: false },
    _id: true,
  },
);

/* ── Manual payment sub-schema ───────────────────────────────────────────── */
// Stores each individual manual payment installment so partial payments
// accumulate correctly and are fully auditable.

const manualPaymentSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    method: {
      type: String,
      required: true,
      // Bank Transfer | Cash | Cheque | NEFT | RTGS | IMPS | UPI (manual)
    },
    referenceNumber: {
      type:    String,
      default: '',
      trim:    true,
    },
    paymentDate: {
      type:    Date,
      default: Date.now,
    },
    notes: {
      type:    String,
      default: '',
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'User',
    },
  },
  {
    timestamps: true,
    _id:        true,
  },
);

/* ── Main schema ─────────────────────────────────────────────────────────── */

const quoteTrackingSchema = new mongoose.Schema(
  {
    tenantId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Tenant',
      required: true,
      index:    true,
    },

    quoteId: {
      type:     String,
      required: true,
      index:    true,
    },

    // ── Status fields ───────────────────────────────────────────────────────

    quotationStatus: {
      type:    String,
      default: 'Created',
      // Created | In Progress | Processing | Awaiting Payment |
      // Payment Completed | Delivered | Closed | Cancelled
    },

    paymentStatus: {
      type:    String,
      enum:    ['pending', 'paid', 'failed', 'partially_paid', 'refunded'],
      default: 'pending',
    },

    paymentMethod: {
      type:    String,
      default: '',
      // UPI | Card | Net Banking | Wallet | EMI |
      // Bank Transfer | Cash | Cheque | NEFT | RTGS | IMPS
    },

    // ── Financial fields ────────────────────────────────────────────────────

    paidAmount: {
      type:    Number,
      default: 0,
      min:     0,
    },

    paidAt: {
      type:    Date,
      default: null,
    },

    // ── Razorpay auto-sync fields ───────────────────────────────────────────

    // Razorpay payment ID (pay_xxxx) — populated by auto-sync
    _paymentId: {
      type:    String,
      default: null,
    },

    rzpBank: {
      type:    String,
      default: null,
    },

    rzpVpa: {
      type:    String,
      default: null,
    },

    rzpWallet: {
      type:    String,
      default: null,
    },

    // When true, auto-sync will NOT overwrite this record.
    // Set automatically whenever an admin makes any manual change.
    _adminOverride: {
      type:    Boolean,
      default: false,
    },

    // ── Manual payment fields ───────────────────────────────────────────────

    bankTransferRef: {
      type:    String,
      default: '',
      trim:    true,
    },

    bankTransferNotes: {
      type:    String,
      default: '',
    },

    // Full audit log of every manual payment installment
    manualPayments: {
      type:    [manualPaymentSchema],
      default: [],
    },

    // ── Notes & Timeline ────────────────────────────────────────────────────

    notes: {
      type:    String,
      default: '',
    },

    timeline: {
      type:    [timelineEntrySchema],
      default: [],
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'User',
    },
  },
  {
    timestamps: true, // createdAt + updatedAt on the tracking record
  },
);

/* ── Indexes ─────────────────────────────────────────────────────────────── */

quoteTrackingSchema.index({ tenantId: 1, quoteId: 1 }, { unique: true });
quoteTrackingSchema.index({ tenantId: 1, paymentStatus: 1 });
quoteTrackingSchema.index({ tenantId: 1, _adminOverride: 1 });

/* ── Virtuals ────────────────────────────────────────────────────────────── */

quoteTrackingSchema.virtual('isPaid').get(function () {
  return this.paymentStatus === 'paid';
});

quoteTrackingSchema.virtual('totalManualPaid').get(function () {
  return this.manualPayments.reduce((sum, p) => sum + (p.amount ?? 0), 0);
});

module.exports = mongoose.model('QuoteTracking', quoteTrackingSchema);
