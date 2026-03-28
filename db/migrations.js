'use strict';

function getTableColumns(db, tableName) {
  return new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map(column => column.name)
  );
}

function addColumnIfMissing(db, tableName, columnName, definition) {
  const columns = getTableColumns(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function ensureParticipantEmailUniqueIndex(db) {
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
    return;
  }

  console.warn(
    'Skipping participants_email_unique index because duplicate participant emails already exist:',
    duplicateParticipantEmails.map(row => row.email_key).join(', ')
  );
}

const migrations = [
  {
    id: '001_initial_schema',
    up(db) {
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
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          title             TEXT NOT NULL DEFAULT 'Dunedin Euchre Night',
          event_date        TEXT NOT NULL,
          location_name     TEXT NOT NULL,
          location_address  TEXT,
          location_image    TEXT,
          map_image         TEXT,
          start_time        TEXT NOT NULL,
          end_time          TEXT NOT NULL,
          notes             TEXT,
          arrival_notes     TEXT,
          is_published      INTEGER NOT NULL DEFAULT 0 CHECK(is_published IN (0, 1)),
          created_at        TEXT NOT NULL DEFAULT (datetime('now'))
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

        CREATE TABLE IF NOT EXISTS sessions (
          sid     TEXT PRIMARY KEY,
          sess    TEXT NOT NULL,
          expired INTEGER NOT NULL
        );
      `);
    }
  },
  {
    id: '002_event_public_fields',
    up(db) {
      addColumnIfMissing(db, 'events', 'title', "title TEXT NOT NULL DEFAULT 'Dunedin Euchre Night'");
      addColumnIfMissing(db, 'events', 'location_address', 'location_address TEXT');
      addColumnIfMissing(db, 'events', 'map_image', 'map_image TEXT');
      addColumnIfMissing(db, 'events', 'arrival_notes', 'arrival_notes TEXT');
      addColumnIfMissing(
        db,
        'events',
        'is_published',
        'is_published INTEGER NOT NULL DEFAULT 0 CHECK(is_published IN (0, 1))'
      );

      db.exec(`
        UPDATE events
        SET arrival_notes = notes
        WHERE (arrival_notes IS NULL OR TRIM(arrival_notes) = '')
          AND notes IS NOT NULL
          AND TRIM(notes) != ''
      `);
    }
  },
  {
    id: '003_indexes',
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS responses_event_id_idx
        ON responses(event_id);
      `);
    }
  }
];

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations ORDER BY id ASC').all().map(row => row.id)
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    const applyMigration = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id);
    });

    applyMigration();
  }
}

module.exports = { ensureParticipantEmailUniqueIndex, runMigrations };
