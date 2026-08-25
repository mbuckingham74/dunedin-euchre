'use strict';

const db = require('../db/database');
const {
  DEFAULT_NOTIFICATION_COPY,
  MAX_NOTIFICATION_COPY_LENGTH,
  NOTIFICATION_COPY_FIELDS
} = require('./notification-copy');

const COPY_KEYS = new Set(NOTIFICATION_COPY_FIELDS.map(field => field.key));

function normalizeCopyValue(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function getNotificationCopy() {
  const saved = db.prepare(`
    SELECT key, value
    FROM notification_settings
  `).all();
  const copy = { ...DEFAULT_NOTIFICATION_COPY };

  for (const row of saved) {
    if (COPY_KEYS.has(row.key)) {
      copy[row.key] = row.value;
    }
  }

  return copy;
}

function getNotificationCopyValidationError(input) {
  for (const field of NOTIFICATION_COPY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input || {}, field.key)) continue;

    const value = normalizeCopyValue(input[field.key]);
    if (value.length > MAX_NOTIFICATION_COPY_LENGTH) {
      return `${field.label} must be ${MAX_NOTIFICATION_COPY_LENGTH} characters or fewer.`;
    }
  }

  return null;
}

function updateNotificationCopy(input) {
  const validationError = getNotificationCopyValidationError(input);
  if (validationError) {
    throw new Error(validationError);
  }

  const upsert = db.prepare(`
    INSERT INTO notification_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `);
  const remove = db.prepare('DELETE FROM notification_settings WHERE key = ?');
  const transaction = db.transaction(() => {
    for (const field of NOTIFICATION_COPY_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(input || {}, field.key)) continue;

      const value = normalizeCopyValue(input[field.key]);
      if (!value || value === DEFAULT_NOTIFICATION_COPY[field.key]) {
        remove.run(field.key);
      } else {
        upsert.run(field.key, value);
      }
    }
  });

  transaction();
  return getNotificationCopy();
}

function resetNotificationCopy() {
  const keys = [...COPY_KEYS];
  const placeholders = keys.map(() => '?').join(', ');
  db.prepare(`DELETE FROM notification_settings WHERE key IN (${placeholders})`).run(...keys);
  return getNotificationCopy();
}

module.exports = {
  getNotificationCopy,
  getNotificationCopyValidationError,
  resetNotificationCopy,
  updateNotificationCopy
};
