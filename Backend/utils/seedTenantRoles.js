'use strict';
const RbacRole = require('../models/rbacRole');
const logger   = require('./logger');

const SYSTEM_ROLES = [
  {
    name: 'Owner', slug: 'owner',
    description: 'Full access to all tenant resources. Can manage integrations and team.',
    color: '#0ea5e9', isSystem: true,
    permissions: [
      { pageKey: 'dashboard',         actions: ['view'] },
      { pageKey: 'payments',          actions: ['view','create','edit','delete','export'] },
      { pageKey: 'quotations',        actions: ['view','create','edit','delete','export'] },
      { pageKey: 'tracking',          actions: ['view','edit'] },
      { pageKey: 'margin-calculator', actions: ['view','create'] },
      { pageKey: 'royalty',           actions: ['view','export'] },
      { pageKey: 'billing',           actions: ['view'] },
      { pageKey: 'settings',          actions: ['view','edit'] },
      { pageKey: 'rbac',              actions: ['view','edit'] },
    ],
  },
  {
    name: 'Admin', slug: 'admin',
    description: 'Manage payments and quotations. Cannot access system settings.',
    color: '#4f46e5', isSystem: true,
    permissions: [
      { pageKey: 'dashboard',         actions: ['view'] },
      { pageKey: 'payments',          actions: ['view','create','edit','export'] },
      { pageKey: 'quotations',        actions: ['view','create','edit','export'] },
      { pageKey: 'tracking',          actions: ['view','edit'] },
      { pageKey: 'margin-calculator', actions: ['view','create'] },
      { pageKey: 'royalty',           actions: ['view','export'] },
    ],
  },
  {
    name: 'Staff', slug: 'staff',
    description: 'View-only access to operational data. Cannot modify records.',
    color: '#059669', isSystem: true,
    permissions: [
      { pageKey: 'dashboard',         actions: ['view'] },
      { pageKey: 'payments',          actions: ['view'] },
      { pageKey: 'quotations',        actions: ['view'] },
      { pageKey: 'tracking',          actions: ['view'] },
      { pageKey: 'margin-calculator', actions: ['view'] },
      { pageKey: 'royalty',           actions: ['view'] },
    ],
  },
];

/**
 * Seeds default system roles for a new tenant.
 * Uses $setOnInsert so it's safe to call multiple times.
 */
const seedTenantRoles = async (tenantId) => {
  try {
    const ops = SYSTEM_ROLES.map(role => ({
      updateOne: {
        filter: { tenantId, slug: role.slug },
        update: { $setOnInsert: { ...role, tenantId } },
        upsert: true,
      },
    }));
    const result = await RbacRole.bulkWrite(ops, { ordered: false });
    if (result.upsertedCount > 0) {
      logger.info(`[RBAC] Seeded ${result.upsertedCount} system roles for tenant ${tenantId}`);
    }
  } catch (err) {
    // Non-fatal — log and continue tenant creation
    logger.error(`[RBAC] Seed failed for tenant ${tenantId}: ${err.message}`);
  }
};

module.exports = { seedTenantRoles };