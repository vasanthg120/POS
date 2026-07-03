'use strict';

const crypto = require('crypto');
const Tenant = require('../models/tenant');
const logger = require('./logger');

const seedSuperAdmin = async () => {
  const email    = process.env.SUPERADMIN_EMAIL;
  const password = process.env.SUPERADMIN_PASSWORD;

  if (!email || !password) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '[SeedSuperAdmin] SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD must be set in production.',
      );
    }
    logger.warn('[SeedSuperAdmin] Env vars not set — skipping seed in non-production.');
    return;
  }

  const existing = await Tenant.findOne({ email: email.toLowerCase() });

  if (existing) {
    // Ensure the record has the correct role even if it was created earlier
    if (existing.role !== 'superadmin') {
      existing.role = 'superadmin';
      await existing.save();
      logger.info(`[SeedSuperAdmin] Existing user ${email} promoted to superadmin.`);
    } else {
      logger.info(`[SeedSuperAdmin] Superadmin ${email} already exists — skipping.`);
    }
    return;
  }

  // Create a fresh superadmin document
  await Tenant.create({
    firstName      : process.env.SUPERADMIN_FIRST_NAME || 'Super',
    lastName       : process.env.SUPERADMIN_LAST_NAME  || 'Admin',
    email,
    password,      
    tenantId       : 'SUPERADMIN',
    role           : 'superadmin',
    isActive       : true,
    isEmailVerified: true,
    setupStep      : 'complete',
  });

  logger.info(`[SeedSuperAdmin] Superadmin account created: ${email}`);
};

module.exports = seedSuperAdmin;