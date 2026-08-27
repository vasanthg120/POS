'use strict';
const mongoose = require('mongoose');

const permissionSchema = new mongoose.Schema({
    pageKey: {
        type: String,
        required: true,
        enum: ['dashboard', 'payments', 'quotations', 'tracking', 'margin-calculator', 'royalty', 'rbac', 'settings', 'tenants'],
    },
    actions: [{ type: String, enum: ['view', 'create', 'edit', 'delete', 'export'] }],
}, { _id: false });

const rbacRoleSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, maxlength: 200, default: '' },
    color: { type: String, default: '#1e40af', match: /^#[0-9a-fA-F]{6}$/ },
    isSystem: { type: Boolean, default: false },
    permissions: [permissionSchema],
    memberCount: { type: Number, default: 0, min: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
}, { timestamps: true });

rbacRoleSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
rbacRoleSchema.index({ tenantId: 1, name: 1 });

module.exports = mongoose.model('RbacRole', rbacRoleSchema);