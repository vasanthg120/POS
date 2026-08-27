'use strict';

const cron = require('node-cron');
const logger = require('../utils/logger');
const { runDailyBillingSweep } = require('../services/billing.service');

const run = () => {
  runDailyBillingSweep().catch((err) => logger.error(`[Billing] Sweep crashed: ${err.stack}`));
};

/**
 * Starts the daily billing sweep (invoice generation, reminders, overdue
 * flips, auto-suspend). Runs once on startup — a safety net in case the
 * process was down when the scheduled tick would have fired — then daily
 * at 02:00 server time.
 */
const start = () => {
  run();
  cron.schedule('0 2 * * *', run);
  logger.info('[Billing] Daily sweep scheduled (02:00 server time).');
};

module.exports = { start };
