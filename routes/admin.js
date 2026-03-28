'use strict';

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const rateLimit = require('express-rate-limit');

const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { sendMagicLink, sendRsvpInvite, formatEventDate, formatTime } = require('../services/email');

const BASE_URL = process.env.BASE_URL || 'https://dunedin-euchre.com';
const ADMIN_EMAILS = (process.env.ADMIN_EMAIL || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// ── File upload (location images) ────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `location-${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  }
});

// ── Rate limit magic link requests ───────────────────────────
const magicLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many requests. Please wait 15 minutes and try again.'
});

// ── Helpers ──────────────────────────────────────────────────
function getCurrentEvent() {
  return db.prepare('SELECT * FROM events ORDER BY event_date DESC, id DESC LIMIT 1').get();
}

function getRosterWithCounts(eventId) {
  const roster = db.prepare(`
    SELECT p.id, p.name, p.email, p.rsvp_token,
           r.status, r.comment, r.change_count, r.responded_at, r.updated_at
    FROM participants p
    LEFT JOIN responses r ON r.participant_id = p.id AND r.event_id = ?
    WHERE p.active = 1
    ORDER BY p.name ASC
  `).all(eventId);

  const counts = { yes: 0, no: 0, maybe: 0, none: 0 };
  for (const row of roster) {
    if (row.status) counts[row.status]++;
    else counts.none++;
  }
  return { roster, counts };
}

// ── GET /admin ───────────────────────────────────────────────
router.get('/', (req, res) => {
  if (req.session && req.session.adminAuthenticated) {
    return res.redirect('/admin/dashboard');
  }
  res.render('admin/login', { error: null, sent: false });
});

// ── POST /admin/request-link ─────────────────────────────────
router.post('/request-link', magicLinkLimiter, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();

  // Always show "sent" regardless of whether email matches (no enumeration)
  if (!ADMIN_EMAILS.includes(email)) {
    return res.render('admin/login', { error: null, sent: true });
  }

  // Expire any existing unused tokens
  db.prepare(`
    UPDATE admin_tokens SET used = 1 WHERE used = 0 AND expires_at > datetime('now')
  `).run();

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO admin_tokens (token, expires_at, used) VALUES (?, ?, 0)')
    .run(token, expiresAt);

  try {
    await sendMagicLink(email, token);
  } catch (err) {
    console.error('Failed to send magic link:', err);
  }

  res.render('admin/login', { error: null, sent: true });
});

// ── GET /admin/auth/:token ───────────────────────────────────
router.get('/auth/:token', (req, res) => {
  const row = db.prepare(`
    SELECT * FROM admin_tokens
    WHERE token = ? AND used = 0 AND expires_at > datetime('now')
  `).get(req.params.token);

  if (!row) {
    return res.render('admin/login', {
      error: 'This sign-in link has expired or already been used. Please request a new one.',
      sent: false
    });
  }

  db.prepare('UPDATE admin_tokens SET used = 1 WHERE token = ?').run(row.token);

  req.session.adminAuthenticated = true;
  req.session.adminEmail = ADMIN_EMAIL;

  res.redirect('/admin/dashboard');
});

// ── GET /admin/dashboard ─────────────────────────────────────
router.get('/dashboard', requireAdmin, (req, res) => {
  const event = getCurrentEvent();
  let roster = [], counts = { yes: 0, no: 0, maybe: 0, none: 0 };

  if (event) {
    ({ roster, counts } = getRosterWithCounts(event.id));
  }

  const allEvents = db.prepare('SELECT * FROM events ORDER BY event_date DESC').all();

  res.render('admin/dashboard', {
    event,
    roster,
    counts,
    allEvents,
    formatEventDate,
    formatTime,
    baseUrl: BASE_URL,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ── POST /admin/event ─────────────────────────────────────────
router.post('/event', requireAdmin, upload.single('location_image'), (req, res) => {
  const { event_date, location_name, start_time, end_time, notes } = req.body;
  const location_image = req.file ? req.file.filename : null;

  db.prepare(`
    INSERT INTO events (event_date, location_name, location_image, start_time, end_time, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(event_date, location_name, location_image, start_time, end_time, notes || null);

  req.session.flash = 'Event created successfully.';
  res.redirect('/admin/dashboard');
});

// ── PUT /admin/event/:id ──────────────────────────────────────
router.post('/event/:id/update', requireAdmin, upload.single('location_image'), (req, res) => {
  const { event_date, location_name, start_time, end_time, notes } = req.body;
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Event not found.' });

  const location_image = req.file ? req.file.filename : existing.location_image;

  db.prepare(`
    UPDATE events
    SET event_date = ?, location_name = ?, location_image = ?, start_time = ?, end_time = ?, notes = ?
    WHERE id = ?
  `).run(event_date, location_name, location_image, start_time, end_time, notes || null, req.params.id);

  req.session.flash = 'Event updated.';
  res.redirect('/admin/dashboard');
});

// ── GET /admin/participants ───────────────────────────────────
router.get('/participants', requireAdmin, (req, res) => {
  const participants = db.prepare(
    'SELECT * FROM participants ORDER BY active DESC, name ASC'
  ).all();

  res.render('admin/participants', {
    participants,
    baseUrl: BASE_URL,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ── POST /admin/participants ──────────────────────────────────
router.post('/participants', requireAdmin, (req, res) => {
  const { name, email } = req.body;
  const token = uuidv4();
  db.prepare('INSERT INTO participants (name, email, rsvp_token) VALUES (?, ?, ?)')
    .run(name.trim(), email.trim().toLowerCase(), token);

  req.session.flash = `${name.trim()} added.`;
  res.redirect('/admin/participants');
});

// ── POST /admin/participants/:id/update ───────────────────────
router.post('/participants/:id/update', requireAdmin, (req, res) => {
  const { name, email } = req.body;
  db.prepare('UPDATE participants SET name = ?, email = ? WHERE id = ?')
    .run(name.trim(), email.trim().toLowerCase(), req.params.id);

  req.session.flash = 'Participant updated.';
  res.redirect('/admin/participants');
});

// ── POST /admin/participants/:id/delete ───────────────────────
router.post('/participants/:id/delete', requireAdmin, (req, res) => {
  db.prepare('UPDATE participants SET active = 0 WHERE id = ?').run(req.params.id);
  req.session.flash = 'Participant removed.';
  res.redirect('/admin/participants');
});

// ── POST /admin/event/:id/notify ─────────────────────────────
router.post('/event/:id/notify', requireAdmin, async (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const participants = db.prepare(
    'SELECT * FROM participants WHERE active = 1'
  ).all();

  let sent = 0, failed = 0;
  for (const p of participants) {
    try {
      await sendRsvpInvite(p, event);
      sent++;
    } catch (err) {
      console.error(`Failed to email ${p.email}:`, err.message);
      failed++;
    }
  }

  req.session.flash = `Invites sent: ${sent} delivered${failed ? `, ${failed} failed` : ''}.`;
  res.redirect('/admin/dashboard');
});

// ── GET /admin/stats ──────────────────────────────────────────
router.get('/stats', requireAdmin, (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY event_date ASC').all();

  // Attendance rate per participant (yes responses / total events with a response)
  const attendance = db.prepare(`
    SELECT
      p.id,
      p.name,
      COUNT(r.id) AS total_responses,
      SUM(CASE WHEN r.status = 'yes' THEN 1 ELSE 0 END) AS yes_count,
      AVG(r.change_count) AS avg_changes
    FROM participants p
    LEFT JOIN responses r ON r.participant_id = p.id
    WHERE p.active = 1
    GROUP BY p.id, p.name
    ORDER BY p.name ASC
  `).all();

  const totalEvents = events.length;

  const stats = attendance.map(row => ({
    id: row.id,
    name: row.name,
    totalResponses: row.total_responses || 0,
    yesCount: row.yes_count || 0,
    attendanceRate: totalEvents > 0
      ? Math.round((row.yes_count || 0) / totalEvents * 100)
      : null,
    avgChanges: row.avg_changes ? row.avg_changes.toFixed(1) : '1.0'
  }));

  res.render('admin/stats', { stats, totalEvents, events, formatEventDate });
});

// ── GET /admin/logout ─────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

module.exports = router;
