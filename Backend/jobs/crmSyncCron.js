'use strict';

const cron = require('node-cron');
const logger = require('../utils/logger');
const { syncAllTenants, intervalMinutes } = require('../services/crmSync.service');

const run = (trigger) => {
  syncAllTenants({ trigger }).catch((err) => logger.error(`[CRM Sync] ${trigger} run crashed: ${err.stack}`));
};

/**
 * Keeps every connected CRM mirrored into MongoDB: one pass shortly after
 * startup (catch-up after downtime), then every CRM_SYNC_INTERVAL_MINUTES
 * (default 10, allowed 1–59). Disable with ENABLE_CRM_SYNC_CRON=false.
 * Each tenant still refreshes on demand ("Sync now", or a read that finds
 * its data older than CRM_SYNC_STALE_MINUTES).
 */
const start = () => {
  const minutes = intervalMinutes();
  setTimeout(() => run('startup'), 15_000).unref?.();
  cron.schedule(`*/${minutes} * * * *`, () => run('scheduled'));
  logger.info(`[CRM Sync] Scheduled every ${minutes} minute(s).`);
};

module.exports = { start };
