'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { formatEventDate, formatTime } = require('../services/email');
const {
  getArrivalNotes,
  getEventTitle,
  isEventPublished,
  isPublicRosterVisible
} = require('../services/events');
const { buildPublicEventPath, buildRsvpPath } = require('../services/links');
const { applyManagedLocation } = require('../services/locations');
const { getEventByPublicSlug } = require('../services/public-slugs');

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
  return applyManagedLocation(db.prepare(`
    SELECT
      e.*,
      l.name AS managed_location_name,
      l.address AS managed_location_address,
      l.location_image AS managed_location_image,
      l.map_embed_url AS managed_map_embed_url,
      l.map_link_url AS managed_map_link_url
    FROM events e
    LEFT JOIN locations l ON l.id = e.location_id
    WHERE e.id = ?
  `).get(eventId));
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

function getPublicRoster(eventId) {
  return db.prepare(`
    SELECT p.id, p.name, r.status, r.updated_at
    FROM responses r
    JOIN participants p ON p.id = r.participant_id
    WHERE r.event_id = ? AND p.active = 1
    ORDER BY
      CASE r.status
        WHEN 'yes' THEN 1
        WHEN 'maybe' THEN 2
        WHEN 'no' THEN 3
        ELSE 4
      END,
      p.name ASC
  `).all(eventId);
}

function getRsvpSummary(eventId) {
  const row = db.prepare(`
    SELECT
      COUNT(p.id) AS invited_count,
      SUM(CASE WHEN r.status = 'yes' THEN 1 ELSE 0 END) AS yes_count,
      SUM(CASE WHEN r.status = 'maybe' THEN 1 ELSE 0 END) AS maybe_count,
      SUM(CASE WHEN r.status = 'no' THEN 1 ELSE 0 END) AS no_count
    FROM participants p
    LEFT JOIN responses r ON r.participant_id = p.id AND r.event_id = ?
    WHERE p.active = 1
  `).get(eventId);

  const summary = {
    invited: row && row.invited_count ? row.invited_count : 0,
    yes: row && row.yes_count ? row.yes_count : 0,
    maybe: row && row.maybe_count ? row.maybe_count : 0,
    no: row && row.no_count ? row.no_count : 0
  };

  summary.responded = summary.yes + summary.maybe + summary.no;
  summary.pending = Math.max(summary.invited - summary.responded, 0);
  return summary;
}

function groupPublicRoster(roster) {
  return {
    yes: roster.filter(entry => entry.status === 'yes'),
    maybe: roster.filter(entry => entry.status === 'maybe'),
    no: roster.filter(entry => entry.status === 'no')
  };
}

function emptyGroupedRoster() {
  return { yes: [], maybe: [], no: [] };
}

function renderNotFound(res) {
  return res.status(404).send(
    '<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>'
  );
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
    eventTitle: getEventTitle(event),
    arrivalNotes: getArrivalNotes(event),
    publicEventPath: isEventPublished(event) ? buildPublicEventPath(event) : null,
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

function renderPublicEventPage(res, event) {
  const summary = getRsvpSummary(event.id);
  const showPublicRoster = isPublicRosterVisible(event);
  const groupedRoster = showPublicRoster
    ? groupPublicRoster(getPublicRoster(event.id))
    : emptyGroupedRoster();

  return res.render('event', {
    event,
    summary,
    groupedRoster,
    showPublicRoster,
    formatEventDate,
    formatTime,
    eventTitle: getEventTitle(event),
    arrivalNotes: getArrivalNotes(event)
  });
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

// ── GET /e/:slug ─────────────────────────────────────────────
router.get('/e/:slug', (req, res) => {
  const event = getEventByPublicSlug(req.params.slug);
  if (!event || !isEventPublished(event)) {
    return renderNotFound(res);
  }

  const canonicalPath = buildPublicEventPath(event);
  const requestedPath = `/e/${encodeURIComponent(req.params.slug)}`;
  if (canonicalPath !== requestedPath) {
    return res.redirect(canonicalPath);
  }

  return renderPublicEventPage(res, event);
});

// ── GET /event/:id ───────────────────────────────────────────
router.get('/event/:id', (req, res) => {
  const event = getEventById(req.params.id);
  if (!event || !isEventPublished(event)) {
    return renderNotFound(res);
  }

  return renderPublicEventPage(res, event);
});

module.exports = router;
