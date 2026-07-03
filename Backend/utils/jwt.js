'use strict';
// ════════════════════════════════════════════════════════════════
// utils/jwt.js
// ════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');

const ISSUER   = 'pos-platform';
const AUDIENCE = 'pos-client';

const generateAccessToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m', issuer: ISSUER, audience: AUDIENCE,
  });

const generateRefreshToken = (payload) =>
  jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d', issuer: ISSUER, audience: AUDIENCE,
  });

const verifyAccessToken = (token) =>
  jwt.verify(token, process.env.JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE });

const verifyRefreshToken = (token) =>
  jwt.verify(token, process.env.JWT_REFRESH_SECRET, { issuer: ISSUER, audience: AUDIENCE });

const buildPayload = (tenant) => ({
  sub     : tenant._id,
  email   : tenant.email,
  role    : tenant.role,
  tenantId: tenant.tenantId,
  fullName: tenant.fullName,
});

module.exports = { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken, buildPayload };