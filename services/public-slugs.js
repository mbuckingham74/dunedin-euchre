'use strict';

const db = require('../db/database');

function createPublicSlugConflictError(publicSlug) {
  const error = new Error(`Public slug conflict: ${publicSlug}`);
  error.code = 'PUBLIC_SLUG_CONFLICT';
  return error;
}

function isSqliteUniqueConstraint(error) {
  return Boolean(error && (
    error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  ));
}

function getEventByPublicSlug(publicSlug) {
  return db.prepare(`
    SELECT
      e.*,
      s.slug AS matched_public_slug,
      s.is_current AS matched_public_slug_is_current
    FROM event_public_slugs s
    JOIN events e ON e.id = s.event_id
    WHERE s.slug = ? COLLATE NOCASE
  `).get(publicSlug);
}

function listEventPublicSlugs(eventId) {
  return db.prepare(`
    SELECT slug, is_current, created_at
    FROM event_public_slugs
    WHERE event_id = ?
    ORDER BY is_current DESC, id DESC
  `).all(eventId);
}

function reserveEventPublicSlug(eventId, publicSlug) {
  db.prepare(`
    UPDATE event_public_slugs
    SET is_current = 0
    WHERE event_id = ?
  `).run(eventId);

  if (!publicSlug) return;

  const existing = db.prepare(`
    SELECT id, event_id
    FROM event_public_slugs
    WHERE slug = ? COLLATE NOCASE
  `).get(publicSlug);

  if (existing && existing.event_id !== eventId) {
    throw createPublicSlugConflictError(publicSlug);
  }

  if (existing) {
    db.prepare(`
      UPDATE event_public_slugs
      SET is_current = 1
      WHERE id = ?
    `).run(existing.id);
    return;
  }

  try {
    db.prepare(`
      INSERT INTO event_public_slugs (event_id, slug, is_current)
      VALUES (?, ?, 1)
    `).run(eventId, publicSlug);
  } catch (error) {
    if (isSqliteUniqueConstraint(error)) {
      throw createPublicSlugConflictError(publicSlug);
    }
    throw error;
  }
}

function isPublicSlugConflictError(error) {
  return Boolean(error && error.code === 'PUBLIC_SLUG_CONFLICT');
}

module.exports = {
  getEventByPublicSlug,
  isPublicSlugConflictError,
  listEventPublicSlugs,
  reserveEventPublicSlug
};
