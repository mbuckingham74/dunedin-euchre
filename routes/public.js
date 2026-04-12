'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { formatEventDate, formatTime } = require('../services/email');
const {
  getArrivalNotes,
  getEventStartLabel,
  getEventTitle,
  hasEventStarted,
  isEventPublished,
  isPublicRosterVisible
} = require('../services/events');
const { buildPublicEventPath, buildRsvpPath, verifyRsvpToken } = require('../services/links');
const { applyManagedLocation } = require('../services/locations');
const {
  buildPartyResponseView,
  expandRosterIndividuals,
  getIndividualCounts,
  getParticipantPartyMembers,
  getSelectedAttendeeNames,
  sanitizeSelectedAttendees,
  serializeNames
} = require('../services/party');
const { getEventByPublicSlug } = require('../services/public-slugs');
const {
  grantEventPageAccess,
  hasEventPageAccess
} = require('../middleware/auth');

// ── Root landing page ─────────────────────────────────────────
router.get('/', (req, res) => {
  res.render('landing');
});

// ── Helpers ──────────────────────────────────────────────────

function getLegacyParticipantByToken(token) {
  return db.prepare(
    'SELECT * FROM participants WHERE rsvp_token = ? AND active = 1'
  ).get(token);
}

function getParticipantById(participantId) {
  return db.prepare(
    'SELECT * FROM participants WHERE id = ? AND active = 1'
  ).get(participantId);
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

function getInviteByToken(token) {
  const invite = verifyRsvpToken(token);
  if (!invite) return null;

  const participant = getParticipantById(invite.participantId);
  const event = getEventById(invite.eventId);
  if (!participant || !event) return null;

  return { participant, event };
}

function getRoster(eventId) {
  return db.prepare(`
    SELECT p.id, p.name, p.party_members, r.status, r.comment, r.change_count, r.attendee_names
    FROM participants p
    LEFT JOIN responses r ON r.participant_id = p.id AND r.event_id = ?
    WHERE p.active = 1
    ORDER BY p.name ASC
  `).all(eventId).map(buildPartyResponseView);
}

function getPublicRoster(eventId) {
  return expandRosterIndividuals(getRoster(eventId))
    .sort((left, right) => {
      const statusOrder = { yes: 1, maybe: 2, no: 3 };
      return (
        statusOrder[left.status] - statusOrder[right.status] ||
        left.name.localeCompare(right.name)
      );
    });
}

function getRsvpSummary(eventId) {
  const counts = getIndividualCounts(getRoster(eventId));
  return {
    invited: counts.invited,
    yes: counts.yes,
    maybe: counts.maybe,
    no: counts.no,
    responded: counts.responded,
    pending: counts.pending
  };
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

function setSensitiveResponseHeaders(res) {
  res.set({
    'Cache-Control': 'private, no-store, max-age=0',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer'
  });
}

function renderNotFound(res) {
  return res.status(404).send(
    '<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>'
  );
}

function renderLegacyRsvpPage(res, participant = null) {
  setSensitiveResponseHeaders(res);
  return res.status(410).render('legacy-rsvp', { participant });
}

function renderRsvpPage(res, participant, event) {
  setSensitiveResponseHeaders(res);
  const roster = getRoster(event.id);
  const myResponse = roster.find(r => r.id === participant.id);
  const canEdit = !hasEventStarted(event);

  res.render('rsvp', {
    participant,
    event,
    roster,
    myResponse: myResponse || null,
    canEdit,
    eventStartLabel: getEventStartLabel(event),
    participantPartyMembers: getParticipantPartyMembers(participant),
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
  setSensitiveResponseHeaders(res);
  const { status, comment } = body;
  if (!['yes', 'no', 'maybe'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  if (hasEventStarted(event)) {
    return res.status(409).json({
      error: `RSVP changes closed when the event started on ${getEventStartLabel(event)}.`
    });
  }

  const trimmedComment = (comment || '').trim().slice(0, 400);
  const partyMembers = getParticipantPartyMembers(participant);
  const selectedAttendeeNames = sanitizeSelectedAttendees(participant, body.attendeeNames);
  const normalizedAttendeeNames = status === 'yes' && selectedAttendeeNames.length === 0 && partyMembers.length === 1
    ? partyMembers
    : selectedAttendeeNames;
  if (status === 'yes' && normalizedAttendeeNames.length === 0) {
    return res.status(400).json({
      error: 'Choose who is coming before saving this RSVP.'
    });
  }

  const existing = db.prepare(
    'SELECT * FROM responses WHERE participant_id = ? AND event_id = ?'
  ).get(participant.id, event.id);

  if (existing) {
    db.prepare(`
      UPDATE responses
      SET status = ?, comment = ?, attendee_names = ?, change_count = change_count + 1, updated_at = datetime('now')
      WHERE participant_id = ? AND event_id = ?
    `).run(
      status,
      trimmedComment,
      serializeNames(status === 'yes' ? normalizedAttendeeNames : []),
      participant.id,
      event.id
    );
  } else {
    db.prepare(`
      INSERT INTO responses (participant_id, event_id, status, comment, attendee_names, change_count)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(
      participant.id,
      event.id,
      status,
      trimmedComment,
      serializeNames(status === 'yes' ? normalizedAttendeeNames : [])
    );
  }

  const roster = getRoster(event.id);
  const updated = db.prepare(
    'SELECT * FROM responses WHERE participant_id = ? AND event_id = ?'
  ).get(participant.id, event.id);

  return res.json({
    ok: true,
    roster,
    canEdit: true,
    attendeeNames: getSelectedAttendeeNames(updated, participant)
  });
}

function renderPublicEventPage(res, event) {
  setSensitiveResponseHeaders(res);
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

// ── GET /rsvp/:token/:eventId ────────────────────────────────
router.get('/rsvp/:token/:eventId', (req, res) => {
  const invite = getInviteByToken(req.params.token);
  if (invite && String(invite.event.id) === String(req.params.eventId)) {
    grantEventPageAccess(req, invite.event.id);
    return res.redirect(buildRsvpPath(invite.participant, invite.event));
  }

  const participant = getLegacyParticipantByToken(req.params.token);
  if (participant) return renderLegacyRsvpPage(res, participant);

  return res.status(404).send(
    '<h1 style="font-family:sans-serif;padding:2rem">Link not found or no longer active.</h1>'
  );
});

// ── GET /rsvp/:token ─────────────────────────────────────────
router.get('/rsvp/:token', (req, res) => {
  const invite = getInviteByToken(req.params.token);
  if (!invite) {
    const participant = getLegacyParticipantByToken(req.params.token);
    if (participant) return renderLegacyRsvpPage(res, participant);

    return res.status(404).send(
      '<h1 style="font-family:sans-serif;padding:2rem">Link not found or no longer active.</h1>'
    );
  }

  grantEventPageAccess(req, invite.event.id);
  return renderRsvpPage(res, invite.participant, invite.event);
});

// ── POST /rsvp/:token ────────────────────────────────────────
router.post('/rsvp/:token', express.json(), (req, res) => {
  const invite = getInviteByToken(req.params.token);

  if (!invite) {
    const participant = getLegacyParticipantByToken(req.params.token);
    if (participant) {
      return res.status(410).json({
        error: 'This RSVP link is outdated. Please use the latest invite email.'
      });
    }

    return res.status(404).json({ error: 'Link not found.' });
  }

  grantEventPageAccess(req, invite.event.id);
  return saveRsvpResponse(res, invite.participant, invite.event, req.body);
});

// ── POST /rsvp/:token/:eventId ───────────────────────────────
router.post('/rsvp/:token/:eventId', express.json(), (req, res) => {
  const participant = getLegacyParticipantByToken(req.params.token);
  if (participant) {
    return res.status(410).json({
      error: 'This RSVP link is outdated. Please use the latest invite email.'
    });
  }

  return res.status(404).json({ error: 'Link not found.' });
});

// ── GET /e/:slug ─────────────────────────────────────────────
router.get('/e/:slug', (req, res) => {
  const event = getEventByPublicSlug(req.params.slug);
  if (!event || !isEventPublished(event)) {
    return renderNotFound(res);
  }
  if (!hasEventPageAccess(req, event.id)) {
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
  if (!hasEventPageAccess(req, event.id)) {
    return renderNotFound(res);
  }

  return renderPublicEventPage(res, event);
});

module.exports = router;
