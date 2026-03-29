'use strict';

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const db = require('./db/database');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const { getUploadsDir } = require('./services/uploads');

// Ensure uploads directory exists
const uploadsDir = getUploadsDir();
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();

// Trust one proxy hop (Nginx Proxy Manager) so express-rate-limit
// and session cookies work correctly with X-Forwarded-For / X-Forwarded-Proto
app.set('trust proxy', 1);

// ── View engine ──────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Body parsing ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Static files ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use('/images', express.static(path.join(__dirname, 'images')));

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

app.use(session({
  store: new SQLiteStore(db),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
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

// ── Routes ───────────────────────────────────────────────────
app.use('/', publicRoutes);
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Dunedin Euchre running on port ${PORT}`);
  });
}

module.exports = { app };
