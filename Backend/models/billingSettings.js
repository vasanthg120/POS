'use strict';

const mongoose = require('mongoose');

/**
 * Platform-wide billing configuration — a singleton document (find-or-create,
 * enforced at the service layer in services/billingSettings.service.js, not
 * here). Drives defaults that used to be hardcoded constants in
 * billing.service.js (grace period, reminder schedule, invoice prefix) and
 * the company details printed on invoice/receipt PDFs.
 */
const billingSettingsSchema = new mongoose.Schema(
  {
    defaultGstPercent: { type: Number, default: 18, min: 0, max: 100 },
    defaultGracePeriodDays: { type: Number, default: 7, min: 0 },
    reminderDaysBeforeDue: { type: [Number], default: [7, 3, 1, 0] },
    reminderDaysOverdue: { type: [Number], default: [1, 3] },
    invoiceNumberPrefix: { type: String, default: 'INV', trim: true, maxlength: 10 },
    companyLegalName: { type: String, default: '', trim: true, maxlength: 120 },
    companyGSTIN: { type: String, default: '', trim: true, maxlength: 20 },
    companyAddress: { type: String, default: '', trim: true, maxlength: 300 },
    companyLogoUrl: { type: String, default: '', trim: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('BillingSettings', billingSettingsSchema);
