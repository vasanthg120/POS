'use strict';

const crypto = require('crypto');
const Tenant = require('../models/tenant');
const logger = require('./logger');
const { seedTenantRoles } = require('./seedTenantRoles');

// The superadmin's own tenant space uses this fixed tenantId (see
// admin/src/app/components/services/auth.ts SUPERADMIN_TENANT_ID). Every
// regular tenant gets its Owner/Admin/Staff RBAC roles seeded on creation
// (adminController.createTenant → seedTenantRoles) — the superadmin never
// goes through that flow, so it must be seeded here instead, or the RBAC
// page has no roles to select and every role/member action is unreachable.
const SUPERADMIN_TENANT_ID = 'SUPERADMIN';

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
    await seedTenantRoles(SUPERADMIN_TENANT_ID);
    return;
  }

  // Create a fresh superadmin document
  await Tenant.create({
    firstName      : process.env.SUPERADMIN_FIRST_NAME || 'Super',
    lastName       : process.env.SUPERADMIN_LAST_NAME  || 'Admin',
    email,
    password,
    tenantId       : SUPERADMIN_TENANT_ID,
    role           : 'superadmin',
    isActive       : true,
    isEmailVerified: true,
    setupStep      : 'complete',
  });

  await seedTenantRoles(SUPERADMIN_TENANT_ID);

  logger.info(`[SeedSuperAdmin] Superadmin account created: ${email}`);
};

module.exports = seedSuperAdmin;