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
const superAdminCtrl = require('../controllers/superAdminController');
const royaltyCtrl = require('../controllers/royaltyController');
const billingCtrl = require('../controllers/billingController');
const subscriptionPlanCtrl = require('../controllers/subscriptionPlanController');
const tenantBillingCtrl = require('../controllers/tenantBillingController');

const { protect } = require('../middleware/auth');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const requireTenant = require('../middleware/requireTenant');
const requirePermission = require('../middleware/requirePermission');

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

  // Cross-tenant monitoring snapshot — must be registered BEFORE
  // '/tenants/:tenantId' or Express would match "overview"/"lite" as a tenantId.
  admin.get('/tenants/overview', superAdminCtrl.getTenantsOverview);
  admin.get('/tenants/lite', superAdminCtrl.getTenantsLite);

  admin.get('/tenants/:tenantId', [
    param('tenantId').notEmpty(),
  ], validate, adminCtrl.getTenant);

  admin.get('/tenants/:tenantId/overview', [
    param('tenantId').notEmpty(),
  ], validate, superAdminCtrl.getTenantOverview);

  // Royalty percentage — set from the platform side only; tenants can view
  // but not edit their own rate (see /tenant/royalty/config, GET-only).
  admin.get('/tenants/:tenantId/royalty-config', [
    param('tenantId').notEmpty(),
  ], validate, royaltyCtrl.getConfigForTenant);

  admin.patch('/tenants/:tenantId/royalty-config', [
    param('tenantId').notEmpty(),
    body('percentage').isFloat({ min: 0, max: 100 }).withMessage('Percentage must be between 0 and 100.'),
  ], validate, royaltyCtrl.setConfigForTenant);

  // Cross-tenant Quotation Monitoring / Payment Tracking / Activity
  admin.get('/quotations', superAdminCtrl.getQuotationsAcrossTenants);
  admin.get('/payments', superAdminCtrl.getPaymentsAcrossTenants);
  admin.get('/activity', superAdminCtrl.getActivityFeed);

  admin.patch('/tenants/:tenantId/status', [
    param('tenantId').notEmpty(),
    body('isActive').isBoolean().withMessage('isActive must be true or false.'),
  ], validate, adminCtrl.setTenantStatus);

  // Edit profile / hard delete (superadmin account is guarded off inside the
  // controller).
  admin.patch('/tenants/:tenantId', [
    param('tenantId').notEmpty(),
    body('firstName').optional().trim().notEmpty().isLength({ max: 50 }),
    body('lastName').optional().trim().notEmpty().isLength({ max: 50 }),
    body('email').optional().isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('phone').optional().matches(/^[+]?[\d\s\-()]{7,20}$/).withMessage('Invalid phone number.'),
    body('businessName').optional().trim().isLength({ max: 100 }),
    body('city').optional().trim().isLength({ max: 50 }),
    body('currency').optional().isIn(['INR', 'USD', 'EUR', 'GBP', 'AED']).withMessage('Unsupported currency.'),
  ], validate, adminCtrl.updateTenant);

  admin.delete('/tenants/:tenantId', [
    param('tenantId').notEmpty(),
  ], validate, adminCtrl.deleteTenant);

  admin.post('/tenants/:tenantId/reset-password', [
    param('tenantId').notEmpty(),
  ], validate, adminCtrl.resetTenantPassword);

  // ── Tenant billing / subscriptions ──────────────────────────────────────────

  // Subscription plan catalog
  admin.get('/billing/plans', subscriptionPlanCtrl.listPlans);
  admin.post('/billing/plans', [
    body('name').trim().notEmpty().withMessage('Plan name is required.').isLength({ max: 60 }),
    body('monthlyPrice').isFloat({ min: 0 }).withMessage('Monthly price must be 0 or more.'),
    body('gstPercent').optional().isFloat({ min: 0, max: 100 }),
    body('trialDays').optional().isInt({ min: 0 }),
    body('gracePeriodDays').optional({ nullable: true }).isInt({ min: 0 }),
  ], validate, subscriptionPlanCtrl.createPlan);
  admin.patch('/billing/plans/:planId', [
    param('planId').isMongoId(),
    body('name').optional().trim().notEmpty().isLength({ max: 60 }),
    body('monthlyPrice').optional().isFloat({ min: 0 }),
    body('gstPercent').optional().isFloat({ min: 0, max: 100 }),
    body('trialDays').optional().isInt({ min: 0 }),
    body('gracePeriodDays').optional({ nullable: true }).isInt({ min: 0 }),
  ], validate, subscriptionPlanCtrl.updatePlan);
  admin.patch('/billing/plans/:planId/status', [
    param('planId').isMongoId(),
    body('isActive').isBoolean(),
  ], validate, subscriptionPlanCtrl.setPlanStatus);

  // Cross-tenant billing views — registered BEFORE '/billing/tenants/:tenantId'
  // so Express doesn't treat "follow-ups"/"calendar"/"analytics"/"settings" as a tenantId.
  admin.get('/billing/follow-ups', billingCtrl.getFollowUpBuckets);
  admin.get('/billing/calendar', billingCtrl.getCalendar);
  admin.get('/billing/analytics', billingCtrl.getAnalytics);

  // Platform-wide billing configuration (GST/grace-period/reminder defaults,
  // invoice company details) — superadmin only, same as everything else here.
  admin.get('/billing/settings', billingCtrl.getSettings);
  admin.patch('/billing/settings', [
    body('defaultGstPercent').optional().isFloat({ min: 0, max: 100 }),
    body('defaultGracePeriodDays').optional().isInt({ min: 0 }),
    body('reminderDaysBeforeDue').optional().isArray(),
    body('reminderDaysBeforeDue.*').optional().isInt({ min: 0 }),
    body('reminderDaysOverdue').optional().isArray(),
    body('reminderDaysOverdue.*').optional().isInt({ min: 0 }),
    body('invoiceNumberPrefix').optional().isString().trim().isLength({ max: 10 }),
    body('companyLegalName').optional().isString().trim().isLength({ max: 120 }),
    body('companyGSTIN').optional().isString().trim().isLength({ max: 20 }),
    body('companyAddress').optional().isString().trim().isLength({ max: 300 }),
    body('companyLogoUrl').optional().isString().trim(),
  ], validate, billingCtrl.updateSettings);

  admin.get('/billing/tenants', billingCtrl.getBillingOverview);

  admin.get('/billing/tenants/:tenantId', [
    param('tenantId').notEmpty(),
  ], validate, billingCtrl.getTenantBilling);

  admin.get('/billing/tenants/:tenantId/audit', [
    param('tenantId').notEmpty(),
  ], validate, billingCtrl.getTenantAuditLog);

  admin.patch('/billing/tenants/:tenantId/config', [
    param('tenantId').notEmpty(),
    body('isEnrolled').optional().isBoolean(),
    body('monthlyFee').optional().isFloat({ min: 0 }).withMessage('Monthly fee must be 0 or more.'),
    body('gstPercent').optional().isFloat({ min: 0, max: 100 }).withMessage('GST must be between 0 and 100.'),
    body('discountType').optional().isIn(['percent', 'flat']),
    body('discountValue').optional().isFloat({ min: 0 }),
    body('billingDay').optional().isInt({ min: 1, max: 28 }).withMessage('Billing day must be between 1 and 28.'),
    body('gracePeriodDays').optional({ nullable: true }).isInt({ min: 0 }).withMessage('Grace period must be 0 or more days.'),
    body('trialDays').optional().isInt({ min: 0 }),
  ], validate, billingCtrl.updateConfig);

  admin.post('/billing/tenants/:tenantId/change-plan', [
    param('tenantId').notEmpty(),
    body('planId').isMongoId().withMessage('Valid planId is required.'),
  ], validate, billingCtrl.changePlan);

  admin.post('/billing/tenants/:tenantId/cancel', [
    param('tenantId').notEmpty(),
    body('reason').optional().isString().trim().isLength({ max: 300 }),
  ], validate, billingCtrl.cancelSubscription);

  admin.post('/billing/tenants/:tenantId/invoices/:invoiceId/payment', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0.'),
    body('method').optional().isString().trim().isLength({ max: 50 }),
    body('referenceNumber').optional().isString().trim().isLength({ max: 100 }),
    body('notes').optional().isString().trim().isLength({ max: 500 }),
    body('paidAt').optional().isISO8601().withMessage('Invalid payment date.'),
  ], validate, billingCtrl.recordPayment);

  admin.post('/billing/tenants/:tenantId/invoices/:invoiceId/fail', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
    body('reason').optional().isString().trim().isLength({ max: 300 }),
  ], validate, billingCtrl.markPaymentFailed);

  admin.post('/billing/tenants/:tenantId/invoices/:invoiceId/refund', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
    body('amount').isFloat({ min: 0.01 }).withMessage('Refund amount must be greater than 0.'),
    body('reason').optional().isString().trim().isLength({ max: 300 }),
  ], validate, billingCtrl.issueRefund);

  admin.post('/billing/tenants/:tenantId/invoices/:invoiceId/followup', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
    body('note').trim().notEmpty().withMessage('Follow-up note is required.').isLength({ max: 500 }),
    body('type').optional().isIn(['call', 'email', 'whatsapp', 'sms', 'in_person', 'other']),
    body('contactMethod').optional().isString().trim().isLength({ max: 120 }),
    body('assignedStaffName').optional().isString().trim().isLength({ max: 100 }),
    body('followUpStatus').optional().isIn(['pending', 'contacted', 'promised_to_pay', 'payment_received', 'escalated', 'no_response', 'closed']),
    body('nextFollowUpDate').optional({ nullable: true }).isISO8601().withMessage('Invalid follow-up date.'),
  ], validate, billingCtrl.addFollowUp);

  admin.patch('/billing/tenants/:tenantId/invoices/:invoiceId/followup/:followUpId', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
    param('followUpId').notEmpty(),
    body('followUpStatus').isIn(['pending', 'contacted', 'promised_to_pay', 'payment_received', 'escalated', 'no_response', 'closed']),
  ], validate, billingCtrl.updateFollowUpStatus);

  admin.post('/billing/tenants/:tenantId/invoices/:invoiceId/waive', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
  ], validate, billingCtrl.waiveInvoice);

  admin.get('/billing/tenants/:tenantId/invoices/:invoiceId/pdf', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
  ], validate, billingCtrl.downloadInvoicePdf);

  admin.post('/billing/tenants/:tenantId/reactivate', [
    param('tenantId').notEmpty(),
  ], validate, billingCtrl.reactivate);

  admin.post('/billing/tenants/:tenantId/suspend', [
    param('tenantId').notEmpty(),
    body('reason').optional().isString().trim().isLength({ max: 300 }),
  ], validate, billingCtrl.suspend);

  admin.post('/billing/tenants/:tenantId/invoices/:invoiceId/remind', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
  ], validate, billingCtrl.sendReminder);

  admin.post('/billing/tenants/:tenantId/invoices/:invoiceId/adjustment', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0.'),
    body('type').isIn(['credit', 'debit']).withMessage('Type must be "credit" or "debit".'),
    body('reason').optional().isString().trim().isLength({ max: 300 }),
  ], validate, billingCtrl.applyAdjustment);

  app.use('/api/admin', admin);


  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SETTINGS  /api/tenant/*
  // Requires: valid JWT + role in ['owner', 'admin', 'staff']
  // ══════════════════════════════════════════════════════════════════════════
  const tenant = express.Router();
  tenant.use(protect, requireTenant);   // <── both guards on every route

  tenant.get('/settings', requirePermission('settings', 'view'), tenantCtrl.getSettings);

  tenant.patch('/settings/business', requirePermission('settings', 'edit'), [
    body('businessName').optional().trim().isLength({ max: 100 }),
    body('city').optional().trim().isLength({ max: 50 }),
    body('currency').optional().isIn(['INR', 'USD', 'EUR', 'GBP', 'AED']),
    body('phone').optional().matches(/^[+]?[\d\s\-()]{7,20}$/).withMessage('Invalid phone.'),
  ], validate, tenantCtrl.updateBusiness);

  tenant.post('/settings/razorpay', requirePermission('settings', 'edit'), [
    body('keyId').notEmpty().withMessage('Key ID is required.').matches(/^rzp_/).withMessage('Invalid Razorpay Key ID.'),
    body('keySecret').notEmpty().withMessage('Key Secret is required.').isLength({ min: 20 }),
    body('webhookSecret').optional().isString(),
  ], validate, tenantCtrl.saveRazorpay);

  tenant.delete('/settings/razorpay', requirePermission('settings', 'edit'), tenantCtrl.removeRazorpay);

  tenant.post('/settings/crm', requirePermission('settings', 'edit'), [
    body('apiKey').notEmpty().withMessage('API key is required.'),
    body('apiUrl').notEmpty().withMessage('API URL is required.'),
    body('provider').optional().isString(),
  ], validate, tenantCtrl.saveCRM);

  tenant.delete('/settings/crm', requirePermission('settings', 'edit'), tenantCtrl.removeCRM);
  tenant.post('/settings/crm/test', requirePermission('settings', 'view'), tenantCtrl.testCRM);

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

  tenant.get('/quotes', requirePermission('quotations', 'view'), quotesCtrl.getQuotes);
  tenant.get('/quotes/:quoteId', requirePermission('quotations', 'view'), [
    param('quoteId').notEmpty().withMessage('Quote ID is required.'),
  ], validate, quotesCtrl.getQuote);

  tenant.get('/payments', requirePermission('payments', 'view'), paymentsCtrl.getTenantPayments);

  // Own subscription/billing — read-only except paying their own outstanding
  // invoice online below (config/manual payment recording stay superadmin-only,
  // wired under /api/admin/billing above).
  tenant.get('/billing', requirePermission('billing', 'view'), tenantBillingCtrl.getMyBilling);
  tenant.get('/billing/invoices/:invoiceId/pdf', requirePermission('billing', 'view'), [
    param('invoiceId').notEmpty(),
  ], validate, tenantBillingCtrl.downloadMyInvoicePdf);

  tenant.post('/billing/invoices/:invoiceId/pay', requirePermission('billing', 'view'), limiter(20, 15), [
    param('invoiceId').notEmpty(),
  ], validate, tenantBillingCtrl.createPaymentOrder);

  tenant.post('/billing/invoices/:invoiceId/verify', requirePermission('billing', 'view'), limiter(20, 15), [
    param('invoiceId').notEmpty(),
    body('razorpay_order_id').notEmpty(),
    body('razorpay_payment_id').notEmpty(),
    body('razorpay_signature').notEmpty(),
  ], validate, tenantBillingCtrl.verifyPayment);

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
  payments.post('/refund', protect, requirePermission('payments', 'edit'), [
    body('paymentId').isMongoId(),
    body('amount').optional().isFloat({ min: 0.01 }),
    body('reason').optional().isString(),
  ], validate, paymentsCtrl.refund);

  // Protected: search
  payments.get('/search', protect, requirePermission('payments', 'view'), [
    query('q').notEmpty().withMessage('Search query is required.'),
  ], validate, paymentsCtrl.search);

  app.use('/api/payments', payments);


  // ══════════════════════════════════════════════════════════════════════════
  // QUOTES SEARCH  /api/quotes/*
  // ══════════════════════════════════════════════════════════════════════════
  const quotesRouter = express.Router();
  quotesRouter.get('/search', protect, requireTenant, requirePermission('quotations', 'view'), [
    query('q').notEmpty().withMessage('Search query is required.'),
  ], validate, quotesCtrl.search);
  app.use('/api/quotes', quotesRouter);
};