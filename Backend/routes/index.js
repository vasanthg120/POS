'use strict';

// ════════════════════════════════════════════════════════════════════════════
// routes/index.js
// Registers all routes with role-based access control.
//
// Role matrix:
//   superadmin → /api/admin/*  (full platform control — the ONE organisation
//                Super Admin account; the only place tenants are created)
//   tenant     → /api/tenant/* (own data only; team members are role 'tenant'
//                and are limited further by RBAC page permissions)
//   public     → /api/payments/config, /api/payments/create-order, etc.
//   There is no self-registration: no public route creates an account.
// ════════════════════════════════════════════════════════════════════════════

const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, param, query } = require('express-validator');
const {
  validate, phoneRule, personNameRule, passwordRule, confirmPasswordRule, emailRule, dateRule, reasonRule,
} = require('../middleware/validate');
const { GSTIN, GSTIN_MESSAGE } = require('../utils/validation');
const settingsRules = require('./tenant.settings.rules');

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
const apiKeyCtrl = require('../controllers/apiKeyController');

const { protect } = require('../middleware/auth');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const requireTenant = require('../middleware/requireTenant');
const requirePermission = require('../middleware/requirePermission');

// Validation runner + shared field rules: middleware/validate.js

// ── Rate limiter factory ──────────────────────────────────────────────────────
const limiter = (max, windowMinutes = 15) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Please try again later.' },
  });

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];
const currencyRule = () => body('currency').optional({ values: 'falsy' })
  .isIn(CURRENCIES).withMessage(`Currency must be one of ${CURRENCIES.join(', ')}.`);
const FOLLOW_UP_STATUSES = ['pending', 'contacted', 'promised_to_pay', 'payment_received', 'escalated', 'no_response', 'closed'];

const razorpayVerifyRules = () => [
  body('razorpay_order_id').notEmpty().withMessage('Payment verification failed: the Razorpay order ID is missing.'),
  body('razorpay_payment_id').notEmpty().withMessage('Payment verification failed: the Razorpay payment ID is missing.'),
  body('razorpay_signature').notEmpty().withMessage('Payment verification failed: the Razorpay signature is missing.'),
];

// Line items for a customer order. Negative quantities/prices used to pass
// the public create-order route (two negatives make a positive total).
const MAX_ORDER_AMOUNT = 10_000_000; // ₹1 crore per line — well above any real quote
const orderItemRules = () => [
  body('items').isArray({ min: 1, max: 50 }).withMessage('The order must contain between 1 and 50 items.'),
  body('items.*.name').trim()
    .notEmpty().withMessage('Every item needs a name.')
    .isLength({ max: 200 }).withMessage('Item names must be at most 200 characters.'),
  body('items.*.quantity')
    .isInt({ min: 1, max: 100000 }).withMessage('Item quantity must be a whole number of at least 1.'),
  body('items.*.unitPrice')
    .isFloat({ min: 0.01, max: MAX_ORDER_AMOUNT }).withMessage(`Item price must be between ₹0.01 and ₹${MAX_ORDER_AMOUNT.toLocaleString('en-IN')}.`),
];

module.exports = (app) => {

  // ══════════════════════════════════════════════════════════════════════════
  // AUTH  /api/auth/*   (public — no role guard)
  // ══════════════════════════════════════════════════════════════════════════
  const auth = express.Router();

  auth.post('/login', limiter(10, 15), [
    emailRule('email'),
    // Sign-in only checks presence — the strength policy applies when a
    // password is set, not when an existing one is entered.
    body('password').notEmpty().withMessage('Password is required.'),
  ], validate, authCtrl.login);

  auth.post('/forgot-password', limiter(5, 60), [
    emailRule('email'),
  ], validate, authCtrl.forgotPassword);

  auth.post('/reset-password', limiter(10, 60), [
    body('token').notEmpty().withMessage('This reset link is invalid. Please request a new one.'),
    passwordRule('password', 'Password'),
    confirmPasswordRule('confirmPassword', 'password'),
  ], validate, authCtrl.resetPassword);

  auth.get('/verify-email', [
    query('token').notEmpty().withMessage('Verification token is required.'),
  ], validate, authCtrl.verifyEmail);

  auth.post('/resend-verification', limiter(5, 60), [
    emailRule('email'),
  ], validate, authCtrl.resendVerification);

  auth.post('/refresh', authCtrl.refresh);
  auth.post('/logout', protect, authCtrl.logout);
  auth.get('/me', protect, authCtrl.me);

  app.use('/api/auth', auth);


  // ══════════════════════════════════════════════════════════════════════════
  // SUPERADMIN  /api/admin/*
  // Requires: valid JWT + the organisation Super Admin account, verified
  // against the database (middleware/requireSuperAdmin.js). Team members of
  // the Super Admin never pass, whatever RBAC permissions they hold.
  // ══════════════════════════════════════════════════════════════════════════
  const admin = express.Router();
  admin.use(protect, requireSuperAdmin);   // <── both guards on every route

  // Provision a new tenant (generates credentials, sends welcome email).
  // The ONLY tenant-creation endpoint in the system.
  // ── POST /api/admin/tenants
  admin.post('/tenants', [
    personNameRule('firstName', 'First name'),
    personNameRule('lastName', 'Last name'),
    emailRule('email'),
    // The tenant form requires a phone; enforce the same here.
    phoneRule('phone', { required: true }),
    body('businessName').optional({ values: 'falsy' }).trim()
      .isLength({ max: 100 }).withMessage('Business name must be at most 100 characters.'),
    body('city').optional({ values: 'falsy' }).trim()
      .isLength({ max: 50 }).withMessage('City must be at most 50 characters.'),
    currencyRule(),
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

  // One quotation in full, for the Super Admin detail drawer.
  admin.get('/tenants/:tenantId/quotes/:quoteId', [
    param('tenantId').notEmpty(),
    param('quoteId').notEmpty().isLength({ max: 64 }),
  ], validate, superAdminCtrl.getTenantQuoteDetail);

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
    // Each field is optional on edit, but if sent it must be valid (an empty
    // first/last name is rejected rather than silently blanking the name).
    body('firstName').if(body('firstName').exists()).trim()
      .notEmpty().withMessage('First name is required.'),
    personNameRule('firstName', 'First name', { required: false }),
    body('lastName').if(body('lastName').exists()).trim()
      .notEmpty().withMessage('Last name is required.'),
    personNameRule('lastName', 'Last name', { required: false }),
    emailRule('email', { required: false }),
    phoneRule('phone'),
    body('businessName').optional({ values: 'falsy' }).trim()
      .isLength({ max: 100 }).withMessage('Business name must be at most 100 characters.'),
    body('city').optional({ values: 'falsy' }).trim()
      .isLength({ max: 50 }).withMessage('City must be at most 50 characters.'),
    currencyRule(),
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
  // Same rules for create and edit; on edit every field is optional.
  const planRules = ({ partial }) => {
    const opt = (f) => (partial ? body(f).optional({ values: 'null' }) : body(f));
    return [
      (partial ? body('name').optional() : body('name')).trim()
        .notEmpty().withMessage('Plan name is required.')
        .isLength({ max: 60 }).withMessage('Plan name must be at most 60 characters.'),
      body('description').optional({ values: 'falsy' }).isString().trim()
        .isLength({ max: 500 }).withMessage('Description must be at most 500 characters.'),
      opt('monthlyPrice')
        .notEmpty().withMessage('Monthly price is required.')
        .isFloat({ min: 0 }).withMessage('Monthly price must be a number, 0 or more.'),
      body('gstPercent').optional({ values: 'null' })
        .isFloat({ min: 0, max: 100 }).withMessage('GST % must be between 0 and 100.'),
      body('trialDays').optional({ values: 'null' })
        .isInt({ min: 0, max: 365 }).withMessage('Trial days must be a whole number from 0 to 365.'),
      body('gracePeriodDays').optional({ values: 'null' })
        .isInt({ min: 0, max: 365 }).withMessage('Grace period must be a whole number of days from 0 to 365.'),
      body('features').optional().isArray({ max: 30 }).withMessage('A plan can list at most 30 features.'),
      body('features.*').isString().trim()
        .isLength({ max: 120 }).withMessage('Each feature must be at most 120 characters.'),
    ];
  };

  admin.post('/billing/plans', planRules({ partial: false }), validate, subscriptionPlanCtrl.createPlan);
  admin.patch('/billing/plans/:planId', [
    param('planId').isMongoId().withMessage('Invalid plan ID.'),
    ...planRules({ partial: true }),
  ], validate, subscriptionPlanCtrl.updatePlan);
  admin.patch('/billing/plans/:planId/status', [
    param('planId').isMongoId().withMessage('Invalid plan ID.'),
    body('isActive').isBoolean().withMessage('isActive must be true or false.'),
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
    body('defaultGstPercent').optional({ values: 'null' })
      .isFloat({ min: 0, max: 100 }).withMessage('Default GST % must be between 0 and 100.'),
    body('defaultGracePeriodDays').optional({ values: 'null' })
      .isInt({ min: 0, max: 365 }).withMessage('Default grace period must be a whole number of days from 0 to 365.'),
    body('reminderDaysBeforeDue').optional()
      .isArray({ max: 10 }).withMessage('Reminder days before due date must be a list of at most 10 numbers.'),
    body('reminderDaysBeforeDue.*')
      .isInt({ min: 0, max: 90 }).withMessage('Reminder days before due date must be whole numbers from 0 to 90.'),
    body('reminderDaysOverdue').optional()
      .isArray({ max: 10 }).withMessage('Reminder days after due date must be a list of at most 10 numbers.'),
    body('reminderDaysOverdue.*')
      .isInt({ min: 0, max: 365 }).withMessage('Reminder days after due date must be whole numbers from 0 to 365.'),
    body('invoiceNumberPrefix').optional({ values: 'falsy' }).isString().trim()
      .isLength({ max: 10 }).withMessage('Invoice number prefix must be at most 10 characters.')
      .matches(/^[A-Za-z0-9\-/]+$/).withMessage('Invoice number prefix can contain only letters, numbers, "-" and "/".'),
    body('companyLegalName').optional({ values: 'falsy' }).isString().trim()
      .isLength({ max: 120 }).withMessage('Company legal name must be at most 120 characters.'),
    body('companyGSTIN').optional({ values: 'falsy' }).isString().trim().toUpperCase()
      .matches(GSTIN).withMessage(GSTIN_MESSAGE),
    body('companyAddress').optional({ values: 'falsy' }).isString().trim()
      .isLength({ max: 300 }).withMessage('Company address must be at most 300 characters.'),
    body('companyLogoUrl').optional({ values: 'falsy' }).isString().trim()
      .isURL({ protocols: ['http', 'https'], require_protocol: true }).withMessage('Company logo URL must be a full http(s):// link.'),
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
    body('isEnrolled').optional().isBoolean().withMessage('Enrolment must be true or false.'),
    body('monthlyFee').optional({ values: 'null' })
      .isFloat({ min: 0 }).withMessage('Monthly fee must be a number, 0 or more.'),
    body('gstPercent').optional({ values: 'null' })
      .isFloat({ min: 0, max: 100 }).withMessage('GST % must be between 0 and 100.'),
    body('discountType').optional({ values: 'null' })
      .isIn(['percent', 'flat']).withMessage('Discount type must be "percent" or "flat".'),
    body('discountValue').optional({ values: 'null' })
      .isFloat({ min: 0 }).withMessage('Discount must be a number, 0 or more.')
      // A percentage discount above 100% produced negative invoices.
      .custom((v, { req }) => {
        if (req.body.discountType === 'percent' && Number(v) > 100) throw new Error('A percentage discount cannot exceed 100%.');
        return true;
      }),
    body('billingDay').optional({ values: 'null' })
      .isInt({ min: 1, max: 28 }).withMessage('Billing day must be a whole number from 1 to 28.'),
    body('gracePeriodDays').optional({ values: 'null' })
      .isInt({ min: 0, max: 365 }).withMessage('Grace period must be a whole number of days from 0 to 365.'),
    body('trialDays').optional({ values: 'null' })
      .isInt({ min: 0, max: 365 }).withMessage('Trial days must be a whole number from 0 to 365.'),
  ], validate, billingCtrl.updateConfig);

  admin.post('/billing/tenants/:tenantId/change-plan', [
    param('tenantId').notEmpty(),
    body('planId').isMongoId().withMessage('Valid planId is required.'),
  ], validate, billingCtrl.changePlan);

  admin.post('/billing/tenants/:tenantId/cancel', [
    param('tenantId').notEmpty(),
    reasonRule(),
  ], validate, billingCtrl.cancelSubscription);

  admin.post('/billing/tenants/:tenantId/invoices/:invoiceId/payment', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0.'),
    body('method').optional({ values: 'falsy' }).isString().trim()
      .isLength({ max: 50 }).withMessage('Payment method must be at most 50 characters.'),
    body('referenceNumber').optional({ values: 'falsy' }).isString().trim()
      .isLength({ max: 100 }).withMessage('Reference number must be at most 100 characters.'),
    body('notes').optional({ values: 'falsy' }).isString().trim()
      .isLength({ max: 500 }).withMessage('Notes must be at most 500 characters.'),
    dateRule('paidAt', 'Payment date', { notFuture: true }),
  ], validate, billingCtrl.recordPayment);

  admin.post('/billing/tenants/:tenantId/invoices/:invoiceId/fail', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
    reasonRule(),
  ], validate, billingCtrl.markPaymentFailed);

  admin.post('/billing/tenants/:tenantId/invoices/:invoiceId/refund', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
    body('amount').isFloat({ min: 0.01 }).withMessage('Refund amount must be greater than 0.'),
    reasonRule(),
  ], validate, billingCtrl.issueRefund);

  admin.post('/billing/tenants/:tenantId/invoices/:invoiceId/followup', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
    body('note').trim().notEmpty().withMessage('Follow-up note is required.')
      .isLength({ max: 500 }).withMessage('Follow-up note must be at most 500 characters.'),
    body('type').optional({ values: 'falsy' })
      .isIn(['call', 'email', 'whatsapp', 'sms', 'in_person', 'other']).withMessage('Choose a valid follow-up type.'),
    body('contactMethod').optional({ values: 'falsy' }).isString().trim()
      .isLength({ max: 120 }).withMessage('Contact method must be at most 120 characters.'),
    body('assignedStaffName').optional({ values: 'falsy' }).isString().trim()
      .isLength({ max: 100 }).withMessage('Assigned staff name must be at most 100 characters.'),
    body('followUpStatus').optional({ values: 'falsy' })
      .isIn(FOLLOW_UP_STATUSES).withMessage('Choose a valid follow-up status.'),
    dateRule('nextFollowUpDate', 'Next follow-up date', { notPast: true }),
  ], validate, billingCtrl.addFollowUp);

  admin.patch('/billing/tenants/:tenantId/invoices/:invoiceId/followup/:followUpId', [
    param('tenantId').notEmpty(),
    param('invoiceId').notEmpty(),
    param('followUpId').notEmpty(),
    body('followUpStatus').isIn(FOLLOW_UP_STATUSES).withMessage('Choose a valid follow-up status.'),
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
    reasonRule(),
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
    reasonRule(),
  ], validate, billingCtrl.applyAdjustment);

  app.use('/api/admin', admin);


  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SETTINGS  /api/tenant/*
  // Requires: valid JWT + role in ['owner', 'admin', 'staff']
  // ══════════════════════════════════════════════════════════════════════════
  const tenant = express.Router();
  tenant.use(protect, requireTenant);   // <── both guards on every route

  tenant.get('/settings', requirePermission('settings', 'view'), tenantCtrl.getSettings);

  tenant.patch('/settings/business', requirePermission('settings', 'edit'),
    settingsRules.businessRules, validate, tenantCtrl.updateBusiness);

  tenant.post('/settings/razorpay', requirePermission('settings', 'edit'),
    settingsRules.razorpayRules, validate, tenantCtrl.saveRazorpay);

  tenant.delete('/settings/razorpay', requirePermission('settings', 'edit'), tenantCtrl.removeRazorpay);

  tenant.post('/settings/crm', requirePermission('settings', 'edit'),
    settingsRules.crmRules, validate, tenantCtrl.saveCRM);

  tenant.delete('/settings/crm', requirePermission('settings', 'edit'), tenantCtrl.removeCRM);
  tenant.post('/settings/crm/test', requirePermission('settings', 'view'), tenantCtrl.testCRM);

  // Same password policy as reset-password (special character was not
  // required here before, so the two flows disagreed).
  tenant.patch('/settings/password', settingsRules.changePasswordRules, validate, tenantCtrl.changePassword);

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
    ...razorpayVerifyRules(),
  ], validate, tenantBillingCtrl.verifyPayment);

  // ── Settings → API Integration (Haive AI Agent) ──────────────────────────
  // Account owners only (tenant owner, or the Super Admin for its own space).
  // The keys authenticate the integration API at /api/v1
  // (routes/integration.v1.routes.js).
  tenant.get('/integrations/api-key', apiKeyCtrl.ownerOnly, apiKeyCtrl.getStatus);
  tenant.post('/integrations/api-key', limiter(10, 15), apiKeyCtrl.ownerOnly, apiKeyCtrl.generate);
  tenant.post('/integrations/api-key/regenerate', limiter(10, 15), apiKeyCtrl.ownerOnly, apiKeyCtrl.regenerate);
  tenant.delete('/integrations/api-key', limiter(10, 15), apiKeyCtrl.ownerOnly, apiKeyCtrl.revoke);

  app.use('/api/tenant', tenant);


  // ══════════════════════════════════════════════════════════════════════════
  // PAYMENTS (public + protected)  /api/payments/*
  // ══════════════════════════════════════════════════════════════════════════
  const payments = express.Router();

  // Public: lookup payment page config by slug
  payments.get('/config/:slug', [param('slug').notEmpty()], validate, paymentsCtrl.getConfig);

  // Public: create a new order
  payments.post('/create-order', limiter(30, 15), [
    ...orderItemRules(),
    body('customerInfo.name').trim()
      .notEmpty().withMessage('Customer name is required.')
      .isLength({ max: 100 }).withMessage('Customer name must be at most 100 characters.'),
    emailRule('customerInfo.email', { label: 'Customer email' }),
    phoneRule('customerInfo.phone'),
    body('tenantId').notEmpty().withMessage('This payment link is incomplete. Please use the link the business sent you.'),
  ], validate, paymentsCtrl.createOrder);

  // Public: create Razorpay order
  payments.post('/razorpay/create-order', limiter(30, 15), [
    body('orderId').isMongoId().withMessage('This order reference is invalid. Please start the payment again.'),
    body('tenantId').notEmpty().withMessage('This payment link is incomplete. Please use the link the business sent you.'),
  ], validate, paymentsCtrl.createRazorpayOrder);

  // Public: verify Razorpay payment
  payments.post('/razorpay/verify', limiter(20, 15), [
    ...razorpayVerifyRules(),
    body('orderId').isMongoId().withMessage('This order reference is invalid.'),
    body('paymentId').isMongoId().withMessage('This payment reference is invalid.'),
    body('tenantId').notEmpty().withMessage('This payment link is incomplete.'),
  ], validate, paymentsCtrl.verifyRazorpay);

  // Protected: refund (tenant or superadmin)
  payments.post('/refund', protect, requirePermission('payments', 'edit'), [
    body('paymentId').isMongoId().withMessage('Invalid payment ID.'),
    body('amount').optional({ values: 'falsy' })
      .isFloat({ min: 0.01 }).withMessage('Refund amount must be greater than 0.'),
    reasonRule('reason', { label: 'Refund reason' }),
  ], validate, paymentsCtrl.refund);

  // Protected: search
  payments.get('/search', protect, requirePermission('payments', 'view'), [
    query('q').trim().notEmpty().withMessage('Enter something to search for.')
      .isLength({ max: 100 }).withMessage('Search text must be at most 100 characters.'),
  ], validate, paymentsCtrl.search);

  app.use('/api/payments', payments);


  // ══════════════════════════════════════════════════════════════════════════
  // QUOTES SEARCH  /api/quotes/*
  // ══════════════════════════════════════════════════════════════════════════
  const quotesRouter = express.Router();
  quotesRouter.get('/search', protect, requireTenant, requirePermission('quotations', 'view'), [
    query('q').trim().notEmpty().withMessage('Enter something to search for.')
      .isLength({ max: 100 }).withMessage('Search text must be at most 100 characters.'),
  ], validate, quotesCtrl.search);
  app.use('/api/quotes', quotesRouter);
};