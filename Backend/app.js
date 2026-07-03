'use strict';
require('dotenv').config();

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
const path           = require('path');

// ✅ REMOVED broken authMiddleware import — auth is handled inside the router 

const app = express();
app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const allowedOrigins = [
  ...(process.env.FRONTEND_URL || 'http://localhost:4200').split(',').map(s => s.trim()),
  'http://localhost:4200',
];

app.use(cors({
  origin      : (origin, cb) => { if (!origin || allowedOrigins.includes(origin)) return cb(null, true); cb(new Error(`CORS: ${origin} not allowed`)); },
  credentials : true,
  methods     : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-idempotency-key'],
  maxAge: 3600,
}));

app.use(compression({ level: 6, threshold: 1024 }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

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
}));

// ✅ Tenant settings — auth handled inside the router via protect middleware
const tenantSettingsRouter = require('./routes/tenant.settings.routes');
app.use('/tenant/settings', tenantSettingsRouter);

const statementsRouter = require('./routes/razorpay.statements.routes');
app.use('/tenant/statements', statementsRouter);

const quotationsRouter = require('./routes/crm.quotes.routes');
app.use('/tenant/quotes', quotationsRouter);

const paymentPagePublic = require('./routes/payment-page.public.routes');
app.use('/public', paymentPagePublic);

const paymentsPublic = require('./routes/payments.public.routes');
app.use('/payments', paymentsPublic);

const marginJobRouter = require('./routes/margin');
app.use('/tenant/margin-jobs', marginJobRouter);

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
  await seedSuperAdmin();

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