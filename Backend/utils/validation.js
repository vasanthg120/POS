'use strict';

/**
 * utils/validation.js
 *
 * The input rules shared by every route, so the same field is validated the
 * same way (with the same message) everywhere. The Angular app mirrors these
 * in admin/src/app/components/validators/validators.ts — change both together.
 */

/* ── Phone ───────────────────────────────────────────────────────────────── */
// Digits plus common separators, optional leading "+", and 7–15 actual digits
// (E.164 allows at most 15). The old patterns differed per route (7–15 vs
// 7–20 characters, with or without "."), and counted separators as digits,
// so "-------" was a valid phone number.
const PHONE_CHARS = /^\+?[\d\s\-().]+$/;
const PHONE_MESSAGE = 'Enter a valid phone number with 7–15 digits (e.g. +91 98765 43210).';

const isValidPhone = (value) => {
  const s = String(value ?? '').trim();
  if (!PHONE_CHARS.test(s)) return false;
  const digits = s.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
};

/* ── Person names ────────────────────────────────────────────────────────── */
// Any script's letters, plus space . ' - (e.g. "R. Kumar", "O'Neil",
// "Anne-Marie", "José"). Must start with a letter.
const PERSON_NAME = /^[\p{L}\p{M}][\p{L}\p{M}\s.'-]*$/u;
const personNameMessage = (label) =>
  `${label} can contain only letters, spaces, apostrophes, hyphens and dots.`;

/* ── Passwords ───────────────────────────────────────────────────────────── */
// One policy everywhere. The special-character check used to accept only
// @$!%*?& — so "Welcome1#" was rejected as having "no special character".
// Max 64: bcrypt ignores everything after 72 bytes.
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 64;

/** First problem with a password, or null if it satisfies the policy. */
const passwordProblem = (pw, label = 'Password') => {
  if (typeof pw !== 'string' || pw.length === 0) return `${label} is required.`;
  if (pw.length < PASSWORD_MIN) return `${label} must be at least ${PASSWORD_MIN} characters.`;
  if (pw.length > PASSWORD_MAX) return `${label} must be at most ${PASSWORD_MAX} characters.`;
  if (!/[A-Z]/.test(pw)) return `${label} must contain at least one uppercase letter.`;
  if (!/[a-z]/.test(pw)) return `${label} must contain at least one lowercase letter.`;
  if (!/\d/.test(pw)) return `${label} must contain at least one number.`;
  if (!/[^A-Za-z0-9\s]/.test(pw)) return `${label} must contain at least one special character (e.g. @ # $ % & *).`;
  return null;
};

/* ── GSTIN (India) ───────────────────────────────────────────────────────── */
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_MESSAGE = 'Enter a valid 15-character GSTIN (e.g. 22AAAAA0000A1Z5).';

/* ── Search input ────────────────────────────────────────────────────────── */
/**
 * Escapes user text for use inside a RegExp / Mongo $regex. Search boxes used
 * to pass raw input, so "+91 98765…" or "(" threw "Invalid regular
 * expression" (a 500), "." matched any character, and a public payment-page
 * slug of ".*" matched any tenant's city.
 */
const escapeRegex = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  PHONE_MESSAGE,
  isValidPhone,
  PERSON_NAME,
  personNameMessage,
  PASSWORD_MIN,
  PASSWORD_MAX,
  passwordProblem,
  GSTIN,
  GSTIN_MESSAGE,
  escapeRegex,
};
