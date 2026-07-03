// models/User.js — Multi-tenant user model
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');

const UserSchema = new mongoose.Schema(
  {
    // ── Identity ─────────────────────────────────────────────────────────
    firstName    : { type: String, required: true, trim: true, maxlength: 50 },
    lastName     : { type: String, required: true, trim: true, maxlength: 50 },
    email        : {
      type     : String,
      required : true,
      unique   : true,
      lowercase: true,
      trim     : true,
      match    : [/^\S+@\S+\.\S+$/, 'Invalid email format'],
    },
    phone        : { type: String, trim: true, maxlength: 15 },

    // ── Auth ──────────────────────────────────────────────────────────────
    password     : { type: String, required: true, minlength: 8, select: false },
    role         : { type: String, enum: ['admin', 'tenant', 'staff'], default: 'tenant' },
    isActive     : { type: Boolean, default: true },
    isEmailVerified : { type: Boolean, default: false },

    // ── Tenant / Business info ────────────────────────────────────────────
    tenantId     : { type: String, unique: true, sparse: true },   // e.g. "client1"
    businessName : { type: String, trim: true, maxlength: 100 },
    city         : { type: String, trim: true, maxlength: 50 },
    currency     : { type: String, default: 'INR', maxlength: 3 },

    // ── Integrations (encrypted at rest) ─────────────────────────────────
    razorpayKeyId        : { type: String, select: false },
    razorpayKeySecret    : { type: String, select: false },
    crmApiKey            : { type: String, select: false },
    crmApiSecret         : { type: String, select: false },

    // ── Security tracking ─────────────────────────────────────────────────
    loginAttempts        : { type: Number, default: 0 },
    lockUntil            : { type: Date },
    lastLogin            : { type: Date },
    lastLoginIP          : { type: String },

    // ── Password reset ────────────────────────────────────────────────────
    passwordResetToken   : { type: String, select: false },
    passwordResetExpires : { type: Date,   select: false },

    // ── Email verification ────────────────────────────────────────────────
    emailVerifyToken     : { type: String, select: false },
    emailVerifyExpires   : { type: Date,   select: false },

    // ── Refresh tokens (allowlist) ────────────────────────────────────────
    refreshTokens : [{
      token     : { type: String },
      createdAt : { type: Date, default: Date.now },
      userAgent : { type: String },
      ip        : { type: String },
    }],
  },
  {
    timestamps : true,
    toJSON     : { virtuals: true },
    toObject   : { virtuals: true },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────
UserSchema.index({ email: 1 });
UserSchema.index({ tenantId: 1 });
UserSchema.index({ passwordResetToken: 1 });

// ── Virtual: full name ────────────────────────────────────────────────────
UserSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// ── Virtual: is account locked ───────────────────────────────────────────
UserSchema.virtual('isLocked').get(function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

// ── Pre-save: hash password ───────────────────────────────────────────────
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt   = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ── Method: compare password ──────────────────────────────────────────────
UserSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// ── Method: increment login attempts & lock ───────────────────────────────
const MAX_ATTEMPTS  = 5;
const LOCK_DURATION = 30 * 60 * 1000; // 30 min

UserSchema.methods.incLoginAttempts = async function () {
  // Unlock if previous lock has expired
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({ $set: { loginAttempts: 1 }, $unset: { lockUntil: 1 } });
  }
  const updates = { $inc: { loginAttempts: 1 } };
  if (this.loginAttempts + 1 >= MAX_ATTEMPTS && !this.isLocked) {
    updates.$set = { lockUntil: Date.now() + LOCK_DURATION };
  }
  return this.updateOne(updates);
};

// ── Method: generate password reset token ────────────────────────────────
UserSchema.methods.createPasswordResetToken = function () {
  const resetToken              = crypto.randomBytes(32).toString('hex');
  this.passwordResetToken       = crypto.createHash('sha256').update(resetToken).digest('hex');
  this.passwordResetExpires     = Date.now() + Number(process.env.PASSWORD_RESET_EXPIRES || 3600000);
  return resetToken; // raw token — send in email
};

// ── Method: generate email verify token ──────────────────────────────────
UserSchema.methods.createEmailVerifyToken = function () {
  const token               = crypto.randomBytes(32).toString('hex');
  this.emailVerifyToken     = crypto.createHash('sha256').update(token).digest('hex');
  this.emailVerifyExpires   = Date.now() + 24 * 60 * 60 * 1000; // 24 h
  return token;
};

module.exports = mongoose.model('User', UserSchema);