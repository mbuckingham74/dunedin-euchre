'use strict';

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminAuthenticated) {
    return next();
  }
  res.redirect('/admin');
}

module.exports = { requireAdmin };
