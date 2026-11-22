'use strict';

/**
 * Validation for the tenant Settings endpoints. The same controller is
 * mounted at /api/tenant/settings/* (routes/index.js) and /tenant/settings/*
 * (routes/tenant.settings.routes.js); both use these rules so the two paths
 * can't drift apart again (the second one had no validation at all).
 */

const { body } = require('express-validator');
const { phoneRule, passwordRule, confirmPasswordRule } = require('../middleware/validate');
const { GSTIN, GSTIN_MESSAGE } = require('../utils/validation');

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];

const businessRules = [
  // The controller always required it; the route said optional, so a blank
  // name got past validation and came back as a bare 400.
  body('businessName').trim()
    .notEmpty().withMessage('Business name is required.')
    .isLength({ max: 100 }).withMessage('Business name must be at most 100 characters.'),
  body('businessAddress').optional({ values: 'falsy' }).isString().trim()
    .isLength({ max: 300 }).withMessage('Business address must be at most 300 characters.'),
  body('city').optional({ values: 'falsy' }).isString().trim()
    .isLength({ max: 50 }).withMessage('City must be at most 50 characters.')
    .matches(/^[\p{L}\p{M}][\p{L}\p{M}\s.'-]*$/u).withMessage('City can contain only letters, spaces, hyphens, apostrophes and dots.'),
  body('currency').optional({ values: 'falsy' })
    .isIn(CURRENCIES).withMessage(`Currency must be one of ${CURRENCIES.join(', ')}.`),
  // Blank phone means "no phone" — `.optional()` used to validate "" and
  // reject every save without a phone as "Invalid phone.".
  phoneRule('phone'),
  // GSTIN format applies to INR (India) businesses; other currencies get a
  // generic tax-number check.
  body('gstNumber').optional({ values: 'falsy' }).isString().trim().toUpperCase()
    .custom((v, { req }) => {
      const currency = (req.body.currency || 'INR').toUpperCase();
      if (currency === 'INR' && !GSTIN.test(v)) throw new Error(GSTIN_MESSAGE);
      if (currency !== 'INR' && !/^[A-Z0-9-]{5,20}$/.test(v)) {
        throw new Error('Tax number must be 5–20 letters or numbers.');
      }
      return true;
    }),
  body('timezone').optional({ values: 'falsy' }).isString().trim()
    .isLength({ max: 64 }).withMessage('Timezone is invalid.'),
];

const razorpayRules = [
  body('keyId').trim()
    .notEmpty().withMessage('Key ID is required.')
    .matches(/^rzp_(test|live)_[A-Za-z0-9]{6,}$/).withMessage('Key ID must look like rzp_test_XXXXXXXX or rzp_live_XXXXXXXX.'),
  body('keySecret').trim()
    .notEmpty().withMessage('Key Secret is required.')
    .isLength({ min: 20, max: 64 }).withMessage('Key Secret looks incomplete — copy the full secret (usually 24 characters) from the Razorpay dashboard.')
    .matches(/^\S+$/).withMessage('Key Secret cannot contain spaces.'),
  body('webhookSecret').optional({ values: 'falsy' }).isString().trim()
    .isLength({ max: 128 }).withMessage('Webhook secret must be at most 128 characters.'),
];

const crmRules = [
  body('apiUrl').trim()
    .notEmpty().withMessage('API URL is required.')
    .isURL({ protocols: ['http', 'https'], require_protocol: true, require_tld: true })
    .withMessage('Enter a full URL starting with http:// or https://.'),
  body('apiKey').trim()
    .notEmpty().withMessage('API key is required.')
    .isLength({ max: 512 }).withMessage('API key must be at most 512 characters.')
    .matches(/^\S+$/).withMessage('API key cannot contain spaces — check it was copied correctly.'),
  body('provider').optional({ values: 'falsy' }).isString().trim(),
];

const changePasswordRules = [
  body('currentPassword').notEmpty().withMessage('Current password is required.'),
  passwordRule('newPassword', 'New password'),
  body('newPassword').custom((v, { req }) => {
    if (v && v === req.body.currentPassword) throw new Error('New password must be different from your current password.');
    return true;
  }),
  confirmPasswordRule('confirmPassword', 'newPassword'),
];

module.exports = { businessRules, razorpayRules, crmRules, changePasswordRules };
