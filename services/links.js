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
  buildRsvpUrl
};
