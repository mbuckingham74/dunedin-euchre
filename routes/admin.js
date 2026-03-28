'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { sendMagicLink, sendRsvpInvite, formatEventDate, formatTime } = require('../services/email');
const {
  getArrivalNotes,
  getEventTitle,
  isEventPublished,
  isPublicRosterVisible,
  parsePublicSlugInput
} = require('../services/events');
const { buildPublicEventPath, buildRsvpPath } = require('../services/links');
const {
  isPublicSlugConflictError,
  listEventPublicSlugs,
  reserveEventPublicSlug
} = require('../services/public-slugs');
const { getUploadsDir } = require('../services/uploads');

const router = express.Router();

const BASE_URL = process.env.BASE_URL || 'https://dunedin-euchre.com';
const ADMIN_EMAILS = (process.env.ADMIN_EMAIL || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const uploadsDir = getUploadsDir();

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ── File upload (event images) ───────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${file.fieldname}-${Date.now()}-${uuidv4()}${ext}`);
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

const eventUpload = upload.fields([
  { name: 'location_image', maxCount: 1 },
  { name: 'map_image', maxCount: 1 }
]);

// ── Rate limit magic link requests ───────────────────────────
const magicLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many requests. Please wait 15 minutes and try again.'
});

// ── Helpers ──────────────────────────────────────────────────
function getMostRecentEvent() {
  return db.prepare('SELECT * FROM events ORDER BY event_date DESC, id DESC LIMIT 1').get();
}

function getEventById(eventId) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
}

function listEvents() {
  return db.prepare('SELECT * FROM events ORDER BY event_date DESC, id DESC').all();
}

function getDashboardEvent(requestedEventId) {
  if (requestedEventId) return getEventById(requestedEventId);
  return getMostRecentEvent();
}

function parseEventId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function normalizeText(value) {
  const trimmed = (value || '').trim();
  return trimmed ? trimmed : null;
}

function normalizeEventInput(body) {
  const publicSlug = parsePublicSlugInput(body.public_slug);

  return {
    title: normalizeText(body.title),
    public_slug: publicSlug.value,
    public_slug_error: publicSlug.error,
    event_date: (body.event_date || '').trim(),
    location_name: normalizeText(body.location_name),
    location_address: normalizeText(body.location_address),
    start_time: (body.start_time || '').trim(),
    end_time: (body.end_time || '').trim(),
    arrival_notes: normalizeText(body.arrival_notes),
    is_published: body.is_published ? 1 : 0,
    show_public_roster: body.show_public_roster ? 1 : 0
  };
}

function getEventValidationError(eventInput) {
  if (!(
    eventInput.title &&
    eventInput.event_date &&
    eventInput.location_name &&
    eventInput.start_time &&
    eventInput.end_time
  )) {
    return 'Title, date, location name, and start/end time are required.';
  }

  return eventInput.public_slug_error || null;
}

function isPublicSlugUniqueConstraint(error) {
  return Boolean(error && (
    error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  ));
}

function getUploadedFilename(files, fieldName) {
  return files && files[fieldName] && files[fieldName][0]
    ? files[fieldName][0].filename
    : null;
}

function getUploadedFilenames(files) {
  return [
    getUploadedFilename(files, 'location_image'),
    getUploadedFilename(files, 'map_image')
  ].filter(Boolean);
}

function removeUploadedFile(filename) {
  if (!filename) return;

  const filepath = path.join(uploadsDir, filename);
  try {
    fs.unlinkSync(filepath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Unable to remove upload ${filename}:`, error.message);
    }
  }
}

function cleanupUploadedFiles(files) {
  for (const filename of getUploadedFilenames(files)) {
    removeUploadedFile(filename);
  }
}

function resolveUpdatedImage(existingFilename, uploadedFilename, removeRequested) {
  const nextFilename = uploadedFilename || (removeRequested ? null : existingFilename);
  const replacedFilename = existingFilename && existingFilename !== nextFilename
    ? existingFilename
    : null;

  return { nextFilename, replacedFilename };
}

function getParticipantByEmail(email) {
  return db.prepare('SELECT * FROM participants WHERE email = ? COLLATE NOCASE').get(email);
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

function buildDashboardRedirect(eventId) {
  return eventId ? `/admin/dashboard?eventId=${eventId}` : '/admin/dashboard';
}

function buildParticipantsRedirect(eventId) {
  return eventId ? `/admin/participants?eventId=${eventId}` : '/admin/participants';
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
  const email = normalizeEmail(req.body.email);

  // Always show "sent" regardless of whether email matches (no enumeration)
  if (!ADMIN_EMAILS.includes(email)) {
    return res.render('admin/login', { error: null, sent: true });
  }

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

  res.redirect('/admin/dashboard');
});

// ── GET /admin/dashboard ─────────────────────────────────────
router.get('/dashboard', requireAdmin, (req, res) => {
  const requestedEventId = parseEventId(req.query.eventId);
  const event = getDashboardEvent(requestedEventId);

  if (requestedEventId && !event) {
    return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>');
  }

  let roster = [];
  let counts = { yes: 0, no: 0, maybe: 0, none: 0 };
  let publicSlugHistory = [];
  let previousPublicSlugs = [];

  if (event) {
    ({ roster, counts } = getRosterWithCounts(event.id));
    publicSlugHistory = listEventPublicSlugs(event.id);
    previousPublicSlugs = publicSlugHistory.filter(entry => !Number(entry.is_current));
  }

  res.render('admin/dashboard', {
    event,
    roster,
    counts,
    publicSlugHistory,
    previousPublicSlugs,
    allEvents: listEvents(),
    selectedEventId: event ? event.id : null,
    formatEventDate,
    formatTime,
    getEventTitle,
    getArrivalNotes,
    isEventPublished,
    isPublicRosterVisible,
    buildPublicEventPath,
    baseUrl: BASE_URL,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ── POST /admin/event ─────────────────────────────────────────
router.post('/event', requireAdmin, eventUpload, (req, res) => {
  const eventInput = normalizeEventInput(req.body);
  const locationImage = getUploadedFilename(req.files, 'location_image');
  const mapImage = getUploadedFilename(req.files, 'map_image');

  const validationError = getEventValidationError(eventInput);
  if (validationError) {
    cleanupUploadedFiles(req.files);
    req.session.flash = validationError;
    return res.redirect('/admin/dashboard');
  }

  try {
    const result = db.transaction(() => {
      const created = db.prepare(`
        INSERT INTO events (
          title,
          public_slug,
          event_date,
          location_name,
          location_address,
          location_image,
          map_image,
          start_time,
          end_time,
          arrival_notes,
          notes,
          is_published,
          show_public_roster
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventInput.title,
        eventInput.public_slug,
        eventInput.event_date,
        eventInput.location_name,
        eventInput.location_address,
        locationImage,
        mapImage,
        eventInput.start_time,
        eventInput.end_time,
        eventInput.arrival_notes,
        eventInput.arrival_notes,
        eventInput.is_published,
        eventInput.show_public_roster
      );

      reserveEventPublicSlug(created.lastInsertRowid, eventInput.public_slug);
      return created;
    })();

    req.session.flash = 'Event created successfully.';
    return res.redirect(buildDashboardRedirect(result.lastInsertRowid));
  } catch (error) {
    cleanupUploadedFiles(req.files);
    if (isPublicSlugConflictError(error) || isPublicSlugUniqueConstraint(error)) {
      req.session.flash = 'That public URL slug is already in use, including any older redirected event links.';
      return res.redirect('/admin/dashboard');
    }
    throw error;
  }
});

// ── POST /admin/event/:id/update ─────────────────────────────
router.post('/event/:id/update', requireAdmin, eventUpload, (req, res) => {
  const existing = getEventById(req.params.id);
  if (!existing) {
    cleanupUploadedFiles(req.files);
    return res.status(404).json({ error: 'Event not found.' });
  }

  const eventInput = normalizeEventInput(req.body);
  const validationError = getEventValidationError(eventInput);
  if (validationError) {
    cleanupUploadedFiles(req.files);
    req.session.flash = validationError;
    return res.redirect(buildDashboardRedirect(existing.id));
  }

  const uploadedLocationImage = getUploadedFilename(req.files, 'location_image');
  const uploadedMapImage = getUploadedFilename(req.files, 'map_image');
  const locationImageUpdate = resolveUpdatedImage(
    existing.location_image,
    uploadedLocationImage,
    Boolean(req.body.remove_location_image)
  );
  const mapImageUpdate = resolveUpdatedImage(
    existing.map_image,
    uploadedMapImage,
    Boolean(req.body.remove_map_image)
  );

  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE events
        SET title = ?,
            public_slug = ?,
            event_date = ?,
            location_name = ?,
            location_address = ?,
            location_image = ?,
            map_image = ?,
            start_time = ?,
            end_time = ?,
            arrival_notes = ?,
            notes = ?,
            is_published = ?,
            show_public_roster = ?
        WHERE id = ?
      `).run(
        eventInput.title,
        eventInput.public_slug,
        eventInput.event_date,
        eventInput.location_name,
        eventInput.location_address,
        locationImageUpdate.nextFilename,
        mapImageUpdate.nextFilename,
        eventInput.start_time,
        eventInput.end_time,
        eventInput.arrival_notes,
        eventInput.arrival_notes,
        eventInput.is_published,
        eventInput.show_public_roster,
        existing.id
      );

      reserveEventPublicSlug(existing.id, eventInput.public_slug);
    })();
  } catch (error) {
    cleanupUploadedFiles(req.files);
    if (isPublicSlugConflictError(error) || isPublicSlugUniqueConstraint(error)) {
      req.session.flash = 'That public URL slug is already in use, including any older redirected event links.';
      return res.redirect(buildDashboardRedirect(existing.id));
    }
    throw error;
  }

  if (locationImageUpdate.replacedFilename) {
    removeUploadedFile(locationImageUpdate.replacedFilename);
  }
  if (mapImageUpdate.replacedFilename) {
    removeUploadedFile(mapImageUpdate.replacedFilename);
  }

  req.session.flash = 'Event updated.';
  res.redirect(buildDashboardRedirect(existing.id));
});

// ── GET /admin/participants ───────────────────────────────────
router.get('/participants', requireAdmin, (req, res) => {
  const participants = db.prepare(
    'SELECT * FROM participants ORDER BY active DESC, name ASC'
  ).all();

  const requestedEventId = parseEventId(req.query.eventId);
  const selectedEvent = getDashboardEvent(requestedEventId);

  if (requestedEventId && !selectedEvent) {
    return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>');
  }

  res.render('admin/participants', {
    participants,
    selectedEvent,
    allEvents: listEvents(),
    buildRsvpPath,
    buildPublicEventPath,
    getEventTitle,
    isEventPublished,
    baseUrl: BASE_URL,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ── POST /admin/participants ──────────────────────────────────
router.post('/participants', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  const email = normalizeEmail(req.body.email);
  const selectedEventId = parseEventId(req.body.selected_event_id);

  if (!name || !email) {
    req.session.flash = 'Name and email are required.';
    return res.redirect(buildParticipantsRedirect(selectedEventId));
  }

  const existing = getParticipantByEmail(email);
  if (existing) {
    if (existing.active) {
      req.session.flash = `${existing.name} already exists with that email.`;
      return res.redirect(buildParticipantsRedirect(selectedEventId));
    }

    db.prepare(`
      UPDATE participants
      SET name = ?, active = 1
      WHERE id = ?
    `).run(name, existing.id);

    req.session.flash = `${name} reactivated.`;
    return res.redirect(buildParticipantsRedirect(selectedEventId));
  }

  const token = uuidv4();
  db.prepare('INSERT INTO participants (name, email, rsvp_token) VALUES (?, ?, ?)')
    .run(name, email, token);

  req.session.flash = `${name} added.`;
  res.redirect(buildParticipantsRedirect(selectedEventId));
});

// ── POST /admin/participants/:id/update ───────────────────────
router.post('/participants/:id/update', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  const email = normalizeEmail(req.body.email);
  const selectedEventId = parseEventId(req.body.selected_event_id);

  if (!name || !email) {
    req.session.flash = 'Name and email are required.';
    return res.redirect(buildParticipantsRedirect(selectedEventId));
  }

  const existing = db.prepare('SELECT * FROM participants WHERE id = ?').get(req.params.id);
  if (!existing) {
    req.session.flash = 'Participant not found.';
    return res.redirect(buildParticipantsRedirect(selectedEventId));
  }

  const conflict = db.prepare(`
    SELECT * FROM participants
    WHERE email = ? COLLATE NOCASE AND id != ?
  `).get(email, req.params.id);
  if (conflict) {
    req.session.flash = `${conflict.name} already uses that email.`;
    return res.redirect(buildParticipantsRedirect(selectedEventId));
  }

  db.prepare('UPDATE participants SET name = ?, email = ? WHERE id = ?')
    .run(name, email, req.params.id);

  req.session.flash = 'Participant updated.';
  res.redirect(buildParticipantsRedirect(selectedEventId));
});

// ── POST /admin/participants/:id/delete ───────────────────────
router.post('/participants/:id/delete', requireAdmin, (req, res) => {
  const selectedEventId = parseEventId(req.body.selected_event_id);
  db.prepare('UPDATE participants SET active = 0 WHERE id = ?').run(req.params.id);
  req.session.flash = 'Participant removed.';
  res.redirect(buildParticipantsRedirect(selectedEventId));
});

// ── POST /admin/event/:id/notify ─────────────────────────────
router.post('/event/:id/notify', requireAdmin, async (req, res) => {
  const event = getEventById(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const participants = db.prepare(
    'SELECT * FROM participants WHERE active = 1'
  ).all();

  let sent = 0;
  let failed = 0;
  for (const participant of participants) {
    try {
      await sendRsvpInvite(participant, event);
      sent++;
    } catch (err) {
      console.error(`Failed to email ${participant.email}:`, err.message);
      failed++;
    }
  }

  req.session.flash = `Invites sent: ${sent} delivered${failed ? `, ${failed} failed` : ''}.`;
  res.redirect(buildDashboardRedirect(event.id));
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
    avgChanges: row.avg_changes === null ? null : Number(row.avg_changes.toFixed(1))
  }));

  res.render('admin/stats', { stats, totalEvents, events, formatEventDate });
});

// ── GET /admin/logout ─────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

module.exports = router;
