'use strict';
const mongoose = require('mongoose');

const rbacAuditSchema = new mongoose.Schema({
  tenantId      : { type: String, required: true, index: true },
  roleId        : { type: mongoose.Schema.Types.ObjectId, ref: 'RbacRole', index: true },
  roleName      : String,
  actorId       : { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  actorName     : String,
  actorInitials : String,
  actorColor    : { type: String, default: '#1e40af' },
  action        : {
    type: String,
    required: true,
    enum: ['created','updated','deleted','duplicated','permissions_changed'],
  },
  detail  : String,
  changes : mongoose.Schema.Types.Mixed,
}, { timestamps: true });

// Enterprise retention: auto-expire after 90 days
rbacAuditSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

module.exports = mongoose.model('RbacAuditLog', rbacAuditSchema);