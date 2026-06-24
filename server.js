'use strict';

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db/database');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const { startReminderWorker } = require('./services/reminders');
const { getUploadsDir } = require('./services/uploads');

// ── Upload magic-byte verification ─────────────────────────────
function verifyMagicBytes(buffer, ext) {
  if (!buffer || buffer.length < 4) return false;

  const sigs = {
    '.png': [0x89, 0x50, 0x4E, 0x47],
    '.jpg': [0xFF, 0xD8, 0xFF],
    '.jpeg': [0xFF, 0xD8, 0xFF],
    '.gif': [0x47, 0x49, 0x46, 0x38],
    '.webp': buffer.length >= 12
      && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
      && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50,
    '.bmp': [0x42, 0x4D],
    '.tiff': buffer.length >= 4
      && ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2A && buffer[3] === 0x00)
        || (buffer[0] === 0x4D && buffer[1] === 0x4D && buffer[2] === 0x00 && buffer[3] === 0x2A)),
    '.ico': [0x00, 0x00, 0x01, 0x00],
  };

  const expected = sigs[ext];
  if (expected === undefined) return true;          // unknown / text-based (SVG)
  if (typeof expected === 'boolean') return expected;
  for (let i = 0; i < expected.length; i++) {
    if (buffer[i] !== expected[i]) return false;
  }
  return true;
}

// ── Production secret enforcement ────────────────────────────
if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET must be set in production.');
  }
}

const sessionSecret = process.env.SESSION_SECRET;
const assetVersion = process.env.ASSET_VERSION || Date.now().toString(36);

// Ensure uploads directory exists
const uploadsDir = getUploadsDir();
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}



const app = express();

// ── Privacy / fingerprinting ─────────────────────────────────
app.disable('x-powered-by');

// Trust one proxy hop (Nginx Proxy Manager) so express-rate-limit
// and session cookies work correctly with X-Forwarded-For / X-Forwarded-Proto
app.set('trust proxy', 1);

// ── Security headers ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://www.google.com"],
      frameSrc: ["'self'", "https://www.google.com"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      blockAllMixedContent: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  frameguard: { action: 'deny' },
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 63072000, includeSubDomains: true, preload: true }
    : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// ── View engine ──────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.assetPath = function buildAssetPath(assetPath) {
  const separator = assetPath.includes('?') ? '&' : '?';
  return `${assetPath}${separator}v=${assetVersion}`;
};

// ── Body parsing ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Static files (versioned but mutable asset URLs) ───────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    const basename = path.basename(filePath);
    if (basename === 'sw.js' || basename === 'manifest.json') {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

// ── Secure uploaded file serving ─────────────────────────────
app.use('/uploads', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return next();
  }

  const requestedName = path.basename(req.path);
  if (!requestedName || requestedName.startsWith('.') || requestedName.includes('..')) {
    return res.status(400).send('Invalid filename');
  }

  const filePath = path.resolve(uploadsDir, requestedName);
  const resolvedUploadsDir = path.resolve(uploadsDir);
  if (!filePath.startsWith(resolvedUploadsDir + path.sep)) {
    return res.status(403).send('Forbidden');
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Not found');
  }

  const ext = path.extname(requestedName).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.ico': 'image/x-icon',
  };

  // Verify magic bytes for non-text image types
  if (ext !== '.svg') {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const header = Buffer.alloc(12);
      fs.readSync(fd, header, 0, 12, 0);
      if (!verifyMagicBytes(header, ext)) {
        return res.status(400).send('Invalid file content');
      }
    } catch {
      return res.status(500).send('Error reading file');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=86400');

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.status(500).send('Error reading file'));
  stream.pipe(res);
});

app.use('/images', express.static(path.join(__dirname, 'images'), {
  maxAge: '1y',
  immutable: true,
}));

app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ ok: false });
  }
});

// ── Session store (SQLite-backed, survives restarts) ─────────
class SQLiteStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid     TEXT PRIMARY KEY,
        sess    TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `);
    this.cleanupTimer = setInterval(() => {
      this.db.prepare('DELETE FROM sessions WHERE expired < ?').run(Date.now());
    }, 60 * 1000);
    this.cleanupTimer.unref();
  }

  get(sid, cb) {
    const row = this.db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid);
    if (!row) return cb(null, null);
    if (row.expired < Date.now()) {
      this.destroy(sid, () => {});
      return cb(null, null);
    }
    try { cb(null, JSON.parse(row.sess)); } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 30 * 24 * 60 * 60 * 1000;
    this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)')
      .run(sid, JSON.stringify(sess), expires);
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    if (cb) cb(null);
  }

  touch(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 30 * 24 * 60 * 60 * 1000;
    this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(expires, sid);
    if (cb) cb(null);
  }
}

// ── Session store (SQLite-backed, survives restarts) ─────────
app.use(session({
  store: new SQLiteStore(db),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  name: 'euchre.sid',
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// ── CSRF middleware (custom, session-backed) ─────────────────
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function csrfMiddleware(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCsrfToken();
  }
  res.locals._csrf = req.session.csrfToken;
  next();
}

function validateCsrfToken(req, res, next) {
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  const submitted = req.body && req.body._csrf || req.headers['x-csrf-token'];
  if (!submitted || submitted !== req.session.csrfToken) {
    if (req.xhr) {
      return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
    }
    return res.status(403).send(
      '<h1 style="font-family:sans-serif;padding:2rem">Invalid or missing CSRF token. Refresh the page and try again.</h1>'
    );
  }
  next();
}

// ── Routes ───────────────────────────────────────────────────
app.use('/', publicRoutes);
app.use('/admin', (req, res, next) => {
  res.set('Cache-Control', 'no-store, private, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use('/admin', csrfMiddleware);
app.use('/admin', validateCsrfToken);
app.use('/admin', adminRoutes);

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Page not found</h1>');
});

// ── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('<h1 style="font-family:sans-serif;padding:2rem">Something went wrong. Please try again.</h1>');
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3456;

startReminderWorker();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Dunedin Euchre running on port ${PORT}`);
  });
}

module.exports = { app };
