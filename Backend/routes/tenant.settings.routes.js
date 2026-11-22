'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/tenantController'); // ← was tenant.controller
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const {
  businessRules, razorpayRules, crmRules, changePasswordRules,
} = require('./tenant.settings.rules');

router.use(protect);

const requireSettingsEdit = (req, res, next) => {
  if (!req.user.isSubUser) return next();
  const perms = req.user.permissions || [];
  const allowed = perms.find(p => p.pageKey === 'settings')?.actions?.includes('edit');
  if (!allowed) {
    return res.status(403).json({
      success: false,
      code: 'FORBIDDEN',
      message: 'You do not have permission to edit settings.',
    });
  }
  return next();
};

router.get('/', ctrl.getSettings);

// Same validation as /api/tenant/settings/* (routes/tenant.settings.rules.js)
router.patch('/business', requireSettingsEdit, businessRules, validate, ctrl.updateBusiness);
router.put('/business',   requireSettingsEdit, businessRules, validate, ctrl.updateBusiness);

router.post('/razorpay',   requireSettingsEdit, razorpayRules, validate, ctrl.saveRazorpay);
router.put('/razorpay',    requireSettingsEdit, razorpayRules, validate, ctrl.saveRazorpay);
router.delete('/razorpay', requireSettingsEdit, ctrl.removeRazorpay);

router.post('/crm',        requireSettingsEdit, crmRules, validate, ctrl.saveCRM);
router.put('/crm',         requireSettingsEdit, crmRules, validate, ctrl.saveCRM);
router.post('/crm/test',   ctrl.testCRM);          // read-only — no gate needed
router.delete('/crm',      requireSettingsEdit, ctrl.removeCRM);

// Password change always operates on the caller's own account — never gated
router.patch('/password',  changePasswordRules, validate, ctrl.changePassword);
router.put('/password',    changePasswordRules, validate, ctrl.changePassword);
router.post('/repair',     requireSettingsEdit, ctrl.repairSetup);

module.exports = router;