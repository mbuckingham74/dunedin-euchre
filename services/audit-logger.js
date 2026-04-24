'use strict';

const fs = require('fs');
const path = require('path');

const AUDIT_LOG_DIR = path.join(__dirname, '..', 'logs');
const AUDIT_LOG_PATH = path.join(AUDIT_LOG_DIR, 'audit.log');

function ensureLogDir() {
  if (!fs.existsSync(AUDIT_LOG_DIR)) {
    fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
  }
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : req.ip || req.socket.remoteAddress || 'unknown';
}

function writeAuditLog(action, details, req) {
  try {
    ensureLogDir();
    const timestamp = new Date().toISOString();
    const ip = getClientIp(req);
    const entry = {
      timestamp,
      action,
      ip,
      admin: req.session && req.session.adminAuthenticated ? true : false,
      details
    };
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', { encoding: 'utf-8' });
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

module.exports = { writeAuditLog };
