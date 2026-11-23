'use strict';

const path = require('path');

const envFile =
  process.env.NODE_ENV === 'production'
    ? '.env.production'
    : '.env';

require('dotenv').config({
  path: path.join(__dirname, envFile),
});

const express        = require('express');
const mongoose       = require('mongoose');
const helmet         = require('helmet');
const cors           = require('cors');
const compression    = require('compression');
const cookieParser   = require('cookie-parser');
const morgan         = require('morgan');
const logger         = require('./utils/logger');
const registerRoutes = require('./routes/index');
const seedSuperAdmin = require('./utils/seedSuperAdmin');
const seedDefaultPlan = require('./utils/seedDefaultPlan');

// ✅ REMOVED broken authMiddleware import — auth is handled inside the router 

const app = express();
app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const allowedOrigins = [
  ...(process.env.FRONTEND_URL || 'http://localhost:4200').split(',').map(s => s.trim()),
  'http://localhost:4200',
  'http://localhost:5173',
];

app.use(cors({
  origin      : (origin, cb) => { if (!origin || allowedOrigins.includes(origin)) return cb(null, true); cb(new Error(`CORS: ${origin} not allowed`)); },
  credentials : true,
  methods     : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-idempotency-key', 'X-API-Key'],
  maxAge: 3600,
}));

app.use(compression({ level: 6, threshold: 1024 }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// Access logs must never contain credentials: redact secret-looking query
// parameters (API keys, reset/verification tokens) from the logged URL.
const SECRET_QUERY_PARAMS = /([?&](?:api[_-]?key|apikey|key|token|access_token|secret|password)=)[^&#]*/gi;
morgan.token('url', (req) => String(req.originalUrl || req.url || '').replace(SECRET_QUERY_PARAMS, '$1[REDACTED]'));

app.use(morgan('combined', {
  stream: { write: msg => logger.info(msg.trim()) },
  skip  : (req) => req.url === '/api/health',
}));

app.use((_req, res, next) => {
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=30, max=100');
  next();
});

app.get('/api/health', (_req, res) => res.json({
  success    : true,
  message    : 'POS Platform API is running',
  timestamp  : new Date().toISOString(),
  environment: process.env.NODE_ENV,
  uptime     : process.uptime(),
  // Git commit the running build came from (set by the Docker build in CI),
  // so a deploy can be checked without guessing from uptime.
  commit     : process.env.GIT_SHA || 'unknown',
}));

// ✅ Tenant settings — auth handled inside the router via protect middleware
const tenantSettingsRouter = require('./routes/tenant.settings.routes');
app.use('/tenant/settings', tenantSettingsRouter);

const statementsRouter = require('./routes/razorpay.statements.routes');
app.use('/tenant/statements', statementsRouter);

// ✅ POS Integration API v1 (Haive AI Agent) — API-key auth, tenant-scoped.
app.use('/api/v1', require('./routes/integration.v1.routes'));

const quotationsRouter = require('./routes/crm.quotes.routes');
app.use('/tenant/quotes', quotationsRouter);

const paymentPagePublic = require('./routes/payment-page.public.routes');
app.use('/public', paymentPagePublic);

const paymentsPublic = require('./routes/payments.public.routes');
app.use('/payments', paymentsPublic);

const marginJobRouter = require('./routes/margin');
app.use('/tenant/margin-jobs', marginJobRouter);

const royaltyRouter = require('./routes/royalty');
app.use('/tenant/royalty', royaltyRouter);

const rbacRoutes = require('./routes/rbac.routes');
app.use('/api/tenant/rbac/roles', rbacRoutes);

const memberRoutes = require('./routes/member.routes');
app.use('/api/tenant/members', memberRoutes);

// ✅ All other routes
registerRoutes(app);

// 404
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found.' }));

// Global error handler
app.use((err, _req, res, _next) => {
  // CRM/sync failures carry a specific, credential-free message — show it
  // (e.g. on Royalty) rather than a generic "Something went wrong."
  if (err?.isCrmError && !res.headersSent) {
    logger.warn(`[CRM] ${err.message}`);
    return res.status(502).json({ success: false, code: 'CRM_ERROR', message: err.message });
  }
  logger.error(`[Unhandled] ${err.stack}`);
  res.status(err.statusCode || 500).json({
    success : false,
    message : process.env.NODE_ENV === 'production' ? 'Something went wrong.' : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI, {
  maxPoolSize             : 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS         : 45000,
}).then(async () => {
  logger.info('✅ MongoDB connected');
  if (process.env.ENABLE_STARTUP_SEEDS !== 'false') {
    await seedSuperAdmin();
    await seedDefaultPlan();
  } else {
    logger.info('[Startup] Database seeding disabled by configuration.');
  }

  if (process.env.ENABLE_BILLING_CRON !== 'false') {
    require('./jobs/billingCron').start();
  } else {
    logger.info('[Startup] Billing cron disabled by configuration.');
  }

  if (process.env.ENABLE_CRM_SYNC_CRON !== 'false') {
    require('./jobs/crmSyncCron').start();
  } else {
    logger.info('[Startup] CRM sync cron disabled by configuration.');
  }

  const server = app.listen(PORT, () => {
    logger.info(`🚀 POS Platform API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout   = 66000;

  const shutdown = async (sig) => {
    logger.info(`${sig} — shutting down`);
    server.close(async () => { await mongoose.connection.close(false); process.exit(0); });
    setTimeout(() => process.exit(1), 10000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

}).catch(err => {
  logger.error(`❌ MongoDB connection failed: ${err.message}`);
  process.exit(1);
});

module.exports = app;