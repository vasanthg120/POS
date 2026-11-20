'use strict';

/**
 * models/crmQuote.js
 *
 * Local mirror of a tenant's CRM (ProspectConnect) quotations, written only by
 * services/crmSync.service.js. Every read path that needs "all of this
 * tenant's quotes" (Tracking, Quotations, Dashboard, Royalty, Super Admin
 * aggregation) reads from here instead of pulling the full CRM dataset live on
 * every request.
 *
 * `raw` keeps the CRM record as returned (minus a few large HTML blobs no
 * screen uses), so the existing normalise() mapping in
 * services/quoteTracking.service.js stays the single source of truth for
 * field mapping. POS-owned state (payment tracking, manual payments) stays in
 * QuoteTracking and is never written here.
 */

const mongoose = require('mongoose');

const crmQuoteSchema = new mongoose.Schema(
  {
    tenantId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    provider:   { type: String, default: 'prospectconnect' },
    crmQuoteId: { type: String, required: true },          // CRM `_id`
    quoteNumber: { type: String, default: '' },             // CRM `ticket_number`

    // Denormalised copies of a few fields, for indexing / ad-hoc queries.
    quoteStatus:          { type: String, default: '' },
    clientApprovalStatus: { type: String, default: '' },
    amount:               { type: Number, default: 0 },
    currency:             { type: String, default: 'INR' },
    crmCreatedAt:         { type: Date, default: null },
    crmUpdatedAt:         { type: Date, default: null },

    raw:         { type: mongoose.Schema.Types.Mixed, required: true },
    contentHash: { type: String, required: true },

    // Soft delete: set when a *complete* sync no longer returns the quote, or
    // when the CRM itself flags it `is_delete`. Cleared if it reappears.
    isDeletedInCrm:    { type: Boolean, default: false },
    deletedDetectedAt: { type: Date, default: null },

    firstSyncedAt: { type: Date, default: Date.now },
    lastSyncedAt:  { type: Date, default: Date.now },        // last time this record was written
  },
  {
    timestamps: false,
    minimize: false,   // keep empty objects inside `raw` exactly as the CRM sent them
  },
);

// One row per CRM quote per tenant: this is what makes re-syncs idempotent.
crmQuoteSchema.index({ tenantId: 1, crmQuoteId: 1 }, { unique: true });
crmQuoteSchema.index({ tenantId: 1, isDeletedInCrm: 1, crmCreatedAt: -1 });
crmQuoteSchema.index({ tenantId: 1, quoteNumber: 1 });

module.exports = mongoose.model('CrmQuote', crmQuoteSchema);
