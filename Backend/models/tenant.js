'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────────────────
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;

const getEncryptionKey = () => {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw || raw.length < 32) {
    throw new Error('[Tenant] ENCRYPTION_KEY must be at least 32 characters in .env');
  }
  return Buffer.from(raw.slice(0, KEY_LENGTH), 'utf8');
};

const encrypt = (text) => {
  if (!text) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
};

const decrypt = (stored) => {
  if (!stored) return null;
  try {
    const [ivHex, tagHex, encHex] = stored.split(':');
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(enc) + decipher.final('utf8');
  } catch {
    return null;
  }
};

// ── Sub-schemas ───────────────────────────────────────────────────────────────
const razorpaySchema = new mongoose.Schema({
  keyId: { type: String, select: false },
  keySecret: { type: String, select: false },
  webhookSecret: { type: String, select: false },
  isConfigured: { type: Boolean, default: false },
  verifiedAt: Date,
}, { _id: false });

const crmSchema = new mongoose.Schema({
  provider: { type: String, enum: ['prospectconnect'], default: 'prospectconnect' },
  apiKey:       { type: String, select: false },
  apiUrl:       { type: String },
  isConfigured: { type: Boolean, default: false },
  verifiedAt:   Date,
}, { _id: false });

// ── Main Tenant/User Schema ───────────────────────────────────────────────────
const tenantSchema = new mongoose.Schema({
  // ── Identity ───────────────────────────────────────────────────────────────
  firstName: { type: String, required: true, trim: true, maxlength: 50 },
  lastName: { type: String, required: true, trim: true, maxlength: 50 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  phone: { type: String, trim: true },
  password: { type: String, required: true, select: false, minlength: 8 },

  // ── Tenant / Business ──────────────────────────────────────────────────────
  tenantId: { type: String, unique: true, sparse: true, index: true },
  businessName: { type: String, trim: true, maxlength: 100 },
  businessAddress: { type: String, trim: true },
  city: { type: String, trim: true, maxlength: 50 },
  currency: { type: String, uppercase: true, default: 'INR', enum: ['INR', 'USD', 'EUR', 'GBP', 'AED'] },
  gstNumber: { type: String, trim: true },
  timezone: { type: String, default: 'Asia/Kolkata' },

  isSubUser: { type: Boolean, default: false, index: true },
  parentTenantId: { type: String, default: null, index: true },   // tenantId of the owner
  rbacRoleId: { type: mongoose.Schema.Types.ObjectId, ref: 'RbacRole', default: null },
  rbacRoleName: { type: String, default: '' },
  subUserStatus: {
    type: String,
    enum: ['invited', 'active', 'suspended'],
    default: null,                                                     // null = not a sub-user
  },
  inviteToken: { type: String, select: false },
  inviteExpires: { type: Date, select: false },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null },
  invitedAt: { type: Date, default: null },

  // ── Payment link ──────────────────────────────────────────────────────────
  paymentPageUrl: { type: String },
  paymentPageSlug: { type: String, unique: true, sparse: true, index: true },

  // ── Integrations ───────────────────────────────────────────────────────────
  razorpay: { type: razorpaySchema, default: () => ({ isConfigured: false }) },
  crm: { type: crmSchema, default: () => ({ isConfigured: false }) },

  // ── Account state ──────────────────────────────────────────────────────────
  // 'superadmin' = the one platform-operator account (seeded from .env).
  role: { type: String, enum: ['superadmin', 'tenant'], default: 'tenant' },
  isActive: { type: Boolean, default: true },
  // Distinct from isActive (a manual superadmin toggle) — set/cleared only by
  // the billing sweep (services/billing.service.js) when a subscription
  // invoice goes unpaid past its grace period, and cleared the moment a
  // payment is recorded. Kept separate so the two suspension reasons never
  // fight each other and the login error can name the actual cause.
  billingSuspended: { type: Boolean, default: false },
  isEmailVerified: { type: Boolean, default: false, select: false },

  // ── Auth tokens ────────────────────────────────────────────────────────────
  emailVerifyToken: { type: String, select: false },
  emailVerifyExpires: { type: Date, select: false },
  passwordResetToken: { type: String, select: false },
  passwordResetExpires: { type: Date, select: false },
  refreshTokens: {
    type: [{ token: String, ip: String, userAgent: String, createdAt: { type: Date, default: Date.now } }],
    select: false,
    default: [],
  },

  // ── Security ───────────────────────────────────────────────────────────────
  loginAttempts: { type: Number, default: 0, select: false },
  lockUntil: { type: Date, select: false },
  lastLogin: Date,
  lastLoginIP: String,

  // ── Setup progress ─────────────────────────────────────────────────────────
  setupStep: {
    type: String,
    enum: ['business', 'razorpay', 'crm', 'complete'],
    default: 'business',
  },

}, {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform(doc, ret) {
      delete ret.password;
      delete ret.__v;
      return ret;
    },
  },
});

// ── Virtuals ──────────────────────────────────────────────────────────────────
tenantSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});

tenantSchema.virtual('isLocked').get(function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

tenantSchema.virtual('isSetupComplete').get(function () {
  return this.setupStep === 'complete';
});

// ── Role invariants ───────────────────────────────────────────────────────────
// The organisation Super Admin is a standalone account: never a team member
// (sub-user) of anything. Team members are always role 'tenant' — they get
// their access from RBAC permissions, and Tenant Management isn't grantable.
tenantSchema.pre('validate', function () {
  if (this.role === 'superadmin' && (this.isSubUser || this.parentTenantId)) {
    this.invalidate('role', 'The Super Admin account cannot be a team member of another account.');
  }
  if (this.isSubUser && this.role !== 'tenant') {
    this.invalidate('role', 'Team members must have the tenant role.');
  }
});

// ── Pre-save: hash password ───────────────────────────────────────────────────
tenantSchema.pre('save', async function () {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 12);
  }
});

// ── Instance methods ──────────────────────────────────────────────────────────
tenantSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

tenantSchema.methods.incLoginAttempts = async function () {
  const MAX = 5;
  const LOCK = 30 * 60 * 1000;
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({ $set: { loginAttempts: 1 }, $unset: { lockUntil: 1 } });
  }
  const updates = { $inc: { loginAttempts: 1 } };
  if (this.loginAttempts + 1 >= MAX) {
    updates.$set = { lockUntil: new Date(Date.now() + LOCK) };
  }
  return this.updateOne(updates);
};

tenantSchema.methods.createEmailVerifyToken = function () {
  const raw = crypto.randomBytes(32).toString('hex');
  this.emailVerifyToken = crypto.createHash('sha256').update(raw).digest('hex');
  this.emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return raw;
};

tenantSchema.methods.createPasswordResetToken = function () {
  const raw = crypto.randomBytes(32).toString('hex');
  this.passwordResetToken = crypto.createHash('sha256').update(raw).digest('hex');
  this.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
  return raw;
};

// ── Razorpay key encryption/decryption ────────────────────────────────────────
tenantSchema.methods.setRazorpayKeys = function ({ keyId, keySecret, webhookSecret }) {
  this.razorpay.keyId = encrypt(keyId);
  this.razorpay.keySecret = encrypt(keySecret);
  this.razorpay.webhookSecret = webhookSecret ? encrypt(webhookSecret) : null;
  this.razorpay.isConfigured = true;
  this.razorpay.verifiedAt = new Date();
};

tenantSchema.methods.getRazorpayKeys = function () {
  return {
    keyId: decrypt(this.razorpay.keyId),
    keySecret: decrypt(this.razorpay.keySecret),
    webhookSecret: decrypt(this.razorpay.webhookSecret),
  };
};

// ── CRM key encryption/decryption ─────────────────────────────────────────────
tenantSchema.methods.setCRMKeys = function ({ apiKey, apiUrl, provider }) {
  this.crm.apiKey = encrypt(apiKey);
  this.crm.apiUrl = apiUrl;
  this.crm.provider = provider;
  this.crm.isConfigured = true;
  this.crm.verifiedAt = new Date();
};

tenantSchema.methods.getCRMKey = function () {
  return decrypt(this.crm.apiKey);
};

// ── Indexes ───────────────────────────────────────────────────────────────────
tenantSchema.index({ city: 1 });
tenantSchema.index({ createdAt: -1 });
tenantSchema.index({ parentTenantId: 1, isSubUser: 1 });
tenantSchema.index({ parentTenantId: 1, email: 1 });
// At most ONE organisation Super Admin, enforced by the database itself (a
// partial unique index: only documents with role 'superadmin' take part).
tenantSchema.index(
  { role: 1 },
  { unique: true, partialFilterExpression: { role: 'superadmin' }, name: 'one_superadmin' },
);

const Tenant = mongoose.model('Tenant', tenantSchema);

// Index builds fail without stopping the app (e.g. 'one_superadmin' when the
// database already holds two Super Admin accounts) — make that visible.
Tenant.on('index', (err) => {
  if (!err) return;
  require('../utils/logger').error(`[Tenant] Index build failed: ${err.message}`
    + (/one_superadmin/.test(err.message)
      ? ' — more than one account has role "superadmin". Keep the organisation Super Admin and set the others to "tenant".'
      : ''));
});

module.exports = Tenant;