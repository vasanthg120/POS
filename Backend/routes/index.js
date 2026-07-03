'use strict';

// ════════════════════════════════════════════════════════════════════════════
// routes/index.js
// Registers all routes with role-based access control.
//
// Role matrix:
//   superadmin → /api/admin/*  (full platform control)
//   tenant     → /api/tenant/* (own data only)
//   public     → /api/payments/config, /api/payments/create-order, etc.
// ════════════════════════════════════════════════════════════════════════════

const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, param, query, validationResult } = require('express-validator');

const authCtrl = require('../controllers/authController');
const tenantCtrl = require('../controllers/tenantController');
const paymentsCtrl = require('../controllers/paymentsController');
const quotesCtrl = require('../controllers/quotesController');
const adminCtrl = require('../controllers/adminController');

const { protect } = require('../middleware/auth');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const requireTenant = require('../middleware/requireTenant');

// ── Shared validation runner ──────────────────────────────────────────────────
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'Please fix the following errors.',
      errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
};

// ── Rate limiter factory ──────────────────────────────────────────────────────
const limiter = (max, windowMinutes = 15) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Please try again later.' },
  });

// ── Reusable password validation ──────────────────────────────────────────────
const passwordRules = () =>
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters.')
    .matches(/[A-Z]/).withMessage('Must contain at least one uppercase letter.')
    .matches(/[a-z]/).withMessage('Must contain at least one lowercase letter.')
    .matches(/\d/).withMessage('Must contain at least one number.')
    .matches(/[@$!%*?&]/).withMessage('Must contain a special character (@$!%*?&).');

module.exports = (app) => {

  // ══════════════════════════════════════════════════════════════════════════
  // AUTH  /api/auth/*   (public — no role guard)
  // ══════════════════════════════════════════════════════════════════════════
  const auth = express.Router();

  auth.post('/login', limiter(10, 15), [
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('password').notEmpty().withMessage('Password is required.'),
  ], validate, authCtrl.login);

  auth.post('/forgot-password', limiter(5, 60), [
    body('email').isEmail().normalizeEmail(),
  ], validate, authCtrl.forgotPassword);

  auth.post('/reset-password', limiter(10, 60), [
    body('token').notEmpty(),
    passwordRules(),
    body('confirmPassword').custom((v, { req }) => {
      if (v !== req.body.password) throw new Error('Passwords do not match.');
      return true;
    }),
  ], validate, authCtrl.resetPassword);

  auth.get('/verify-email', [
    query('token').notEmpty().withMessage('Token is required.'),
  ], validate, authCtrl.verifyEmail);

  auth.post('/resend-verification', limiter(5, 60), [
    body('email').isEmail().normalizeEmail(),
  ], validate, authCtrl.resendVerification);

  auth.post('/refresh', authCtrl.refresh);
  auth.post('/logout', protect, authCtrl.logout);
  auth.get('/me', protect, authCtrl.me);

  app.use('/api/auth', auth);


  // ══════════════════════════════════════════════════════════════════════════
  // SUPERADMIN  /api/admin/*
  // Requires: valid JWT + role === 'superadmin'
  // ══════════════════════════════════════════════════════════════════════════
  const admin = express.Router();
  admin.use(protect, requireSuperAdmin);   // <── both guards on every route

  // Provision a new tenant (generates credentials, sends welcome email)
  // ── POST /api/admin/tenants
  admin.post('/tenants', [
    body('firstName').trim().notEmpty().withMessage('First name is required.').isLength({ max: 50 }),
    body('lastName').trim().notEmpty().withMessage('Last name is required.').isLength({ max: 50 }),
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('phone').optional().matches(/^[+]?[\d\s\-()]{7,20}$/).withMessage('Invalid phone number.'),
    body('businessName').optional().trim().isLength({ max: 100 }),
    body('city').optional().trim().isLength({ max: 50 }),
    body('currency').optional().isIn(['INR', 'USD', 'EUR', 'GBP', 'AED']).withMessage('Unsupported currency.'),
  ], validate, adminCtrl.createTenant);

  admin.get('/tenants', adminCtrl.listTenants);

  admin.get('/tenants/:tenantId', [
    param('tenantId').notEmpty(),
  ], validate, adminCtrl.getTenant);

  admin.patch('/tenants/:tenantId/status', [
    param('tenantId').notEmpty(),
    body('isActive').isBoolean().withMessage('isActive must be true or false.'),
  ], validate, adminCtrl.setTenantStatus);

  admin.post('/tenants/:tenantId/reset-password', [
    param('tenantId').notEmpty(),
  ], validate, adminCtrl.resetTenantPassword);

  app.use('/api/admin', admin);


  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SETTINGS  /api/tenant/*
  // Requires: valid JWT + role in ['owner', 'admin', 'staff']
  // ══════════════════════════════════════════════════════════════════════════
  const tenant = express.Router();
  tenant.use(protect, requireTenant);   // <── both guards on every route

  tenant.get('/settings', tenantCtrl.getSettings);

  tenant.patch('/settings/business', [
    body('businessName').optional().trim().isLength({ max: 100 }),
    body('city').optional().trim().isLength({ max: 50 }),
    body('currency').optional().isIn(['INR', 'USD', 'EUR', 'GBP', 'AED']),
    body('phone').optional().matches(/^[+]?[\d\s\-()]{7,20}$/).withMessage('Invalid phone.'),
  ], validate, tenantCtrl.updateBusiness);

  tenant.post('/settings/razorpay', [
    body('keyId').notEmpty().withMessage('Key ID is required.').matches(/^rzp_/).withMessage('Invalid Razorpay Key ID.'),
    body('keySecret').notEmpty().withMessage('Key Secret is required.').isLength({ min: 20 }),
    body('webhookSecret').optional().isString(),
  ], validate, tenantCtrl.saveRazorpay);

  tenant.delete('/settings/razorpay', tenantCtrl.removeRazorpay);

  tenant.post('/settings/crm', [
    body('apiKey').notEmpty().withMessage('API key is required.'),
    body('apiUrl').notEmpty().withMessage('API URL is required.'),
    body('provider').optional().isString(),
  ], validate, tenantCtrl.saveCRM);

  tenant.delete('/settings/crm', tenantCtrl.removeCRM);
  tenant.post('/settings/crm/test', tenantCtrl.testCRM);

  tenant.patch('/settings/password', [
    body('currentPassword').notEmpty().withMessage('Current password is required.'),
    body('newPassword')
      .isLength({ min: 8 }).withMessage('New password must be at least 8 characters.')
      .matches(/[A-Z]/).withMessage('Must contain uppercase.')
      .matches(/[a-z]/).withMessage('Must contain lowercase.')
      .matches(/\d/).withMessage('Must contain a number.'),
    body('confirmPassword').custom((v, { req }) => {
      if (v !== req.body.newPassword) throw new Error('Passwords do not match.');
      return true;
    }),
  ], validate, tenantCtrl.changePassword);

  tenant.get('/quotes', quotesCtrl.getQuotes);
  tenant.get('/quotes/:quoteId', [
    param('quoteId').notEmpty().withMessage('Quote ID is required.'),
  ], validate, quotesCtrl.getQuote);

  tenant.get('/payments', paymentsCtrl.getTenantPayments);

  app.use('/api/tenant', tenant);


  // ══════════════════════════════════════════════════════════════════════════
  // PAYMENTS (public + protected)  /api/payments/*
  // ══════════════════════════════════════════════════════════════════════════
  const payments = express.Router();

  // Public: lookup payment page config by slug
  payments.get('/config/:slug', [param('slug').notEmpty()], validate, paymentsCtrl.getConfig);

  // Public: create a new order
  payments.post('/create-order', limiter(30, 15), [
    body('items').isArray({ min: 1 }).withMessage('Items are required.'),
    body('items.*.name').notEmpty().trim(),
    body('items.*.quantity').isInt({ min: 1 }),
    body('items.*.unitPrice').isFloat({ min: 0.01 }),
    body('customerInfo.name').notEmpty().trim().withMessage('Customer name is required.'),
    body('customerInfo.email').isEmail().normalizeEmail().withMessage('Valid email is required.'),
    body('customerInfo.phone').optional().matches(/^\+?[\d\s\-().]{7,20}$/),
    body('tenantId').notEmpty().withMessage('Tenant ID is required.'),
  ], validate, paymentsCtrl.createOrder);

  // Public: create Razorpay order
  payments.post('/razorpay/create-order', limiter(30, 15), [
    body('orderId').isMongoId().withMessage('Valid order ID is required.'),
    body('tenantId').notEmpty().withMessage('Tenant ID is required.'),
  ], validate, paymentsCtrl.createRazorpayOrder);

  // Public: verify Razorpay payment
  payments.post('/razorpay/verify', limiter(20, 15), [
    body('razorpay_order_id').notEmpty(),
    body('razorpay_payment_id').notEmpty(),
    body('razorpay_signature').notEmpty(),
    body('orderId').isMongoId(),
    body('paymentId').isMongoId(),
    body('tenantId').notEmpty(),
  ], validate, paymentsCtrl.verifyRazorpay);

  // Protected: refund (tenant or superadmin)
  payments.post('/refund', protect, [
    body('paymentId').isMongoId(),
    body('amount').optional().isFloat({ min: 0.01 }),
    body('reason').optional().isString(),
  ], validate, paymentsCtrl.refund);

  // Protected: search
  payments.get('/search', protect, [
    query('q').notEmpty().withMessage('Search query is required.'),
  ], validate, paymentsCtrl.search);

  app.use('/api/payments', payments);


  // ══════════════════════════════════════════════════════════════════════════
  // QUOTES SEARCH  /api/quotes/*
  // ══════════════════════════════════════════════════════════════════════════
  const quotesRouter = express.Router();
  quotesRouter.get('/search', protect, requireTenant, [
    query('q').notEmpty().withMessage('Search query is required.'),
  ], validate, quotesCtrl.search);
  app.use('/api/quotes', quotesRouter);
};