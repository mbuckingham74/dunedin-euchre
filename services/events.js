'use strict';

const { formatEventDate } = require('./email');

function getEventTitle(event) {
  const title = (event && event.title ? event.title : '').trim();
  if (title) return title;

  if (event && event.event_date) {
    return `Dunedin Euchre on ${formatEventDate(event.event_date)}`;
  }

  return 'Dunedin Euchre';
}

function getArrivalNotes(event) {
  return (event && (event.arrival_notes || event.notes) ? (event.arrival_notes || event.notes) : '').trim();
}

function isEventPublished(event) {
  return Boolean(event && Number(event.is_published));
}

function isPublicRosterVisible(event) {
  return Boolean(event && Number(event.show_public_roster));
}

function normalizePublicSlug(value) {
  const trimmed = (value || '').trim().toLowerCase();
  if (!trimmed) return null;

  const slug = trimmed
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || null;
}

module.exports = {
  getArrivalNotes,
  getEventTitle,
  isEventPublished,
  isPublicRosterVisible,
  normalizePublicSlug
};
