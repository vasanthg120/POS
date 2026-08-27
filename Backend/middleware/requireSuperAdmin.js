'use strict';

const requireSuperAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      code   : 'NOT_AUTHENTICATED',
      message: 'Authentication required.',
    });
  }

  if (req.user.role !== 'superadmin') {
    return res.status(403).json({
      success: false,
      code   : 'FORBIDDEN',
      message: 'Superadmin access required.',
    });
  }

  next();
};

module.exports = requireSuperAdmin;
