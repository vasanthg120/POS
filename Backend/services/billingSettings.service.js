'use strict';

// ════════════════════════════════════════════════════════════════════════════
// services/billingSettings.service.js
//
// Platform-wide billing configuration — a singleton BillingSettings document,
// find-or-created lazily and cached in-memory (this is a single-process
// deployment, so a module-level cache needs no cross-process invalidation).
// Consumed by billing.service.js (grace period / reminder schedule / invoice
// prefix) and invoicePdf.service.js (company details on PDFs).
// ════════════════════════════════════════════════════════════════════════════

const BillingSettings = require('../models/billingSettings');
const BillingAuditLog = require('../models/billingAuditLog');
const logger = require('../utils/logger');

let cached = null;

const getSettings = async () => {
  if (cached) return cached;
  let doc = await BillingSettings.findOne();
  if (!doc) doc = await BillingSettings.create({});
  cached = doc;
  return doc;
};

const actorName = (user) =>
  (user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email : '') || 'System Automation';

const EDITABLE_FIELDS = [
  'defaultGstPercent', 'defaultGracePeriodDays', 'reminderDaysBeforeDue', 'reminderDaysOverdue',
  'invoiceNumberPrefix', 'companyLegalName', 'companyGSTIN', 'companyAddress', 'companyLogoUrl',
];

const updateSettings = async (payload, actingUser) => {
  const doc = await getSettings();
  for (const field of EDITABLE_FIELDS) {
    if (payload[field] !== undefined) doc[field] = payload[field];
  }
  await doc.save();
  cached = doc;

  try {
    await BillingAuditLog.create({
      tenantId: 'PLATFORM',
      action: 'billing_settings_updated',
      description: `Billing settings updated by ${actorName(actingUser)}.`,
      performedBy: actingUser?.id,
      performedByName: actorName(actingUser),
    });
  } catch (err) {
    logger.error(`[BillingSettings] Audit log write failed: ${err.message}`);
  }

  return doc;
};

module.exports = { getSettings, updateSettings };
