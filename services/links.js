'use strict';

const crypto = require('crypto');

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || '').replace(/\/+$/, '');
}

function getRsvpLinkSecret() {
  const secret = process.env.RSVP_LINK_SECRET || process.env.SESSION_SECRET;
  if (secret) return secret;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('RSVP_LINK_SECRET or SESSION_SECRET must be set in production.');
  }

  return 'dev-secret-change-me';
}

function getParticipantId(participantOrId) {
  const participantId = typeof participantOrId === 'object' && participantOrId
    ? Number(participantOrId.id)
    : Number(participantOrId);

  if (!Number.isInteger(participantId) || participantId <= 0) {
    throw new Error('A valid participant ID is required to build an RSVP link.');
  }

  return participantId;
}

function getEventId(eventOrId) {
  const eventId = typeof eventOrId === 'object' && eventOrId
    ? Number(eventOrId.id)
    : Number(eventOrId);

  if (!Number.isInteger(eventId) || eventId <= 0) {
    throw new Error('A valid event ID is required to build an RSVP link.');
  }

  return eventId;
}

function buildRsvpToken(participantOrId, eventOrId) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    pid: getParticipantId(participantOrId),
    eid: getEventId(eventOrId)
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', getRsvpLinkSecret())
    .update(payload)
    .digest('base64url');

  return `${payload}.${signature}`;
}

function verifyRsvpToken(token) {
  if (!token || typeof token !== 'string') return null;

  const segments = token.split('.');
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;

  const [payload, providedSignature] = segments;
  const expectedSignature = crypto
    .createHmac('sha256', getRsvpLinkSecret())
    .update(payload)
    .digest('base64url');

  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }

  const participantId = Number(parsed.pid);
  const eventId = Number(parsed.eid);
  if (
    Number(parsed.v) !== 1 ||
    !Number.isInteger(participantId) ||
    participantId <= 0 ||
    !Number.isInteger(eventId) ||
    eventId <= 0
  ) {
    return null;
  }

  return { participantId, eventId };
}

function buildRsvpPath(participantOrToken, eventOrId) {
  const token = buildRsvpToken(participantOrToken, eventOrId);
  return `/rsvp/${encodeURIComponent(token)}`;
}

function buildRsvpUrl(baseUrl, participantOrToken, eventOrId) {
  return `${normalizeBaseUrl(baseUrl)}${buildRsvpPath(participantOrToken, eventOrId)}`;
}

function buildPublicEventPath(eventOrId) {
  if (typeof eventOrId === 'object' && eventOrId) {
    const publicSlug = (eventOrId.public_slug || '').trim();
    if (publicSlug) return `/e/${encodeURIComponent(publicSlug)}`;
    return `/event/${eventOrId.id}`;
  }

  return `/event/${eventOrId}`;
}

function buildPublicEventUrl(baseUrl, eventOrId) {
  return `${normalizeBaseUrl(baseUrl)}${buildPublicEventPath(eventOrId)}`;
}

module.exports = {
  buildPublicEventPath,
  buildPublicEventUrl,
  buildRsvpPath,
  buildRsvpToken,
  buildRsvpUrl,
  verifyRsvpToken
};
