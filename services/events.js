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

const MIN_PUBLIC_SLUG_LENGTH = 3;
const MAX_PUBLIC_SLUG_LENGTH = 80;
const RESERVED_PUBLIC_SLUGS = new Set([
  'admin',
  'e',
  'event',
  'events',
  'favicon-ico',
  'images',
  'js',
  'manifest-json',
  'public',
  'rsvp',
  'styles',
  'sw-js',
  'uploads'
]);

function normalizePublicSlug(value) {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;

  const ascii = trimmed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  const slug = ascii
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || null;
}

function parsePublicSlugInput(value) {
  const rawValue = (value || '').trim();
  if (!rawValue) {
    return { value: null, error: null };
  }

  const normalized = normalizePublicSlug(rawValue);
  if (!normalized) {
    return {
      value: null,
      error: 'Public URL slug must include at least one letter or number.'
    };
  }

  if (normalized.length < MIN_PUBLIC_SLUG_LENGTH || normalized.length > MAX_PUBLIC_SLUG_LENGTH) {
    return {
      value: null,
      error: `Public URL slug must be ${MIN_PUBLIC_SLUG_LENGTH}-${MAX_PUBLIC_SLUG_LENGTH} characters after cleanup.`
    };
  }

  if (/^\d+$/.test(normalized)) {
    return {
      value: null,
      error: 'Public URL slug cannot be only numbers.'
    };
  }

  if (RESERVED_PUBLIC_SLUGS.has(normalized)) {
    return {
      value: null,
      error: 'That public URL slug is reserved. Choose something more specific.'
    };
  }

  return { value: normalized, error: null };
}

module.exports = {
  getArrivalNotes,
  getEventTitle,
  isEventPublished,
  isPublicRosterVisible,
  normalizePublicSlug,
  parsePublicSlugInput
};
