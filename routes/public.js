'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { formatEventDate, formatTime } = require('../services/email');
const { buildRsvpPath } = require('../services/links');

const MAX_CHANGES = 5;

// ── Root redirect ─────────────────────────────────────────────
router.get('/', (req, res) => res.redirect('/admin'));

// ── Helpers ──────────────────────────────────────────────────

function getParticipantByToken(token) {
  return db.prepare(
    'SELECT * FROM participants WHERE rsvp_token = ? AND active = 1'
  ).get(token);
}

function getEventById(eventId) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
}

function getLegacyRsvpEventOptions() {
  return db.prepare(`
    SELECT id FROM events
    ORDER BY event_date DESC, id DESC
    LIMIT 2
  `).all();
}

function getRoster(eventId) {
  return db.prepare(`
    SELECT p.id, p.name, r.status, r.comment, r.change_count
    FROM participants p
    LEFT JOIN responses r ON r.participant_id = p.id AND r.event_id = ?
    WHERE p.active = 1
    ORDER BY p.name ASC
  `).all(eventId);
}

function renderRsvpPage(res, participant, event) {
  const roster = getRoster(event.id);
  const myResponse = roster.find(r => r.id === participant.id);

  res.render('rsvp', {
    participant,
    event,
    roster,
    myResponse: myResponse || null,
    maxChanges: MAX_CHANGES,
    formatEventDate,
    formatTime,
    baseUrl: process.env.BASE_URL || '',
    rsvpPath: buildRsvpPath(participant, event)
  });
}

function saveRsvpResponse(res, participant, event, body) {
  const { status, comment } = body;
  if (!['yes', 'no', 'maybe'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  const trimmedComment = (comment || '').trim().slice(0, 400);

  const existing = db.prepare(
    'SELECT * FROM responses WHERE participant_id = ? AND event_id = ?'
  ).get(participant.id, event.id);

  if (existing) {
    if (existing.change_count >= MAX_CHANGES) {
      return res.status(429).json({
        error: `You've reached the maximum of ${MAX_CHANGES} responses for this event.`
      });
    }
    db.prepare(`
      UPDATE responses
      SET status = ?, comment = ?, change_count = change_count + 1, updated_at = datetime('now')
      WHERE participant_id = ? AND event_id = ?
    `).run(status, trimmedComment, participant.id, event.id);
  } else {
    db.prepare(`
      INSERT INTO responses (participant_id, event_id, status, comment, change_count)
      VALUES (?, ?, ?, ?, 1)
    `).run(participant.id, event.id, status, trimmedComment);
  }

  const roster = getRoster(event.id);
  const updated = db.prepare(
    'SELECT * FROM responses WHERE participant_id = ? AND event_id = ?'
  ).get(participant.id, event.id);

  return res.json({ ok: true, roster, changesUsed: updated.change_count, maxChanges: MAX_CHANGES });
}

// ── GET /rsvp/:token ─────────────────────────────────────────
router.get('/rsvp/:token', (req, res) => {
  const participant = getParticipantByToken(req.params.token);

  if (!participant) {
    return res.status(404).send(
      '<h1 style="font-family:sans-serif;padding:2rem">Link not found or no longer active.</h1>'
    );
  }

  const events = getLegacyRsvpEventOptions();
  if (events.length === 0) {
    return res.render('no-event', { participant });
  }

  if (events.length === 1) {
    return res.redirect(buildRsvpPath(participant, events[0].id));
  }

  res.status(410).render('legacy-rsvp', { participant });
});

// ── GET /rsvp/:token/:eventId ────────────────────────────────
router.get('/rsvp/:token/:eventId', (req, res) => {
  const participant = getParticipantByToken(req.params.token);

  if (!participant) {
    return res.status(404).send(
      '<h1 style="font-family:sans-serif;padding:2rem">Link not found or no longer active.</h1>'
    );
  }

  const event = getEventById(req.params.eventId);
  if (!event) {
    return res.status(404).send(
      '<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>'
    );
  }

  return renderRsvpPage(res, participant, event);
});

// ── POST /rsvp/:token ────────────────────────────────────────
router.post('/rsvp/:token', express.json(), (req, res) => {
  const participant = getParticipantByToken(req.params.token);

  if (!participant) return res.status(404).json({ error: 'Link not found.' });

  const events = getLegacyRsvpEventOptions();
  if (events.length === 0) return res.status(400).json({ error: 'No active event.' });
  if (events.length > 1) {
    return res.status(410).json({
      error: 'This RSVP link is outdated. Please use the latest invite email.'
    });
  }

  const event = getEventById(events[0].id);
  return saveRsvpResponse(res, participant, event, req.body);
});

// ── POST /rsvp/:token/:eventId ───────────────────────────────
router.post('/rsvp/:token/:eventId', express.json(), (req, res) => {
  const participant = getParticipantByToken(req.params.token);

  if (!participant) return res.status(404).json({ error: 'Link not found.' });

  const event = getEventById(req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  return saveRsvpResponse(res, participant, event, req.body);
});

// ── GET /event/:id ───────────────────────────────────────────
router.get('/event/:id', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>');

  const roster = getRoster(event.id);

  const counts = { yes: 0, no: 0, maybe: 0, none: 0 };
  for (const r of roster) {
    if (r.status) counts[r.status]++;
    else counts.none++;
  }

  res.render('event', { event, roster, counts, formatEventDate, formatTime });
});

module.exports = router;
