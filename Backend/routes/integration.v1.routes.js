'use strict';

/**
 * routes/integration.v1.routes.js — POS Integration API, version 1.
 * Mounted at /api/v1 (app.js). Production nginx already proxies /api/*.
 *
 * Authentication: an API key from Settings → API Integration, sent as
 *   Authorization: Bearer <key>    or    X-API-Key: <key>
 * Every request is scoped to the key's tenant (middleware/requireApiKey.js).
 *
 * Adding a resource in a later phase:
 *   1. write its handlers in controllers/integrationV1Controller.js
 *      (tenant-scoped, POS database only, public v1 shapes);
 *   2. in RESOURCES below, set `status: 'available'` and `mount` its routes.
 * Discovery (GET /api/v1) lists every resource with its path, scope and status.
 *
 * Breaking changes go into /api/v2; v1 shapes only ever gain fields.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { query, param } = require('express-validator');
const { validate } = require('../middleware/validate');
const { requireApiKey, requireScope } = require('../middleware/requireApiKey');
const ctrl = require('../controllers/integrationV1Controller');

const intEnv = (name, def) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

const limited = (code) => (_req, res) => res.status(429).json({
  success: false, code, message: 'Too many requests. Slow down and retry after the time in the Retry-After header.',
});

// Before authentication: per client IP, to blunt key guessing.
const ipLimiter = rateLimit({
  windowMs: 60_000,
  max: intEnv('INTEGRATION_IP_RATE_LIMIT_PER_MIN', 300),
  standardHeaders: true,
  legacyHeaders: false,
  handler: limited('RATE_LIMITED'),
});

// After authentication: per API key, whatever IPs it is used from.
const keyLimiter = rateLimit({
  windowMs: 60_000,
  max: intEnv('INTEGRATION_KEY_RATE_LIMIT_PER_MIN', 120),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `key:${req.integration.keyId}`,
  handler: limited('RATE_LIMITED'),
});

const listRules = [
  query('page').optional().isInt({ min: 1, max: 100000 }).withMessage('page must be a whole number of 1 or more.'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100.'),
];

/**
 * Every v1 resource, available or planned. Planned ones are reserved paths:
 * authenticated callers get 501 NOT_IMPLEMENTED until they ship.
 */
const RESOURCES = [
  {
    name: 'quotations',
    scope: 'quotations:read',
    methods: ['GET'],
    status: 'available',
    description: 'Quotations synced from the CRM, with POS payment and pipeline status.',
    mount: (r) => {
      r.get('/quotations', [
        ...listRules,
        query('sort').optional().isIn(['createdAt', '-createdAt', 'amount', '-amount', 'syncedAt', '-syncedAt'])
          .withMessage('sort must be one of createdAt, -createdAt, amount, -amount, syncedAt, -syncedAt.'),
        query('createdFrom').optional().isISO8601().withMessage('createdFrom must be an ISO 8601 date.'),
        query('createdTo').optional().isISO8601().withMessage('createdTo must be an ISO 8601 date.'),
        query('updatedSince').optional().isISO8601().withMessage('updatedSince must be an ISO 8601 date-time.'),
        query('number').optional().isString().isLength({ max: 40 }).withMessage('number is at most 40 characters.'),
      ], validate, ctrl.listQuotations);
      r.get('/quotations/:id', [
        param('id').isString().trim().isLength({ min: 1, max: 64 }).withMessage('Invalid quotation id.'),
      ], validate, ctrl.getQuotation);
    },
  },
  { name: 'sales',     scope: 'sales:read',     methods: ['GET'], status: 'planned', description: 'Sales and revenue records.' },
  { name: 'orders',    scope: 'orders:read',    methods: ['GET'], status: 'planned', description: 'Orders created through the payment page.' },
  { name: 'customers', scope: 'customers:read', methods: ['GET'], status: 'planned', description: 'Customers and their contact details.' },
  { name: 'products',  scope: 'products:read',  methods: ['GET'], status: 'planned', description: 'Product catalogue.' },
  { name: 'inventory', scope: 'inventory:read', methods: ['GET'], status: 'planned', description: 'Stock levels.' },
  { name: 'reports',   scope: 'reports:read',   methods: ['GET'], status: 'planned', description: 'Aggregated business reports.' },
];

const router = express.Router();

// Integration responses are per-tenant data: never cache them in shared caches.
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(ipLimiter, requireApiKey, keyLimiter);

router.get('/', ctrl.discovery(RESOURCES));

for (const resource of RESOURCES) {
  const scoped = express.Router();
  scoped.use(`/${resource.name}`, requireScope(resource.scope));
  if (resource.status === 'available') resource.mount(scoped);
  else scoped.all([`/${resource.name}`, `/${resource.name}/*`], ctrl.notYetAvailable(resource.name));
  router.use(scoped);
}

// Unknown paths inside v1 answer in the API's own format.
router.use((req, res) => res.status(404).json({
  success: false, code: 'NOT_FOUND', message: `No such endpoint: ${req.method} /api/v1${req.path}`,
}));

// Errors inside v1: never leak internals; the global handler logs them.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  require('../utils/logger').error(`[IntegrationAPI] ${req.method} ${req.originalUrl.split('?')[0]} keyId=${req.integration?.keyId ?? '-'}: ${err.message}`);
  res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please retry.' });
});

module.exports = router;
module.exports.RESOURCES = RESOURCES;
