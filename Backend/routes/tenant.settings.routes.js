'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/tenantController'); // ← was tenant.controller
const { protect } = require('../middleware/auth');

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

router.patch('/business', requireSettingsEdit, ctrl.updateBusiness);
router.put('/business',   requireSettingsEdit, ctrl.updateBusiness);

router.post('/razorpay',   requireSettingsEdit, ctrl.saveRazorpay);
router.put('/razorpay',    requireSettingsEdit, ctrl.saveRazorpay);
router.delete('/razorpay', requireSettingsEdit, ctrl.removeRazorpay);

router.post('/crm',        requireSettingsEdit, ctrl.saveCRM);
router.put('/crm',         requireSettingsEdit, ctrl.saveCRM);
router.post('/crm/test',   ctrl.testCRM);          // read-only — no gate needed
router.delete('/crm',      requireSettingsEdit, ctrl.removeCRM);

// Password change always operates on the caller's own account — never gated
router.patch('/password',  ctrl.changePassword);
router.put('/password',    ctrl.changePassword);
router.post('/repair',     requireSettingsEdit, ctrl.repairSetup);

module.exports = router;