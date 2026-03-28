'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// In Docker the DB lives in the mounted data/ volume; tests can override it with DB_PATH.
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'euchre.db');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS participants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    rsvp_token  TEXT NOT NULL UNIQUE,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_date      TEXT NOT NULL,
    location_name   TEXT NOT NULL,
    location_image  TEXT,
    start_time      TEXT NOT NULL,
    end_time        TEXT NOT NULL,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS responses (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL REFERENCES participants(id),
    event_id       INTEGER NOT NULL REFERENCES events(id),
    status         TEXT NOT NULL CHECK(status IN ('yes','no','maybe')),
    comment        TEXT,
    change_count   INTEGER NOT NULL DEFAULT 1,
    responded_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(participant_id, event_id)
  );

  CREATE TABLE IF NOT EXISTS admin_tokens (
    token       TEXT PRIMARY KEY,
    expires_at  TEXT NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0
  );
`);

const duplicateParticipantEmails = db.prepare(`
  SELECT LOWER(email) AS email_key, COUNT(*) AS count
  FROM participants
  GROUP BY LOWER(email)
  HAVING COUNT(*) > 1
`).all();

if (duplicateParticipantEmails.length === 0) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS participants_email_unique
    ON participants(email COLLATE NOCASE)
  `);
} else {
  console.warn(
    'Skipping participants_email_unique index because duplicate participant emails already exist:',
    duplicateParticipantEmails.map(row => row.email_key).join(', ')
  );
}

module.exports = db;
