'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dunedin-euchre-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.BASE_URL = 'http://127.0.0.1';
process.env.RESEND_API_KEY = 're_test_key';

const emailServicePath = require.resolve('../services/email');
delete require.cache[emailServicePath];
const emailService = require(emailServicePath);
emailService.sendMagicLink = async () => {};
emailService.sendRsvpInvite = async () => {};
require.cache[emailServicePath].exports = emailService;

const serverModulePath = require.resolve('../server');
delete require.cache[serverModulePath];
const { app } = require('../server');
const db = require('../db/database');

let server;
let baseUrl;

function resetDatabase() {
  db.exec(`
    DELETE FROM responses;
    DELETE FROM participants;
    DELETE FROM events;
    DELETE FROM admin_tokens;
    DELETE FROM sessions;
  `);
}

function insertParticipant(overrides = {}) {
  const participant = {
    name: 'Alice Example',
    email: 'alice@example.com',
    rsvp_token: 'participant-token',
    active: 1,
    ...overrides
  };

  db.prepare(`
    INSERT INTO participants (name, email, rsvp_token, active)
    VALUES (?, ?, ?, ?)
  `).run(participant.name, participant.email, participant.rsvp_token, participant.active);

  return db.prepare('SELECT * FROM participants WHERE email = ?').get(participant.email);
}

function insertEvent(overrides = {}) {
  const event = {
    event_date: '2026-04-15',
    location_name: 'Dunedin Community Center',
    location_image: null,
    start_time: '18:00',
    end_time: '21:00',
    notes: null,
    ...overrides
  };

  const result = db.prepare(`
    INSERT INTO events (event_date, location_name, location_image, start_time, end_time, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    event.event_date,
    event.location_name,
    event.location_image,
    event.start_time,
    event.end_time,
    event.notes
  );

  return db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid);
}

async function signInAsAdmin() {
  const token = `admin-token-${Date.now()}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO admin_tokens (token, expires_at, used) VALUES (?, ?, 0)').run(token, expiresAt);

  const response = await fetch(`${baseUrl}/admin/auth/${token}`, {
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.length > 0);
  return cookies[0].split(';', 1)[0];
}

test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => {
  resetDatabase();
});

test.after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('event-scoped RSVP submissions write to the requested event', async () => {
  const participant = insertParticipant();
  const olderEvent = insertEvent({ event_date: '2026-04-15' });
  insertEvent({ event_date: '2026-05-15' });

  const response = await fetch(`${baseUrl}/rsvp/${participant.rsvp_token}/${olderEvent.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'yes', comment: 'See you there' })
  });

  assert.equal(response.status, 200);
  const saved = db.prepare(`
    SELECT event_id, status, comment
    FROM responses
    WHERE participant_id = ?
  `).get(participant.id);

  assert.deepEqual(saved, {
    event_id: olderEvent.id,
    status: 'yes',
    comment: 'See you there'
  });
});

test('legacy token-only RSVP links stop guessing when multiple events exist', async () => {
  const participant = insertParticipant();
  insertEvent({ event_date: '2026-04-15' });
  insertEvent({ event_date: '2026-05-15' });

  const response = await fetch(`${baseUrl}/rsvp/${participant.rsvp_token}`, {
    redirect: 'manual'
  });

  assert.equal(response.status, 410);
  const body = await response.text();
  assert.match(body, /out of date/i);
});

test('requesting a magic link does not invalidate another outstanding token', async () => {
  const existingToken = 'still-valid-token';
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO admin_tokens (token, expires_at, used) VALUES (?, ?, 0)')
    .run(existingToken, expiresAt);

  const response = await fetch(`${baseUrl}/admin/request-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'admin@example.com' })
  });

  assert.equal(response.status, 200);
  const existing = db.prepare('SELECT used FROM admin_tokens WHERE token = ?').get(existingToken);
  assert.equal(existing.used, 0);
  const tokenCount = db.prepare('SELECT COUNT(*) AS count FROM admin_tokens').get().count;
  assert.equal(tokenCount, 2);
});

test('participant create route reactivates instead of duplicating an existing email', async () => {
  insertParticipant({ name: 'Old Name', active: 0 });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/participants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      name: 'New Name',
      email: 'alice@example.com'
    }),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  const participants = db.prepare(`
    SELECT name, email, active
    FROM participants
    ORDER BY id
  `).all();

  assert.deepEqual(participants, [{
    name: 'New Name',
    email: 'alice@example.com',
    active: 1
  }]);
});

test('stats page shows a placeholder instead of 1.0 for participants with no responses', async () => {
  insertParticipant();
  insertEvent();
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/stats`, {
    headers: { cookie }
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, />1\.0<\/td>/);
  assert.match(body, /<td style="color:#64748b;text-align:center;">\s*—\s*<\/td>/);
});
