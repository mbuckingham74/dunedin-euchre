'use strict';

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || '').replace(/\/+$/, '');
}

function buildRsvpPath(participantOrToken, eventOrId) {
  const token = typeof participantOrToken === 'string'
    ? participantOrToken
    : participantOrToken.rsvp_token;
  const eventId = typeof eventOrId === 'object'
    ? eventOrId.id
    : eventOrId;

  return `/rsvp/${token}/${eventId}`;
}

function buildRsvpUrl(baseUrl, participantOrToken, eventOrId) {
  return `${normalizeBaseUrl(baseUrl)}${buildRsvpPath(participantOrToken, eventOrId)}`;
}

module.exports = { buildRsvpPath, buildRsvpUrl };
