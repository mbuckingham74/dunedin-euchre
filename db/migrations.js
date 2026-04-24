'use strict';

const {
  buildLocationMapEmbedUrl,
  buildLocationMapLinkUrl,
  normalizeLocationAddress,
  normalizeLocationText
} = require('../services/locations');

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

function backfillManagedLocations(db) {
  const events = db.prepare(`
    SELECT id, location_name, location_address, location_image, map_embed_url, map_link_url
    FROM events
    WHERE location_name IS NOT NULL AND TRIM(location_name) != ''
    ORDER BY id ASC
  `).all();

  const findLocation = db.prepare(`
    SELECT id, location_image, map_embed_url, map_link_url
    FROM locations
    WHERE name = ? COLLATE NOCASE AND address = ? COLLATE NOCASE
  `);
  const insertLocation = db.prepare(`
    INSERT INTO locations (
      name,
      address,
      location_image,
      map_embed_url,
      map_link_url
    )
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateLocation = db.prepare(`
    UPDATE locations
    SET location_image = COALESCE(location_image, ?),
        map_embed_url = COALESCE(map_embed_url, ?),
        map_link_url = COALESCE(map_link_url, ?),
        updated_at = datetime('now')
    WHERE id = ?
  `);
  const updateEvent = db.prepare(`
    UPDATE events
    SET location_id = ?,
        map_embed_url = COALESCE(NULLIF(map_embed_url, ''), ?),
        map_link_url = COALESCE(NULLIF(map_link_url, ''), ?)
    WHERE id = ?
  `);

  for (const event of events) {
    const name = normalizeLocationText(event.location_name);
    if (!name) continue;

    const address = normalizeLocationAddress(event.location_address) || '';
    const mapEmbedUrl = event.map_embed_url || buildLocationMapEmbedUrl(address);
    const mapLinkUrl = event.map_link_url || buildLocationMapLinkUrl(address);
    const existing = findLocation.get(name, address);

    let locationId;
    if (existing) {
      locationId = existing.id;
      updateLocation.run(
        event.location_image || null,
        mapEmbedUrl || null,
        mapLinkUrl || null,
        existing.id
      );
    } else {
      const inserted = insertLocation.run(
        name,
        address,
        event.location_image || null,
        mapEmbedUrl || null,
        mapLinkUrl || null
      );
      locationId = inserted.lastInsertRowid;
    }

    updateEvent.run(locationId, mapEmbedUrl || null, mapLinkUrl || null, event.id);
  }
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
  },
  {
    id: '004_event_public_slug_and_roster_visibility',
    up(db) {
      addColumnIfMissing(db, 'events', 'public_slug', 'public_slug TEXT');
      addColumnIfMissing(
        db,
        'events',
        'show_public_roster',
        'show_public_roster INTEGER NOT NULL DEFAULT 0 CHECK(show_public_roster IN (0, 1))'
      );

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS events_public_slug_unique
        ON events(public_slug COLLATE NOCASE)
        WHERE public_slug IS NOT NULL AND TRIM(public_slug) != ''
      `);
    }
  },
  {
    id: '005_event_public_slug_history',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS event_public_slugs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          slug        TEXT NOT NULL,
          is_current  INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0, 1)),
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS event_public_slugs_slug_unique
        ON event_public_slugs(slug COLLATE NOCASE);

        CREATE UNIQUE INDEX IF NOT EXISTS event_public_slugs_current_event_unique
        ON event_public_slugs(event_id)
        WHERE is_current = 1;
      `);

      db.exec(`
        INSERT OR IGNORE INTO event_public_slugs (event_id, slug, is_current)
        SELECT id, public_slug, 1
        FROM events
        WHERE public_slug IS NOT NULL AND TRIM(public_slug) != ''
      `);
    }
  },
  {
    id: '006_locations_manager',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS locations (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          name           TEXT NOT NULL,
          address        TEXT NOT NULL DEFAULT '',
          location_image TEXT,
          map_embed_url  TEXT,
          map_link_url   TEXT,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS locations_name_address_unique
        ON locations(name COLLATE NOCASE, address COLLATE NOCASE);
      `);

      addColumnIfMissing(
        db,
        'events',
        'location_id',
        'location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL'
      );
      addColumnIfMissing(db, 'events', 'map_embed_url', 'map_embed_url TEXT');
      addColumnIfMissing(db, 'events', 'map_link_url', 'map_link_url TEXT');

      backfillManagedLocations(db);
    }
  },
  {
    id: '007_party_member_rsvps',
    up(db) {
      addColumnIfMissing(db, 'participants', 'party_members', 'party_members TEXT');
      addColumnIfMissing(db, 'responses', 'attendee_names', 'attendee_names TEXT');

      const participants = db.prepare(`
        SELECT id, name
        FROM participants
        WHERE party_members IS NULL OR TRIM(party_members) = ''
      `).all();
      const updateParticipant = db.prepare(`
        UPDATE participants
        SET party_members = ?
        WHERE id = ?
      `);

      for (const participant of participants) {
        const fallbackName = (participant.name || '').trim();
        const partyMembers = fallbackName ? JSON.stringify([fallbackName]) : '[]';
        updateParticipant.run(partyMembers, participant.id);
      }

      const yesResponses = db.prepare(`
        SELECT r.id, p.party_members, p.name
        FROM responses r
        JOIN participants p ON p.id = r.participant_id
        WHERE r.status = 'yes' AND (r.attendee_names IS NULL OR TRIM(r.attendee_names) = '')
      `).all();
      const updateResponse = db.prepare(`
        UPDATE responses
        SET attendee_names = ?
        WHERE id = ?
      `);

      for (const response of yesResponses) {
        let attendeeNames = '[]';

        try {
          const parsed = JSON.parse(response.party_members);
          attendeeNames = Array.isArray(parsed) && parsed.length > 0
            ? JSON.stringify(parsed)
            : JSON.stringify([(response.name || '').trim()].filter(Boolean));
        } catch (error) {
          attendeeNames = JSON.stringify([(response.name || '').trim()].filter(Boolean));
        }

        updateResponse.run(attendeeNames, response.id);
      }
    }
  },
  {
    id: '008_scheduled_reminders',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_reminders (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id         INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          participant_id   INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
          kind             TEXT NOT NULL,
          send_at          TEXT NOT NULL,
          subject          TEXT NOT NULL,
          status           TEXT NOT NULL DEFAULT 'pending'
                           CHECK(status IN ('pending', 'processing', 'sent', 'failed', 'canceled')),
          resend_email_id  TEXT,
          last_error       TEXT,
          created_at       TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
          sent_at          TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS scheduled_reminders_event_participant_kind_unique
        ON scheduled_reminders(event_id, participant_id, kind);

        CREATE INDEX IF NOT EXISTS scheduled_reminders_status_send_at_idx
        ON scheduled_reminders(status, send_at);
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
