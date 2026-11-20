'use strict';

/**
 * middleware/validate.js
 *
 * One validation-error response for every route, plus the reusable rule
 * builders for fields that appear on several routes.
 *
 * Response on failure (HTTP 422):
 *   { success: false, code: 'VALIDATION_ERROR',
 *     message: 'Enter a valid email address. Phone number is invalid.',
 *     errors:  [{ field: 'email', message: 'Enter a valid email address.' }, …] }
 *
 * Previously routes/index.js answered with message "Please fix the following
 * errors." (which every screen showed verbatim, hiding the actual problem)
 * and the member/RBAC routes sent no message at all, so screens fell back to
 * "Invite failed." / "Update failed.". Rules without .withMessage() surfaced
 * as express-validator's default "Invalid value".
 */

const { body, validationResult } = require('express-validator');
const {
  isValidPhone, PHONE_MESSAGE, PERSON_NAME, personNameMessage, passwordProblem,
} = require('../utils/validation');

// Readable names for fields whose rules have no explicit message.
const LABELS = {
  gstPercent: 'GST %', defaultGstPercent: 'Default GST %', monthlyPrice: 'Monthly price',
  monthlyFee: 'Monthly fee', trialDays: 'Trial days', gracePeriodDays: 'Grace period (days)',
  defaultGracePeriodDays: 'Default grace period (days)', billingDay: 'Billing day',
  discountType: 'Discount type', discountValue: 'Discount value', isEnrolled: 'Enrolment',
  reminderDaysBeforeDue: 'Reminder days before due date', reminderDaysOverdue: 'Reminder days after due date',
  invoiceNumberPrefix: 'Invoice number prefix', companyLegalName: 'Company legal name',
  companyGSTIN: 'Company GSTIN', companyAddress: 'Company address', companyLogoUrl: 'Company logo URL',
  referenceNumber: 'Reference number', followUpStatus: 'Follow-up status', nextFollowUpDate: 'Next follow-up date',
  contactMethod: 'Contact method', assignedStaffName: 'Assigned staff name', paidAt: 'Payment date',
  roleId: 'Role', tenantId: 'Tenant', invoiceId: 'Invoice', planId: 'Plan', followUpId: 'Follow-up',
  isActive: 'Status', businessName: 'Business name', businessAddress: 'Business address',
  firstName: 'First name', lastName: 'Last name', gstNumber: 'GST number', keyId: 'Key ID',
  keySecret: 'Key Secret', apiUrl: 'API URL', apiKey: 'API key',
};

const humanize = (path = '') => {
  const leaf = String(path).replace(/\[\d+\]/g, '').split('.').filter(p => p !== '*').pop() || 'Value';
  if (LABELS[leaf]) return LABELS[leaf];
  const words = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const MAX_MESSAGES_IN_SUMMARY = 3;

const validate = (req, res, next) => {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  // One message per field — the first rule that failed (later ones are
  // usually consequences, e.g. "required" then "too short").
  const errors = [];
  const seen = new Set();
  for (const e of result.array()) {
    const field = e.path ?? e.param ?? '';
    if (seen.has(field)) continue;
    seen.add(field);
    const message = !e.msg || e.msg === 'Invalid value' ? `${humanize(field)} is invalid.` : String(e.msg);
    errors.push({ field, message });
  }

  const shown = errors.slice(0, MAX_MESSAGES_IN_SUMMARY).map(e => e.message);
  const more = errors.length - shown.length;
  return res.status(422).json({
    success: false,
    code: 'VALIDATION_ERROR',
    message: shown.join(' ') + (more > 0 ? ` (+${more} more)` : ''),
    errors,
  });
};

/* ── Rule builders ───────────────────────────────────────────────────────── */

/** Phone number. Optional rules treat "" as "not provided". */
const phoneRule = (field = 'phone', { required = false, label = 'Phone number' } = {}) => {
  const chain = required
    ? body(field).trim().notEmpty().withMessage(`${label} is required.`)
    : body(field).optional({ values: 'falsy' }).trim();
  return chain.custom((v) => {
    if (!isValidPhone(v)) throw new Error(PHONE_MESSAGE);
    return true;
  });
};

/** First/last name. */
const personNameRule = (field, label, { required = true, max = 50 } = {}) => {
  const chain = required
    ? body(field).trim().notEmpty().withMessage(`${label} is required.`)
    : body(field).optional({ values: 'falsy' }).trim();
  return chain
    .isLength({ max }).withMessage(`${label} must be at most ${max} characters.`)
    .matches(PERSON_NAME).withMessage(personNameMessage(label));
};

/** Password that must satisfy the shared policy. */
const passwordRule = (field = 'password', label = 'Password') =>
  body(field).custom((v) => {
    const problem = passwordProblem(v, label);
    if (problem) throw new Error(problem);
    return true;
  });

/** "Confirm password" that must equal another field. */
const confirmPasswordRule = (field = 'confirmPassword', matches = 'password') =>
  body(field)
    .notEmpty().withMessage('Please confirm the password.')
    .custom((v, { req }) => {
      if (v !== req.body[matches]) throw new Error('Passwords do not match.');
      return true;
    });

/** Email address. */
const emailRule = (field = 'email', { required = true, label = 'Email address' } = {}) => {
  const chain = required
    ? body(field).trim().notEmpty().withMessage(`${label} is required.`)
    : body(field).optional({ values: 'falsy' }).trim();
  return chain
    .isEmail().withMessage('Enter a valid email address.')
    .isLength({ max: 100 }).withMessage(`${label} must be at most 100 characters.`)
    .normalizeEmail();
};

/**
 * Optional date. `notFuture` / `notPast` compare with a one-day tolerance so a
 * date-only value ("2026-11-21", parsed as UTC midnight) chosen as "today" is
 * accepted in every timezone.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const dateRule = (field, label, { notFuture = false, notPast = false } = {}) =>
  body(field).optional({ values: 'falsy' })
    .isISO8601().withMessage(`${label} is not a valid date.`)
    .custom((v) => {
      const t = new Date(v).getTime();
      if (notFuture && t > Date.now() + DAY_MS) throw new Error(`${label} cannot be in the future.`);
      if (notPast && t < Date.now() - DAY_MS) throw new Error(`${label} cannot be in the past.`);
      return true;
    });

/** Optional free-text reason/notes field. */
const reasonRule = (field = 'reason', { label = 'Reason', max = 300 } = {}) =>
  body(field).optional({ values: 'falsy' })
    .isString().withMessage(`${label} must be text.`).trim()
    .isLength({ max }).withMessage(`${label} must be at most ${max} characters.`);

module.exports = {
  validate,
  humanize,
  phoneRule,
  personNameRule,
  passwordRule,
  confirmPasswordRule,
  emailRule,
  dateRule,
  reasonRule,
};
