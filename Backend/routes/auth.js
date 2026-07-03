// routes/auth.js — Auth endpoints with rate limiting & validation
'use strict';

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { body, query, validationResult } = require('express-validator');
const authController = require('../controllers/authController');
const { protect }    = require('../middleware/auth');

const router = express.Router();

// ── Shared validation error handler ──────────────────────────────────────
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success : false,
      code    : 'VALIDATION_ERROR',
      message : 'Please fix the following errors.',
      errors  : errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
};

// ── Rate limiters ─────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs       : 15 * 60 * 1000,
  max            : 10,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max     : 5,
  message : { success: false, message: 'Too many password reset requests. Try again in 1 hour.' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max     : 20,
  message : { success: false, message: 'Too many registration attempts. Try again later.' },
});

const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max     : 5,
  message : { success: false, message: 'Too many resend requests. Try again in 1 hour.' },
});

// ── Password strength rules (reusable) ───────────────────────────────────
const passwordRules = () =>
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters.')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter.')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter.')
    .matches(/\d/)
    .withMessage('Password must contain at least one number.')
    .matches(/[@$!%*?&]/)
    .withMessage('Password must contain at least one special character (@$!%*?&).');

// ── Routes ────────────────────────────────────────────────────────────────

// POST /api/auth/register
router.post(
  '/register',
  registerLimiter,
  [
    body('firstName')
      .trim().notEmpty().withMessage('First name is required.')
      .isLength({ max: 50 }).withMessage('First name too long.'),
    body('lastName')
      .trim().notEmpty().withMessage('Last name is required.')
      .isLength({ max: 50 }).withMessage('Last name too long.'),
    body('email')
      .isEmail().withMessage('Valid email is required.')
      .normalizeEmail(),
    body('phone')
      .optional()
      .matches(/^[+]?[\d\s\-()]{7,15}$/)
      .withMessage('Invalid phone number.'),
    passwordRules(),
    body('confirmPassword')
      .custom((value, { req }) => {
        if (value !== req.body.password) throw new Error('Passwords do not match.');
        return true;
      }),
    body('businessName')
      .optional().trim().isLength({ max: 100 }).withMessage('Business name too long.'),
    body('city')
      .optional().trim().isLength({ max: 50 }),
    body('currency')
      .optional().isIn(['INR', 'USD', 'EUR', 'GBP', 'AED'])
      .withMessage('Unsupported currency.'),
    body('termsAccepted')
      .equals('true').withMessage('You must accept the Terms & Conditions.'),
  ],
  validate,
  authController.register
);

// POST /api/auth/login
router.post(
  '/login',
  loginLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('password').notEmpty().withMessage('Password is required.'),
  ],
  validate,
  authController.login
);

// POST /api/auth/resend-verification
router.post(
  '/resend-verification',
  resendLimiter,
  [body('email').isEmail().withMessage('Valid email is required.').normalizeEmail()],
  validate,
  authController.resendVerification
);

// POST /api/auth/forgot-password
router.post(
  '/forgot-password',
  forgotLimiter,
  [body('email').isEmail().withMessage('Valid email is required.').normalizeEmail()],
  validate,
  authController.forgotPassword
);

// POST /api/auth/reset-password
router.post(
  '/reset-password',
  [
    body('token').notEmpty().withMessage('Reset token is required.'),
    passwordRules(),
    body('confirmPassword')
      .custom((value, { req }) => {
        if (value !== req.body.password) throw new Error('Passwords do not match.');
        return true;
      }),
  ],
  validate,
  authController.resetPassword
);

// GET /api/auth/verify-email?token=...
router.get(
  '/verify-email',
  [query('token').notEmpty().withMessage('Token is required.')],
  validate,
  authController.verifyEmail
);

// POST /api/auth/dev/verify-account — DEV ONLY, instantly verifies a stuck account
router.post(
  '/dev/verify-account',
  [body('email').isEmail().withMessage('Valid email is required.').normalizeEmail()],
  validate,
  authController.devVerifyAccount
);

// POST /api/auth/refresh
router.post('/refresh', authController.refresh);

// POST /api/auth/logout
router.post('/logout', protect, authController.logout);

// GET /api/auth/me
router.get('/me', protect, (req, res) => {
  res.status(200).json({ success: true, user: req.user });
});

module.exports = router;