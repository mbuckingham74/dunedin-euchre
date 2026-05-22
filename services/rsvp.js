'use strict';

const {
  getParticipantPartyMembers,
  sanitizeSelectedAttendees,
  serializeNames
} = require('./party');

const VALID_RSVP_STATUSES = ['yes', 'no', 'maybe'];

function normalizeRsvpStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRsvpComment(value) {
  return String(value || '').trim().slice(0, 400);
}

function isClearResponseStatus(status) {
  return status === '' || status === 'none' || status === 'pending' || status === 'clear';
}

function prepareRsvpResponse(participant, body, options = {}) {
  const allowClear = Boolean(options.allowClear);
  const status = normalizeRsvpStatus(body && body.status);

  if (allowClear && isClearResponseStatus(status)) {
    return {
      clear: true,
      status: null,
      comment: '',
      attendeeNames: []
    };
  }

  if (!VALID_RSVP_STATUSES.includes(status)) {
    return { error: options.invalidStatusMessage || 'Invalid status.' };
  }

  const comment = normalizeRsvpComment(body && body.comment);
  const partyMembers = getParticipantPartyMembers(participant);
  const selectedAttendeeNames = sanitizeSelectedAttendees(
    participant,
    body && (body.attendeeNames !== undefined ? body.attendeeNames : body.attendee_names)
  );
  const attendeeNames = status === 'yes' && selectedAttendeeNames.length === 0 && partyMembers.length === 1
    ? partyMembers
    : selectedAttendeeNames;

  if (status === 'yes' && attendeeNames.length === 0) {
    return {
      error: options.missingAttendeesMessage || 'Choose who is coming before saving this RSVP.'
    };
  }

  return {
    clear: false,
    status,
    comment,
    attendeeNames: status === 'yes' ? attendeeNames : []
  };
}

function saveRsvpResponseRecord(database, participantId, eventId, responseInput) {
  const existing = database.prepare(
    'SELECT * FROM responses WHERE participant_id = ? AND event_id = ?'
  ).get(participantId, eventId);

  if (responseInput.clear) {
    if (existing) {
      database.prepare(
        'DELETE FROM responses WHERE participant_id = ? AND event_id = ?'
      ).run(participantId, eventId);
    }

    return {
      cleared: Boolean(existing),
      record: null
    };
  }

  if (existing) {
    database.prepare(`
      UPDATE responses
      SET status = ?, comment = ?, attendee_names = ?, change_count = change_count + 1, updated_at = datetime('now')
      WHERE participant_id = ? AND event_id = ?
    `).run(
      responseInput.status,
      responseInput.comment,
      serializeNames(responseInput.attendeeNames),
      participantId,
      eventId
    );
  } else {
    database.prepare(`
      INSERT INTO responses (participant_id, event_id, status, comment, attendee_names, change_count)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(
      participantId,
      eventId,
      responseInput.status,
      responseInput.comment,
      serializeNames(responseInput.attendeeNames)
    );
  }

  return {
    cleared: false,
    record: database.prepare(
      'SELECT * FROM responses WHERE participant_id = ? AND event_id = ?'
    ).get(participantId, eventId)
  };
}

module.exports = {
  VALID_RSVP_STATUSES,
  normalizeRsvpStatus,
  prepareRsvpResponse,
  saveRsvpResponseRecord
};
