'use strict';
const mongoose = require('mongoose');

/* ── Line Item (embedded) ── */
const LineItemSchema = new mongoose.Schema({
  item      : { type: String, default: '' },
  qty       : { type: Number, default: 0 },
  unitCost  : { type: Number, default: 0 },
  decoUnit  : { type: Number, default: 0 },
  setup     : { type: Number, default: 0 },
  ship      : { type: Number, default: 0 },
  quoteUnit : { type: Number, default: 0 },
}, { _id: false });

/* ── Snapshot of summary (stored so list view needs no recalc) ── */
const SummarySchema = new mongoose.Schema({
  totalQty       : { type: Number, default: 0 },
  totalCog       : { type: Number, default: 0 },
  totalDecoCost  : { type: Number, default: 0 },
  totalSetup     : { type: Number, default: 0 },
  totalShip      : { type: Number, default: 0 },
  totalCost      : { type: Number, default: 0 },
  totalQuote     : { type: Number, default: 0 },
  totalMargin    : { type: Number, default: 0 },
  totalMarginPct : { type: Number, default: 0 },
  subtotal       : { type: Number, default: 0 },
  inclDelivery   : { type: Number, default: 0 },
  setupTotal     : { type: Number, default: 0 },
  grandTotal     : { type: Number, default: 0 },
  profitSubtotal : { type: Number, default: 0 },
  incGst         : { type: Number, default: 0 },
  overallMarginPct: { type: Number, default: 0 },
}, { _id: false });

/* ── Main Job Schema ── */
const MarginJobSchema = new mongoose.Schema({
  // Multi-tenant: stored as Mixed to support ObjectId tenants and string roles (SUPERADMIN)
  // Mixed type: accepts ObjectId for tenants OR plain strings (e.g. 'SUPERADMIN')
  tenantId    : { type: mongoose.Schema.Types.Mixed, required: true, index: true },
  createdBy   : { type: mongoose.Schema.Types.Mixed, required: true },

  // Job meta
  jobName     : { type: String, default: '', trim: true },
  status      : { type: String, enum: ['draft', 'finalised', 'archived'], default: 'draft', index: true },
  tags        : [{ type: String, trim: true }],
  notes       : { type: String, default: '', trim: true },

  // Job config
  setupCount  : { type: Number, default: 1 },
  setupUnit   : { type: Number, default: 0 },
  shipping    : { type: Number, default: 0 },
  gstRate     : { type: Number, default: 18 },

  // Line items
  rows        : [LineItemSchema],

  // Calculated snapshot (updated on every save)
  summary     : { type: SummarySchema, default: () => ({}) },

  // Soft delete
  deletedAt   : { type: Date, default: null },

}, { timestamps: true });

/* ── Indexes ── */
MarginJobSchema.index({ tenantId: 1, createdAt: -1 });
MarginJobSchema.index({ tenantId: 1, status: 1 });
MarginJobSchema.index({ tenantId: 1, jobName: 'text' });

/* ── Virtuals ── */
MarginJobSchema.virtual('isDeleted').get(function () {
  return !!this.deletedAt;
});

/* ── Query helpers: exclude soft-deleted by default ── */
MarginJobSchema.pre(/^find/, function (next) {
  if (this.getFilter().deletedAt === undefined) {
    this.where({ deletedAt: null });
  }
  next();
});

const MarginJob = mongoose.model('MarginJob', MarginJobSchema);
module.exports = MarginJob;