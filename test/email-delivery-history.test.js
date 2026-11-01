'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dunedin-email-history-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

const db = require('../db/database');
const { runMigrations } = require('../db/migrations');
const { sendMagicLink, sendRsvpInvite } = require('../services/email');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function apiResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function inviteFixture(suffix) {
  const event = db.prepare(`
    INSERT INTO events (title, event_date, location_name, start_time, end_time)
    VALUES (?, ?, ?, ?, ?)
  `).run(`Invite Test ${suffix}`, '2026-12-12', 'Test Hall', '18:00', '20:00');
  const participant = db.prepare(`
    INSERT INTO participants (name, email, rsvp_token)
    VALUES (?, ?, ?)
  `).run(`Participant ${suffix}`, `${suffix}@example.com`, `token-${suffix}`);
  return {
    event: { id: Number(event.lastInsertRowid), title: `Invite Test ${suffix}`, event_date: '2026-12-12' },
    participant: {
      id: Number(participant.lastInsertRowid),
      name: `Participant ${suffix}`,
      email: `${suffix}@example.com`
    }
  };
}

test('invitation send stores SMTP2GO ID and a reconciliation header in SQLite', async () => {
  const { event, participant } = inviteFixture('stored');
  let requestBody;
  const result = await sendRsvpInvite(participant, event, {
    emailOptions: {
      apiKey: 'test-key',
      fetchImpl: async (url, options) => {
        requestBody = JSON.parse(options.body);
        return apiResponse({
          request_id: 'request-1',
          data: { succeeded: 1, failed: 0, email_id: 'smtp-invite-1' }
        });
      }
    }
  });

  const delivery = db.prepare(`
    SELECT provider, purpose, event_id, participant_id, recipient_email,
           provider_message_id, delivery_status, delivery_key
    FROM email_delivery_history
    WHERE provider_message_id = ?
  `).get('smtp-invite-1');

  assert.equal(result.id, 'smtp-invite-1');
  assert.equal(delivery.provider, 'smtp2go');
  assert.equal(delivery.purpose, 'invitation');
  assert.equal(delivery.event_id, event.id);
  assert.equal(delivery.participant_id, participant.id);
  assert.equal(delivery.recipient_email, participant.email);
  assert.equal(delivery.delivery_status, 'accepted');
  assert.ok(delivery.delivery_key);
  assert.deepEqual(requestBody.custom_headers, [
    { header: 'X-Dunedin-Delivery-ID', value: delivery.delivery_key }
  ]);
  assert.equal(Object.hasOwn(requestBody, 'track_clicks'), false);
  assert.equal(Object.hasOwn(requestBody, 'track_opens'), false);
});

test('admin magic-link email keeps tracking controls off and records the SMTP2GO message ID', async () => {
  let requestBody;
  await sendMagicLink('admin@example.com', 'opaque-magic-token', {
    emailOptions: {
      apiKey: 'test-key',
      fetchImpl: async (url, options) => {
        requestBody = JSON.parse(options.body);
        return apiResponse({
          request_id: 'request-admin-auth',
          data: { succeeded: 1, failed: 0, email_id: 'smtp-admin-auth-1' }
        });
      }
    }
  });

  const delivery = db.prepare(`
    SELECT provider, purpose, recipient_email, provider_message_id, delivery_status
    FROM email_delivery_history
    WHERE provider_message_id = ?
  `).get('smtp-admin-auth-1');
  assert.deepEqual(delivery, {
    provider: 'smtp2go',
    purpose: 'admin_auth',
    recipient_email: 'admin@example.com',
    provider_message_id: 'smtp-admin-auth-1',
    delivery_status: 'accepted'
  });
  assert.match(requestBody.html_body, /\/admin\/auth\/opaque-magic-token/);
  assert.equal(Object.hasOwn(requestBody, 'track_clicks'), false);
  assert.equal(Object.hasOwn(requestBody, 'track_opens'), false);
});

test('an ambiguous invitation send blocks a duplicate until activity reconciliation', async () => {
  const { event, participant } = inviteFixture('ambiguous');
  let networkCalls = 0;
  const options = {
    emailOptions: {
      apiKey: 'test-key',
      maxRetries: 4,
      fetchImpl: async () => {
        networkCalls += 1;
        throw new TypeError('Response connection was lost.');
      }
    }
  };

  await assert.rejects(sendRsvpInvite(participant, event, options), error => (
    error.ambiguous === true && Boolean(error.deliveryKey)
  ));
  const previous = db.prepare(`
    SELECT delivery_key, delivery_status
    FROM email_delivery_history
    WHERE event_id = ? AND participant_id = ?
  `).get(event.id, participant.id);
  assert.equal(previous.delivery_status, 'ambiguous');

  await assert.rejects(
    sendRsvpInvite(participant, event, options),
    error => error.name === 'email_delivery_ambiguous_error'
      && error.deliveryKey === previous.delivery_key
  );
  assert.equal(networkCalls, 1);
});

test('migration 011 preserves scheduled jobs without importing completed-event delivery history', () => {
  const legacyDb = new Database(':memory:');
  legacyDb.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE scheduled_reminders (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL,
      participant_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      send_at TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL,
      resend_email_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    );
    CREATE TABLE scheduled_rsvp_summaries (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL UNIQUE,
      send_at TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL,
      resend_email_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    );
  `);
  const priorMigrations = [
    '001_initial_schema',
    '002_event_public_fields',
    '003_indexes',
    '004_event_public_slug_and_roster_visibility',
    '005_event_public_slug_history',
    '006_locations_manager',
    '007_party_member_rsvps',
    '008_scheduled_reminders',
    '009_scheduled_rsvp_summaries',
    '010_notification_copy_settings'
  ];
  const priorMigration = legacyDb.prepare('INSERT INTO schema_migrations (id) VALUES (?)');
  for (const migrationId of priorMigrations) priorMigration.run(migrationId);

  const insertReminder = legacyDb.prepare(`
    INSERT INTO scheduled_reminders (
      id, event_id, participant_id, kind, send_at, subject, status,
      resend_email_id, last_error, sent_at
    ) VALUES (?, ?, ?, 'day_before_9am_pacific', ?, ?, ?, ?, ?, ?)
  `);
  const insertSummary = legacyDb.prepare(`
    INSERT INTO scheduled_rsvp_summaries (
      id, event_id, send_at, recipient_email, subject, status,
      resend_email_id, last_error, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let number = 1; number <= 25; number += 1) {
    const messageId = `resend-scheduled-${String(number).padStart(2, '0')}`;
    const status = number === 25 ? 'failed' : 'sent';
    const sentAt = number === 25 ? null : `2026-08-${String(number).padStart(2, '0')}T12:00:00.000Z`;
    const lastError = number === 25 ? 'Legacy delivery failure' : null;
    if (number <= 13) {
      insertReminder.run(
        number, number, number, `2026-08-${String(number).padStart(2, '0')}T09:00:00.000Z`,
        `Reminder ${number}`, status, messageId, lastError, sentAt
      );
    } else {
      insertSummary.run(
        number - 13, number, `2026-08-${String(number).padStart(2, '0')}T18:00:00.000Z`,
        'admin@example.com', `Summary ${number}`, status, messageId, lastError, sentAt
      );
    }
  }

  const before = legacyDb.prepare(`
    SELECT kind, id, event_id, participant_id, job_kind, send_at, subject,
           status, resend_email_id, last_error, sent_at
    FROM (
      SELECT 'reminder' AS kind, id, event_id, participant_id, kind AS job_kind,
             send_at, subject, status, resend_email_id, last_error, sent_at
      FROM scheduled_reminders
      UNION ALL
      SELECT 'summary' AS kind, id, event_id, NULL AS participant_id, 'rsvp_summary' AS job_kind,
             send_at, subject, status, resend_email_id, last_error, sent_at
      FROM scheduled_rsvp_summaries
    )
    ORDER BY kind, id
  `).all();
  assert.equal(before.length, 25);

  runMigrations(legacyDb);

  const after = legacyDb.prepare(`
    SELECT kind, id, event_id, participant_id, job_kind, send_at, subject,
           status, resend_email_id, last_error, sent_at,
           email_provider, provider_message_id, provider_delivery_status
    FROM (
      SELECT 'reminder' AS kind, id, event_id, participant_id, kind AS job_kind,
             send_at, subject, status, resend_email_id, last_error, sent_at,
             email_provider, provider_message_id, provider_delivery_status
      FROM scheduled_reminders
      UNION ALL
      SELECT 'summary' AS kind, id, event_id, NULL AS participant_id, 'rsvp_summary' AS job_kind,
             send_at, subject, status, resend_email_id, last_error, sent_at,
             email_provider, provider_message_id, provider_delivery_status
      FROM scheduled_rsvp_summaries
    )
    ORDER BY kind, id
  `).all();

  assert.equal(after.length, 25);
  for (const record of after) {
    const { email_provider, provider_message_id, provider_delivery_status, ...schedule } = record;
    assert.deepEqual(schedule, before.find(row => row.kind === record.kind && row.id === record.id));
    assert.equal(email_provider, null);
    assert.equal(provider_message_id, null);
    assert.equal(provider_delivery_status, null);
  }
  assert.equal(legacyDb.prepare('SELECT COUNT(*) AS count FROM email_delivery_history').get().count, 0);
  assert.equal(legacyDb.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '011_smtp2go_delivery_history'").get().count, 1);
  legacyDb.close();
});
