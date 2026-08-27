'use strict';

const mongoose = require('mongoose');

/**
 * Immutable audit trail for every billing-affecting action — invoice
 * generation, payments, refunds, plan changes, suspensions, reactivations,
 * follow-ups, reminders sent, manual adjustments. Never updated or deleted
 * once written. `performedByName` defaults to 'System Automation' for
 * cron-driven entries (no performedBy id in that case).
 */
const billingAuditLogSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    action: { type: String, required: true },
    description: { type: String, required: true },
    invoiceNumber: { type: String, default: '' },
    amount: { type: Number, default: null },
    previousStatus: { type: String, default: '' },
    newStatus: { type: String, default: '' },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null },
    performedByName: { type: String, default: 'System Automation' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

billingAuditLogSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('BillingAuditLog', billingAuditLogSchema);
