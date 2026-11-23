'use strict';
const mongoose = require('mongoose');

const permissionSchema = new mongoose.Schema({
    pageKey: {
        type: String,
        required: true,
        enum: ['dashboard', 'payments', 'quotations', 'tracking', 'margin-calculator', 'royalty', 'billing', 'rbac', 'settings', 'tenants'],
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

// 'tenants' stays in the pageKey enum only so legacy documents still load;
// it is removed before every save — Tenant Management is never grantable
// through a role (see utils/accountAccess.js RESERVED_PAGE_KEYS).
rbacRoleSchema.pre('validate', function () {
    const { RESERVED_PAGE_KEYS } = require('../utils/accountAccess');
    if (Array.isArray(this.permissions) && this.permissions.some(p => RESERVED_PAGE_KEYS.has(p.pageKey))) {
        this.permissions = this.permissions.filter(p => !RESERVED_PAGE_KEYS.has(p.pageKey));
    }
});

rbacRoleSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
rbacRoleSchema.index({ tenantId: 1, name: 1 });

module.exports = mongoose.model('RbacRole', rbacRoleSchema);