'use strict';

const MAX_EVENT_PAGE_ACCESS = 20;

function isAdminAuthenticated(req) {
  return Boolean(req.session && req.session.adminAuthenticated);
}

function requireAdmin(req, res, next) {
  if (isAdminAuthenticated(req)) {
    return next();
  }
  res.redirect('/admin');
}

function grantEventPageAccess(req, eventId) {
  if (!req.session) return;

  const normalizedEventId = Number(eventId);
  if (!Number.isInteger(normalizedEventId) || normalizedEventId <= 0) return;

  const existingAccess = Array.isArray(req.session.eventPageAccess)
    ? req.session.eventPageAccess
    : [];
  const nextAccess = [
    normalizedEventId,
    ...existingAccess.filter(value => value !== normalizedEventId)
  ].slice(0, MAX_EVENT_PAGE_ACCESS);

  req.session.eventPageAccess = nextAccess;
}

function hasEventPageAccess(req, eventId) {
  if (isAdminAuthenticated(req)) return true;
  if (!req.session) return false;

  const normalizedEventId = Number(eventId);
  if (!Number.isInteger(normalizedEventId) || normalizedEventId <= 0) return false;

  const eventPageAccess = Array.isArray(req.session.eventPageAccess)
    ? req.session.eventPageAccess
    : [];

  return eventPageAccess.includes(normalizedEventId);
}

module.exports = {
  grantEventPageAccess,
  hasEventPageAccess,
  isAdminAuthenticated,
  requireAdmin
};
