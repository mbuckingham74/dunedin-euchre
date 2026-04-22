'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dunedin-euchre-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.UPLOADS_DIR = path.join(tempDir, 'uploads');
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.BASE_URL = 'http://127.0.0.1';
process.env.RESEND_API_KEY = 're_test_key';

const emailServicePath = require.resolve('../services/email');
delete require.cache[emailServicePath];
const emailService = require(emailServicePath);
emailService.sendMagicLink = async () => {};
const sentRsvpInvites = [];
emailService.sendRsvpInvite = async (participant, event) => {
  sentRsvpInvites.push({
    participant: { ...participant },
    event: { ...event }
  });
};
require.cache[emailServicePath].exports = emailService;

const serverModulePath = require.resolve('../server');
delete require.cache[serverModulePath];
const { app } = require('../server');
const db = require('../db/database');
const { buildRsvpPath } = require('../services/links');
const {
  buildLocationMapEmbedUrl,
  buildLocationMapLinkUrl
} = require('../services/locations');

let server;
let baseUrl;

function resetUploadsDirectory() {
  fs.rmSync(process.env.UPLOADS_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
}

function resetDatabase() {
  db.exec(`
    DELETE FROM responses;
    DELETE FROM participants;
    DELETE FROM event_public_slugs;
    DELETE FROM events;
    DELETE FROM locations;
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
  if (!Object.prototype.hasOwnProperty.call(participant, 'party_members')) {
    participant.party_members = JSON.stringify([participant.name]);
  }

  db.prepare(`
    INSERT INTO participants (name, email, rsvp_token, active, party_members)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    participant.name,
    participant.email,
    participant.rsvp_token,
    participant.active,
    participant.party_members
  );

  return db.prepare('SELECT * FROM participants WHERE email = ?').get(participant.email);
}

function insertEvent(overrides = {}) {
  const event = {
    title: 'Dunedin Euchre Night',
    public_slug: null,
    event_date: '2026-04-15',
    location_id: null,
    location_name: 'Dunedin Community Center',
    location_address: null,
    location_image: null,
    map_image: null,
    map_embed_url: null,
    map_link_url: null,
    start_time: '18:00',
    end_time: '21:00',
    notes: null,
    arrival_notes: null,
    is_published: 0,
    show_public_roster: 0,
    ...overrides
  };

  const result = db.prepare(`
    INSERT INTO events (
      title,
      public_slug,
      event_date,
      location_id,
      location_name,
      location_address,
      location_image,
      map_image,
      map_embed_url,
      map_link_url,
      start_time,
      end_time,
      notes,
      arrival_notes,
      is_published,
      show_public_roster
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.title,
    event.public_slug,
    event.event_date,
    event.location_id,
    event.location_name,
    event.location_address,
    event.location_image,
    event.map_image,
    event.map_embed_url,
    event.map_link_url,
    event.start_time,
    event.end_time,
    event.notes,
    event.arrival_notes,
    event.is_published,
    event.show_public_roster
  );

  if (event.public_slug) {
    db.prepare(`
      INSERT INTO event_public_slugs (event_id, slug, is_current)
      VALUES (?, ?, 1)
    `).run(result.lastInsertRowid, event.public_slug);
  }

  return db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid);
}

function insertLocation(overrides = {}) {
  const location = {
    name: 'Dunedin Community Center',
    address: '123 Main St\nDunedin, FL 34698',
    location_image: null,
    map_embed_url: null,
    map_link_url: null,
    ...overrides
  };

  const address = location.address || '';
  const mapEmbedUrl = location.map_embed_url || buildLocationMapEmbedUrl(address);
  const mapLinkUrl = location.map_link_url || buildLocationMapLinkUrl(address);

  const result = db.prepare(`
    INSERT INTO locations (
      name,
      address,
      location_image,
      map_embed_url,
      map_link_url
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    location.name,
    address,
    location.location_image,
    mapEmbedUrl,
    mapLinkUrl
  );

  return db.prepare('SELECT * FROM locations WHERE id = ?').get(result.lastInsertRowid);
}

function insertResponse(participantId, eventId, overrides = {}) {
  const response = {
    status: 'yes',
    comment: null,
    change_count: 1,
    ...overrides
  };

  db.prepare(`
    INSERT INTO responses (participant_id, event_id, status, comment, attendee_names, change_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    participantId,
    eventId,
    response.status,
    response.comment,
    Object.prototype.hasOwnProperty.call(response, 'attendee_names') ? response.attendee_names : null,
    response.change_count
  );
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

function getSessionCookie(response) {
  const cookies = response.headers.getSetCookie();
  return cookies.length > 0
    ? cookies[0].split(';', 1)[0]
    : '';
}

test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => {
  resetDatabase();
  resetUploadsDirectory();
  sentRsvpInvites.length = 0;
});

test('root shows the landing page instead of redirecting to admin', async () => {
  const response = await fetch(`${baseUrl}/`, {
    redirect: 'manual'
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Request an Invite/);
  assert.match(body, /mailto:michael\.buckingham74@gmail\.com/);
});

test.after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('health endpoint returns ok', async () => {
  const response = await fetch(`${baseUrl}/healthz`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('event-scoped RSVP submissions write to the invited event', async () => {
  const participant = insertParticipant();
  const olderEvent = insertEvent({ event_date: '2026-04-15' });
  insertEvent({ event_date: '2026-05-15' });

  const response = await fetch(`${baseUrl}${buildRsvpPath(participant, olderEvent)}`, {
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

test('party invite responses can confirm one attendee or both attendees for the same event', async () => {
  const participant = insertParticipant({
    name: 'Pam & Charlie',
    email: 'pam.charlie@example.com',
    rsvp_token: 'pam-charlie-token',
    party_members: JSON.stringify(['Pam', 'Charlie'])
  });
  const event = insertEvent({
    title: 'Shared Invite Night',
    public_slug: 'shared-invite-night',
    event_date: '2999-04-15',
    is_published: 1,
    show_public_roster: 1
  });

  const firstResponse = await fetch(`${baseUrl}${buildRsvpPath(participant, event)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'yes',
      comment: 'Pam can make it.',
      attendeeNames: ['Pam']
    })
  });

  assert.equal(firstResponse.status, 200);
  assert.deepEqual(
    db.prepare(`
      SELECT status, comment, attendee_names
      FROM responses
      WHERE participant_id = ? AND event_id = ?
    `).get(participant.id, event.id),
    {
      status: 'yes',
      comment: 'Pam can make it.',
      attendee_names: '["Pam"]'
    }
  );

  const firstInviteResponse = await fetch(`${baseUrl}${buildRsvpPath(participant, event)}`);
  const inviteCookie = getSessionCookie(firstInviteResponse);
  const firstEventResponse = await fetch(`${baseUrl}/e/${event.public_slug}`, {
    headers: { cookie: inviteCookie }
  });
  const firstBody = await firstEventResponse.text();

  assert.equal(firstEventResponse.status, 200);
  assert.match(firstBody, />1 Yes</);
  assert.match(firstBody, />0 Maybe</);
  assert.match(firstBody, />1 No</);
  assert.match(firstBody, />0 Pending</);
  assert.match(firstBody, /Pam/);
  assert.match(firstBody, /Charlie/);

  const secondResponse = await fetch(`${baseUrl}${buildRsvpPath(participant, event)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'yes',
      comment: 'Both are in.',
      attendeeNames: ['Pam', 'Charlie']
    })
  });

  assert.equal(secondResponse.status, 200);
  assert.deepEqual(
    db.prepare(`
      SELECT status, comment, attendee_names
      FROM responses
      WHERE participant_id = ? AND event_id = ?
    `).get(participant.id, event.id),
    {
      status: 'yes',
      comment: 'Both are in.',
      attendee_names: '["Pam","Charlie"]'
    }
  );

  const eventResponse = await fetch(`${baseUrl}/e/${event.public_slug}`, {
    headers: { cookie: inviteCookie }
  });
  const body = await eventResponse.text();

  assert.equal(eventResponse.status, 200);
  assert.match(body, />2 Yes</);
  assert.match(body, />0 Maybe</);
  assert.match(body, />0 No</);
  assert.match(body, />0 Pending</);
  assert.match(body, /Pam/);
  assert.match(body, /Charlie/);
});

test('RSVP updates are blocked after the event start time', async () => {
  const participant = insertParticipant();
  const event = insertEvent({
    title: 'Past Event',
    event_date: '2000-01-01',
    start_time: '18:00',
    end_time: '21:00'
  });

  const response = await fetch(`${baseUrl}${buildRsvpPath(participant, event)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'yes', attendeeNames: ['Alice Example'] })
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.match(payload.error, /RSVP changes closed/i);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM responses WHERE participant_id = ? AND event_id = ?')
      .get(participant.id, event.id).count,
    0
  );
});

test('each participant and event gets a distinct RSVP URL', () => {
  const alice = insertParticipant();
  const bob = insertParticipant({
    name: 'Bob Example',
    email: 'bob@example.com',
    rsvp_token: 'bob-token'
  });
  const springEvent = insertEvent({ event_date: '2026-04-15' });
  const summerEvent = insertEvent({ event_date: '2026-05-15' });

  assert.notEqual(buildRsvpPath(alice, springEvent), buildRsvpPath(bob, springEvent));
  assert.notEqual(buildRsvpPath(alice, springEvent), buildRsvpPath(alice, summerEvent));
});

test('published event pages require invite access and /event/:id stays as a gated fallback', async () => {
  const yesParticipant = insertParticipant();
  const noParticipant = insertParticipant({
    name: 'Bob Example',
    email: 'bob@example.com',
    rsvp_token: 'bob-token'
  });
  insertParticipant({
    name: 'Cara Pending',
    email: 'cara@example.com',
    rsvp_token: 'cara-token'
  });
  const event = insertEvent({
    title: 'Spring Euchre Social',
    public_slug: 'spring-euchre-social',
    location_name: 'Harbor Hall',
    location_address: '123 Main St\nDunedin, FL 34698',
    location_image: 'venue-photo.png',
    map_image: 'map-shot.png',
    arrival_notes: 'Use the west entrance and park beside the tennis courts.',
    notes: 'Use the west entrance and park beside the tennis courts.',
    is_published: 1,
    show_public_roster: 1
  });

  insertResponse(yesParticipant.id, event.id, { status: 'yes', comment: 'I can bring snacks.' });
  insertResponse(noParticipant.id, event.id, { status: 'no', comment: 'Out of town.' });

  const anonymousResponse = await fetch(`${baseUrl}/e/${event.public_slug}`);
  const rsvpResponse = await fetch(`${baseUrl}${buildRsvpPath(yesParticipant, event)}`);
  const inviteCookie = getSessionCookie(rsvpResponse);
  const response = await fetch(`${baseUrl}/e/${event.public_slug}`, {
    headers: { cookie: inviteCookie }
  });
  const body = await response.text();
  const fallbackResponse = await fetch(`${baseUrl}/event/${event.id}`, {
    headers: { cookie: inviteCookie }
  });

  assert.equal(anonymousResponse.status, 404);
  assert.equal(rsvpResponse.status, 200);
  assert.ok(inviteCookie);
  assert.equal(response.status, 200);
  assert.equal(fallbackResponse.status, 200);
  assert.match(body, /Spring Euchre Social/);
  assert.match(body, /Harbor Hall/);
  assert.match(body, /123 Main St/);
  assert.match(body, /Dunedin, FL 34698/);
  assert.match(body, /Use the west entrance and park beside the tennis courts\./);
  assert.match(body, /\/uploads\/venue-photo\.png/);
  assert.match(body, /\/uploads\/map-shot\.png/);
  assert.match(body, />1 Yes</);
  assert.match(body, />0 Maybe</);
  assert.match(body, />1 No</);
  assert.match(body, />1 Pending</);
  assert.match(body, /Alice Example/);
  assert.match(body, /Bob Example/);
  assert.doesNotMatch(body, /Cara Pending/);
});

test('unpublished events are not publicly accessible', async () => {
  const event = insertEvent({ is_published: 0 });

  const response = await fetch(`${baseUrl}/event/${event.id}`);

  assert.equal(response.status, 404);
});

test('invite-only event page does not expose freeform RSVP comments', async () => {
  const participant = insertParticipant();
  const event = insertEvent({
    title: 'Private Comment Test',
    is_published: 1,
    show_public_roster: 1
  });

  insertResponse(participant.id, event.id, {
    status: 'yes',
    comment: 'Please save me the quiet corner table.'
  });

  const inviteResponse = await fetch(`${baseUrl}${buildRsvpPath(participant, event)}`);
  const inviteCookie = getSessionCookie(inviteResponse);
  const response = await fetch(`${baseUrl}/event/${event.id}`, {
    headers: { cookie: inviteCookie }
  });
  const body = await response.text();

  assert.equal(inviteResponse.status, 200);
  assert.equal(response.status, 200);
  assert.doesNotMatch(body, /Please save me the quiet corner table\./);
});

test('invite-only event page can hide attendee names while still showing RSVP summary counts', async () => {
  const yesParticipant = insertParticipant();
  const maybeParticipant = insertParticipant({
    name: 'Bob Example',
    email: 'bob@example.com',
    rsvp_token: 'bob-token'
  });
  const event = insertEvent({
    title: 'Hidden Roster Night',
    public_slug: 'hidden-roster-night',
    is_published: 1,
    show_public_roster: 0
  });

  insertResponse(yesParticipant.id, event.id, {
    status: 'yes',
    comment: 'Count me in.'
  });
  insertResponse(maybeParticipant.id, event.id, {
    status: 'maybe',
    comment: 'I need to confirm with my ride.'
  });

  const inviteResponse = await fetch(`${baseUrl}${buildRsvpPath(yesParticipant, event)}`);
  const inviteCookie = getSessionCookie(inviteResponse);
  const response = await fetch(`${baseUrl}/e/${event.public_slug}`, {
    headers: { cookie: inviteCookie }
  });
  const body = await response.text();

  assert.equal(inviteResponse.status, 200);
  assert.equal(response.status, 200);
  assert.match(body, />1 Yes</);
  assert.match(body, />1 Maybe</);
  assert.match(body, />0 No</);
  assert.match(body, /Attendee names are hidden for this event/);
  assert.doesNotMatch(body, /Alice Example/);
  assert.doesNotMatch(body, /Bob Example/);
  assert.doesNotMatch(body, /Count me in\./);
  assert.doesNotMatch(body, /I need to confirm with my ride\./);
});

test('legacy participant-wide RSVP links are rejected', async () => {
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

test('legacy participant-wide RSVP links cannot open an event directly anymore', async () => {
  const participant = insertParticipant();
  const event = insertEvent({ event_date: '2026-04-15' });

  const response = await fetch(`${baseUrl}/rsvp/${participant.rsvp_token}/${event.id}`, {
    redirect: 'manual'
  });
  const body = await response.text();

  assert.equal(response.status, 410);
  assert.match(body, /out of date/i);
  assert.doesNotMatch(body, /Dunedin Community Center/);
});

test('RSVP and event pages send no-referrer headers and RSVP pages use no-referrer map embeds', async () => {
  const participant = insertParticipant();
  const event = insertEvent({
    title: 'Header Test Night',
    public_slug: 'header-test-night',
    location_address: '123 Main St\nDunedin, FL 34698',
    map_embed_url: buildLocationMapEmbedUrl('123 Main St\nDunedin, FL 34698'),
    map_link_url: buildLocationMapLinkUrl('123 Main St\nDunedin, FL 34698'),
    is_published: 1
  });

  const rsvpResponse = await fetch(`${baseUrl}${buildRsvpPath(participant, event)}`);
  const rsvpBody = await rsvpResponse.text();
  const inviteCookie = getSessionCookie(rsvpResponse);
  const eventResponse = await fetch(`${baseUrl}/e/${event.public_slug}`, {
    headers: { cookie: inviteCookie }
  });

  assert.equal(rsvpResponse.status, 200);
  assert.equal(rsvpResponse.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(rsvpResponse.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.match(rsvpBody, /referrerpolicy="no-referrer"/);
  assert.equal(eventResponse.status, 200);
  assert.equal(eventResponse.headers.get('referrer-policy'), 'no-referrer');
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

test('participant create route stores party member names for shared invites', async () => {
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/participants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      name: 'Pam & Charlie',
      email: 'pam.charlie@example.com',
      party_members: 'Pam, Charlie'
    }),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  assert.deepEqual(
    db.prepare('SELECT name, email, party_members FROM participants WHERE email = ?')
      .get('pam.charlie@example.com'),
    {
      name: 'Pam & Charlie',
      email: 'pam.charlie@example.com',
      party_members: '["Pam","Charlie"]'
    }
  );
});

test('admin preview route opens the selected participant RSVP page for an event', async () => {
  const participant = insertParticipant({
    name: 'Preview Person',
    email: 'preview@example.com',
    rsvp_token: 'preview-token'
  });
  const event = insertEvent({
    title: 'Preview Event',
    event_date: '2999-04-15'
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/event/${event.id}/preview?participantId=${participant.id}`, {
    headers: { cookie },
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), buildRsvpPath(participant, event));
});

test('admin preview route defaults to the first active participant when none is selected', async () => {
  const participant = insertParticipant({
    name: 'Preview Person',
    email: 'preview@example.com',
    rsvp_token: 'preview-token'
  });
  insertParticipant({
    name: 'Second Person',
    email: 'second@example.com',
    rsvp_token: 'second-token'
  });
  const event = insertEvent({
    title: 'Preview Event',
    event_date: '2999-04-15'
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/event/${event.id}/preview`, {
    headers: { cookie }
  });

  assert.equal(response.status, 200);
  assert.equal(response.url, `${baseUrl}${buildRsvpPath(participant, event)}`);
});

test('invite preview page shows the invitee view with the final send action', async () => {
  const participant = insertParticipant({
    name: 'Preview Person',
    email: 'preview@example.com',
    rsvp_token: 'preview-token'
  });
  insertParticipant({
    name: 'Second Person',
    email: 'second@example.com',
    rsvp_token: 'second-token'
  });
  const event = insertEvent({
    title: 'Workflow Event',
    event_date: '2999-04-15'
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/event/${event.id}/invite-preview?participantId=${participant.id}`, {
    headers: { cookie }
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Invite Preview/);
  assert.match(body, /Confirm and send RSVP to 2 invitees/);
  assert.ok(body.includes(`src="${buildRsvpPath(participant, event)}"`));
  assert.match(body, /Back to Edit Event/);
});

test('dashboard and edit modal point to the invite preview workflow', async () => {
  insertParticipant({
    name: 'Preview Person',
    email: 'preview@example.com',
    rsvp_token: 'preview-token'
  });
  const event = insertEvent({
    title: 'Workflow Event',
    event_date: '2999-04-15'
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/dashboard?eventId=${event.id}`, {
    headers: { cookie }
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Edit event/);
  assert.match(body, /href="\/admin\/event\/\d+\/invite-preview"/);
  assert.match(body, /name="next_action" value="preview"/);
  assert.match(body, />Invite Preview</);
  assert.doesNotMatch(body, /Confirm and send RSVP to 1 invitee/);
});

test('edit event preview action saves changes and redirects to invite preview', async () => {
  insertParticipant({
    name: 'Preview Person',
    email: 'preview@example.com',
    rsvp_token: 'preview-token'
  });
  const event = insertEvent({
    title: 'Original Event',
    event_date: '2999-04-15',
    location_name: 'Manatee Recreation Center'
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/event/${event.id}/update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      title: 'Updated Event',
      public_slug: '',
      event_date: '2999-04-15',
      location_id: '',
      location_name: 'Manatee Recreation Center',
      location_address: '',
      start_time: '18:00',
      end_time: '21:00',
      arrival_notes: 'Bring a snack.',
      next_action: 'preview'
    }),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `/admin/event/${event.id}/invite-preview`);

  const updatedEvent = db.prepare('SELECT title, arrival_notes FROM events WHERE id = ?').get(event.id);
  assert.deepEqual(updatedEvent, {
    title: 'Updated Event',
    arrival_notes: 'Bring a snack.'
  });
});

test('admin can send a single test invite without notifying the full roster', async () => {
  const participant = insertParticipant({
    name: 'Test Invite Person',
    email: 'real-roster@example.com',
    rsvp_token: 'test-invite-token'
  });
  const event = insertEvent({
    title: 'Test Invite Event',
    event_date: '2999-04-15'
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/event/${event.id}/test-invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      participant_id: String(participant.id),
      test_email: 'me@example.com'
    }),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `/admin/dashboard?eventId=${event.id}`);
  assert.equal(sentRsvpInvites.length, 1);
  assert.deepEqual(
    {
      id: sentRsvpInvites[0].participant.id,
      name: sentRsvpInvites[0].participant.name,
      email: sentRsvpInvites[0].participant.email,
      eventId: sentRsvpInvites[0].event.id
    },
    {
      id: participant.id,
      name: participant.name,
      email: 'me@example.com',
      eventId: event.id
    }
  );
});

test('dashboard shows the full roster even when no event is selected', async () => {
  insertParticipant({
    name: 'Alice Invitee',
    email: 'alice.invitee@example.com',
    rsvp_token: 'alice-invitee-token'
  });
  insertParticipant({
    name: 'Bob Invitee',
    email: 'bob.invitee@example.com',
    rsvp_token: 'bob-invitee-token'
  });
  insertParticipant({
    name: 'Inactive Invitee',
    email: 'inactive.invitee@example.com',
    rsvp_token: 'inactive-invitee-token',
    active: 0
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/dashboard`, {
    headers: { cookie }
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /href="\/admin\/roster"/);
  assert.match(body, /id="roster"/);
  assert.match(body, /Quick Actions/);
  assert.match(body, /Roster/);
  assert.match(body, /Locations/);
  assert.match(body, /Upcoming Schedule/);
  assert.match(body, /href="\/admin\/testing"/);
  assert.match(body, /Open Testing/);
  assert.match(body, /Everyone currently signed up to receive RSVP invitations\./);
  assert.match(body, /Manage Roster/);
  assert.match(body, /Add Member To Roster/);
  assert.match(body, /href="\/admin\/participants#add-member"/);
  assert.match(body, /<strong>2<\/strong>\s*active participants will receive event invites\./);
  assert.match(body, /Alice Invitee/);
  assert.match(body, /alice\.invitee@example\.com/);
  assert.match(body, /Bob Invitee/);
  assert.match(body, /bob\.invitee@example\.com/);
  assert.doesNotMatch(body, /Inactive Invitee/);
  assert.doesNotMatch(body, /inactive\.invitee@example\.com/);
});

test('dashboard can delete an event and return to the empty state', async () => {
  const participant = insertParticipant();
  const event = insertEvent({
    title: 'Temporary Test Event',
    public_slug: 'temporary-test-event',
    location_image: 'temporary-venue.png',
    map_image: 'temporary-map.png'
  });
  const venueImagePath = path.join(process.env.UPLOADS_DIR, event.location_image);
  const mapImagePath = path.join(process.env.UPLOADS_DIR, event.map_image);
  fs.writeFileSync(venueImagePath, 'temporary venue image');
  fs.writeFileSync(mapImagePath, 'temporary map image');
  insertResponse(participant.id, event.id, {
    status: 'yes',
    comment: 'I can make it.'
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/event/${event.id}/delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({}),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/dashboard');
  assert.equal(db.prepare('SELECT * FROM events WHERE id = ?').get(event.id), undefined);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM responses WHERE event_id = ?').get(event.id).count,
    0
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM event_public_slugs WHERE event_id = ?').get(event.id).count,
    0
  );
  assert.equal(fs.existsSync(venueImagePath), false);
  assert.equal(fs.existsSync(mapImagePath), false);

  const dashboardResponse = await fetch(`${baseUrl}/admin/dashboard`, {
    headers: { cookie }
  });
  const body = await dashboardResponse.text();

  assert.equal(dashboardResponse.status, 200);
  assert.match(body, /No events scheduled yet\./);
  assert.match(body, /Open Schedule/);
});

test('roster page shows the global invite list from the database', async () => {
  insertParticipant({
    name: 'Alice Invitee',
    email: 'alice.invitee@example.com',
    rsvp_token: 'alice-invitee-token'
  });
  insertParticipant({
    name: 'Bob Invitee',
    email: 'bob.invitee@example.com',
    rsvp_token: 'bob-invitee-token'
  });
  insertParticipant({
    name: 'Inactive Invitee',
    email: 'inactive.invitee@example.com',
    rsvp_token: 'inactive-invitee-token',
    active: 0
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/roster`, {
    headers: { cookie }
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Global Roster/);
  assert.match(body, /Everyone currently signed up to receive RSVP invitations\./);
  assert.match(body, /Manage Roster/);
  assert.match(body, /Add Member To Roster/);
  assert.match(body, /href="\/admin\/participants#add-member"/);
  assert.match(body, /<strong>2<\/strong>\s*active participants?\./);
  assert.match(body, /Alice Invitee/);
  assert.match(body, /alice\.invitee@example\.com/);
  assert.match(body, /Bob Invitee/);
  assert.match(body, /bob\.invitee@example\.com/);
  assert.doesNotMatch(body, /Inactive Invitee/);
  assert.doesNotMatch(body, /inactive\.invitee@example\.com/);
});

test('participants page exposes the add-member anchor for roster shortcuts', async () => {
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/participants`, {
    headers: { cookie }
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /id="add-member"/);
  assert.match(body, /Add Participant/);
});

test('testing workspace is available from admin and shows the end-to-end tools', async () => {
  const participant = insertParticipant({
    name: 'Testing Person',
    email: 'testing.person@example.com',
    rsvp_token: 'testing-person-token'
  });
  insertLocation({
    name: 'Testing Hall',
    address: '123 Main St\nDunedin, FL 34698'
  });
  insertEvent({
    title: 'Real Event Source',
    event_date: '2999-04-01',
    is_published: 1
  });
  const event = insertEvent({
    title: '[TEST] Testing Workspace Event',
    event_date: '2999-04-15',
    is_published: 1
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/testing?eventId=${event.id}&participantId=${participant.id}`, {
    headers: { cookie }
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /class="nav-link nav-active">Testing</);
  assert.match(body, /Testing Workspace/);
  assert.match(body, /Create Standalone \[TEST\] Event/);
  assert.match(body, /Clone From Real Event/);
  assert.match(body, /Open Invitee Preview/);
  assert.match(body, /Send One Test Invite/);
  assert.match(body, /Reset Responses For This \[TEST\] Event/);
});

test('testing workspace defaults to Mike Buckingham when he is on the active roster', async () => {
  insertParticipant({
    name: 'Alice Example',
    email: 'alice@example.com',
    rsvp_token: 'alice-example-token'
  });
  const mike = insertParticipant({
    name: 'Mike Buckingham',
    email: 'mikebuckingham@gmail.com',
    rsvp_token: 'mike-buckingham-token'
  });
  insertLocation({
    name: 'Testing Hall',
    address: '123 Main St\nDunedin, FL 34698'
  });
  const event = insertEvent({
    title: '[TEST] Testing Workspace Event',
    event_date: '2999-04-15',
    is_published: 1
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/testing?eventId=${event.id}`, {
    headers: { cookie }
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Selected participant[\s\S]*Mike Buckingham/);
  assert.match(
    body,
    new RegExp(`<option value="${mike.id}" selected>\\s*Mike Buckingham · mikebuckingham@gmail\\.com`)
  );
});

test('testing workspace can create a standalone test event without any real event records', async () => {
  const participant = insertParticipant({
    name: 'Standalone Creator',
    email: 'standalone.creator@example.com',
    rsvp_token: 'standalone-creator-token'
  });
  const location = insertLocation({
    name: 'Standalone Hall',
    address: '456 Sunset Ave\nDunedin, FL 34698'
  });
  const cookie = await signInAsAdmin();

  const pageResponse = await fetch(`${baseUrl}/admin/testing`, {
    headers: { cookie }
  });
  const pageBody = await pageResponse.text();

  assert.equal(pageResponse.status, 200);
  assert.match(pageBody, /Create Standalone \[TEST\] Event/);
  assert.match(pageBody, /This does <strong>not<\/strong> create a live event\./);
  assert.doesNotMatch(pageBody, /Create a regular event first/);

  const response = await fetch(`${baseUrl}/admin/testing/create-event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      location_id: String(location.id),
      participant_id: String(participant.id)
    }),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  const created = db.prepare(`
    SELECT title, public_slug, location_id, location_name, start_time, end_time, is_published, show_public_roster
    FROM events
    ORDER BY id DESC
    LIMIT 1
  `).get();

  assert.deepEqual(created, {
    title: '[TEST] Dunedin Euchre Night',
    public_slug: null,
    location_id: location.id,
    location_name: 'Standalone Hall',
    start_time: '18:00',
    end_time: '21:00',
    is_published: 1,
    show_public_roster: 1
  });
});

test('testing workspace can clone an event into a fresh test copy', async () => {
  const participant = insertParticipant({
    name: 'Clone Target',
    email: 'clone.target@example.com',
    rsvp_token: 'clone-target-token'
  });
  const sourceEvent = insertEvent({
    title: 'Spring Social',
    event_date: '2999-04-15',
    location_name: 'Harbor Hall',
    location_address: '123 Main St\nDunedin, FL 34698',
    start_time: '18:30',
    end_time: '21:30',
    arrival_notes: 'Use the side door.',
    notes: 'Use the side door.',
    is_published: 0,
    show_public_roster: 1
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/testing/create-event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      source_event_id: String(sourceEvent.id),
      participant_id: String(participant.id)
    }),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  const created = db.prepare(`
    SELECT title, public_slug, event_date, location_name, start_time, end_time, arrival_notes, is_published, show_public_roster
    FROM events
    WHERE id != ?
    ORDER BY id DESC
    LIMIT 1
  `).get(sourceEvent.id);

  assert.deepEqual(created, {
    title: '[TEST] Spring Social',
    public_slug: null,
    event_date: '2999-04-15',
    location_name: 'Harbor Hall',
    start_time: '18:30',
    end_time: '21:30',
    arrival_notes: 'Use the side door.',
    is_published: 1,
    show_public_roster: 1
  });

  const createdId = db.prepare(`
    SELECT id
    FROM events
    WHERE title = ?
    ORDER BY id DESC
    LIMIT 1
  `).get('[TEST] Spring Social').id;

  assert.equal(
    response.headers.get('location'),
    `/admin/testing?eventId=${createdId}&participantId=${participant.id}`
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM responses WHERE event_id = ?').get(createdId).count,
    0
  );
});

test('testing workspace can reset responses for a test event only', async () => {
  const participant = insertParticipant({
    name: 'Reset Person',
    email: 'reset.person@example.com',
    rsvp_token: 'reset-person-token'
  });
  const event = insertEvent({
    title: '[TEST] Resettable Event',
    event_date: '2999-04-15',
    is_published: 1
  });
  insertResponse(participant.id, event.id, {
    status: 'yes',
    attendee_names: '["Reset Person"]'
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/testing/reset-event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      event_id: String(event.id),
      participant_id: String(participant.id)
    }),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `/admin/testing?eventId=${event.id}&participantId=${participant.id}`);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM responses WHERE event_id = ?').get(event.id).count,
    0
  );
});

test('dashboard redirects test events back to the testing workspace', async () => {
  const event = insertEvent({
    title: '[TEST] Dashboard Redirect Event',
    event_date: '2999-04-15'
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/dashboard?eventId=${event.id}`, {
    headers: { cookie },
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `/admin/testing?eventId=${event.id}`);
});

test('events schedule hides test events from the normal admin workflow', async () => {
  insertEvent({
    title: 'Real Schedule Event',
    event_date: '2026-04-25'
  });
  insertEvent({
    title: '[TEST] Hidden Test Event',
    event_date: '2026-04-25'
  });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/events`, {
    headers: { cookie }
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Real Schedule Event/);
  assert.doesNotMatch(body, /\[TEST\] Hidden Test Event/);
});

test('admin event create and update routes persist slug settings and keep old slug links working after removal', async () => {
  const cookie = await signInAsAdmin();

  const createResponse = await fetch(`${baseUrl}/admin/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      title: 'Summer Social',
      public_slug: ' Summer Social 2026 ',
      event_date: '2026-06-20',
      location_name: 'Legion Hall',
      location_address: '456 Sunset Ave',
      start_time: '18:30',
      end_time: '21:30',
      arrival_notes: 'Use the side door.',
      is_published: '1',
      show_public_roster: '1'
    }),
    redirect: 'manual'
  });

  assert.equal(createResponse.status, 302);
  const created = db.prepare(`
    SELECT public_slug, show_public_roster
    FROM events
    WHERE title = ?
  `).get('Summer Social');

  assert.deepEqual(created, {
    public_slug: 'summer-social-2026',
    show_public_roster: 1
  });

  const eventId = db.prepare('SELECT id FROM events WHERE title = ?').get('Summer Social').id;
  const updateResponse = await fetch(`${baseUrl}/admin/event/${eventId}/update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      title: 'Summer Social',
      public_slug: '',
      event_date: '2026-06-20',
      location_name: 'Legion Hall',
      location_address: '456 Sunset Ave',
      start_time: '18:30',
      end_time: '21:30',
      arrival_notes: 'Use the side door.',
      is_published: '1'
    }),
    redirect: 'manual'
  });

  assert.equal(updateResponse.status, 302);
  const updated = db.prepare(`
    SELECT public_slug, show_public_roster
    FROM events
    WHERE id = ?
  `).get(eventId);

  assert.deepEqual(updated, {
    public_slug: null,
    show_public_roster: 0
  });

  const oldSlugResponse = await fetch(`${baseUrl}/e/summer-social-2026`, {
    headers: { cookie },
    redirect: 'manual'
  });
  const dashboardResponse = await fetch(`${baseUrl}/admin/dashboard?eventId=${eventId}`, {
    headers: { cookie }
  });
  const dashboardBody = await dashboardResponse.text();

  assert.equal(oldSlugResponse.status, 302);
  assert.equal(oldSlugResponse.headers.get('location'), `/event/${eventId}`);
  assert.equal(dashboardResponse.status, 200);
  assert.match(dashboardBody, /None active\. Using the event ID fallback URL\./);
  assert.match(dashboardBody, /Older event page URLs/);
  assert.match(dashboardBody, /http:\/\/127\.0\.0\.1\/e\/summer-social-2026/);
});

test('changing a slug keeps older public slug links working via redirect', async () => {
  const cookie = await signInAsAdmin();
  const event = insertEvent({
    title: 'Slug Redirect Event',
    public_slug: 'spring-social',
    is_published: 1,
    show_public_roster: 1
  });

  const updateResponse = await fetch(`${baseUrl}/admin/event/${event.id}/update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      title: event.title,
      public_slug: 'summer-social',
      event_date: event.event_date,
      location_name: event.location_name,
      location_address: event.location_address || '',
      start_time: event.start_time,
      end_time: event.end_time,
      arrival_notes: event.arrival_notes || '',
      is_published: '1',
      show_public_roster: '1'
    }),
    redirect: 'manual'
  });

  assert.equal(updateResponse.status, 302);

  const oldSlugResponse = await fetch(`${baseUrl}/e/spring-social`, {
    headers: { cookie },
    redirect: 'manual'
  });
  const currentSlugResponse = await fetch(`${baseUrl}/e/summer-social`, {
    headers: { cookie }
  });
  const dashboardResponse = await fetch(`${baseUrl}/admin/dashboard?eventId=${event.id}`, {
    headers: { cookie }
  });
  const dashboardBody = await dashboardResponse.text();

  assert.equal(oldSlugResponse.status, 302);
  assert.equal(oldSlugResponse.headers.get('location'), '/e/summer-social');
  assert.equal(currentSlugResponse.status, 200);
  assert.equal(dashboardResponse.status, 200);
  assert.match(dashboardBody, /<code>summer-social<\/code>/);
  assert.match(dashboardBody, /http:\/\/127\.0\.0\.1\/e\/spring-social/);
  assert.match(dashboardBody, /redirects to the current event page\./);
});

test('admin event routes reject duplicate public slugs, including older redirected ones', async () => {
  const existing = insertEvent({
    title: 'Existing Slug Event',
    public_slug: 'summer-social'
  });
  db.prepare(`
    INSERT INTO event_public_slugs (event_id, slug, is_current)
    VALUES (?, ?, 0)
  `).run(existing.id, 'spring-social');
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      title: 'Conflicting Event',
      public_slug: 'Spring Social',
      event_date: '2026-07-20',
      location_name: 'Harbor Hall',
      start_time: '18:00',
      end_time: '21:00'
    }),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  const eventCount = db.prepare('SELECT COUNT(*) AS count FROM events').get().count;
  assert.equal(eventCount, 1);
});

test('admin event slug handling transliterates unicode and rejects reserved route slugs', async () => {
  const cookie = await signInAsAdmin();

  const transliteratedResponse = await fetch(`${baseUrl}/admin/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      title: 'Cafe Social',
      public_slug: ' Café Social 2026 ',
      event_date: '2026-08-20',
      location_name: 'Harbor Hall',
      start_time: '18:00',
      end_time: '21:00'
    }),
    redirect: 'manual'
  });

  assert.equal(transliteratedResponse.status, 302);
  const transliterated = db.prepare(`
    SELECT public_slug
    FROM events
    WHERE title = ?
  `).get('Cafe Social');
  assert.deepEqual(transliterated, {
    public_slug: 'cafe-social-2026'
  });

  const reservedResponse = await fetch(`${baseUrl}/admin/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      title: 'Reserved Slug Event',
      public_slug: 'e',
      event_date: '2026-09-20',
      location_name: 'Harbor Hall',
      start_time: '18:00',
      end_time: '21:00'
    }),
    redirect: 'manual'
  });

  assert.equal(reservedResponse.status, 302);
  const rejectedCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM events
    WHERE title = ?
  `).get('Reserved Slug Event').count;
  assert.equal(rejectedCount, 0);
});

test('location manager saves reusable venues and gated event pages render the embedded map', async () => {
  const cookie = await signInAsAdmin();
  const createLocationResponse = await fetch(`${baseUrl}/admin/locations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      name: 'Harbor Hall',
      address: '123 Main St\nDunedin, FL 34698'
    }),
    redirect: 'manual'
  });

  assert.equal(createLocationResponse.status, 302);
  const location = db.prepare(`
    SELECT *
    FROM locations
    WHERE name = ?
  `).get('Harbor Hall');

  assert.equal(location.address, '123 Main St\nDunedin, FL 34698');
  assert.match(location.map_embed_url, /google\.com\/maps\?output=embed/);
  assert.match(location.map_link_url, /google\.com\/maps\/search/);

  const createEventResponse = await fetch(`${baseUrl}/admin/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      title: 'Harbor Hall Night',
      event_date: '2026-09-26',
      location_id: String(location.id),
      start_time: '18:00',
      end_time: '21:00',
      is_published: '1'
    }),
    redirect: 'manual'
  });

  assert.equal(createEventResponse.status, 302);
  const event = db.prepare(`
    SELECT id, location_id, location_name, location_address, map_embed_url, map_link_url
    FROM events
    WHERE title = ?
  `).get('Harbor Hall Night');

  assert.deepEqual(event, {
    id: event.id,
    location_id: location.id,
    location_name: 'Harbor Hall',
    location_address: '123 Main St\nDunedin, FL 34698',
    map_embed_url: location.map_embed_url,
    map_link_url: location.map_link_url
  });

  const eventPageResponse = await fetch(`${baseUrl}/event/${event.id}`, {
    headers: { cookie }
  });
  const body = await eventPageResponse.text();

  assert.equal(eventPageResponse.status, 200);
  assert.match(body, /Harbor Hall/);
  assert.match(body, /123 Main St/);
  assert.match(body, /Dunedin, FL 34698/);
  assert.match(body, /google\.com\/maps\?output=embed/);
  assert.match(body, /Open map/);
});

test('location manager page lists saved locations before the create form and keeps the form collapsed when venues exist', async () => {
  const cookie = await signInAsAdmin();
  insertLocation({
    name: 'Harbor Hall'
  });

  const response = await fetch(`${baseUrl}/admin/locations`, {
    headers: { cookie }
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.ok(body.indexOf('Saved Locations') < body.indexOf('Location Manager'));
  assert.match(body, /<button[^>]*data-location-form-toggle[^>]*>[\s]*Add Location[\s]*<\/button>/);
  assert.match(body, /<section[^>]*id="location-create-form-card"[^>]*hidden[^>]*>/);
  assert.match(body, /Harbor Hall/);
});

test('location manager update can remove an existing venue photo and delete the file', async () => {
  const cookie = await signInAsAdmin();
  const location = insertLocation({
    location_image: 'existing-location.png'
  });
  const locationPath = path.join(process.env.UPLOADS_DIR, location.location_image);

  fs.writeFileSync(locationPath, 'old location image');

  const response = await fetch(`${baseUrl}/admin/locations/${location.id}/update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      name: location.name,
      address: location.address,
      remove_location_image: '1'
    }),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  const updated = db.prepare(`
    SELECT location_image
    FROM locations
    WHERE id = ?
  `).get(location.id);

  assert.deepEqual(updated, {
    location_image: null
  });
  assert.equal(fs.existsSync(locationPath), false);
});

test('location manager update deletes replaced venue photos after a new upload succeeds', async () => {
  const cookie = await signInAsAdmin();
  const location = insertLocation({
    location_image: 'old-location.png'
  });
  const oldLocationPath = path.join(process.env.UPLOADS_DIR, location.location_image);
  fs.writeFileSync(oldLocationPath, 'old location image');

  const form = new FormData();
  form.set('name', location.name);
  form.set('address', location.address);
  form.set('location_image', new Blob(['new location image'], { type: 'image/png' }), 'new-location.png');

  const response = await fetch(`${baseUrl}/admin/locations/${location.id}/update`, {
    method: 'POST',
    headers: { cookie },
    body: form,
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  const updated = db.prepare(`
    SELECT location_image
    FROM locations
    WHERE id = ?
  `).get(location.id);

  assert.match(updated.location_image, /^location_image-/);
  assert.notEqual(updated.location_image, 'old-location.png');
  assert.equal(fs.existsSync(oldLocationPath), false);
  assert.equal(fs.existsSync(path.join(process.env.UPLOADS_DIR, updated.location_image)), true);
});

test('location manager delete removes an unused saved location and its photo file', async () => {
  const cookie = await signInAsAdmin();
  const location = insertLocation({
    name: 'Old Hall',
    location_image: 'old-hall.png'
  });
  const locationPath = path.join(process.env.UPLOADS_DIR, location.location_image);
  fs.writeFileSync(locationPath, 'old hall image');

  const response = await fetch(`${baseUrl}/admin/locations/${location.id}/delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({}),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/locations');
  const deleted = db.prepare('SELECT * FROM locations WHERE id = ?').get(location.id);
  assert.equal(deleted, undefined);
  assert.equal(fs.existsSync(locationPath), false);
});

test('location manager delete preserves event venue snapshots for locations already in use', async () => {
  const cookie = await signInAsAdmin();
  const location = insertLocation({
    name: 'Harbor Hall',
    location_image: 'harbor-hall.png'
  });
  const locationPath = path.join(process.env.UPLOADS_DIR, location.location_image);
  fs.writeFileSync(locationPath, 'harbor hall image');

  const event = insertEvent({
    location_id: location.id,
    location_name: location.name,
    location_address: location.address,
    location_image: location.location_image,
    map_embed_url: location.map_embed_url,
    map_link_url: location.map_link_url
  });

  const response = await fetch(`${baseUrl}/admin/locations/${location.id}/delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({}),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  const deleted = db.prepare('SELECT * FROM locations WHERE id = ?').get(location.id);
  assert.equal(deleted, undefined);

  const savedEvent = db.prepare(`
    SELECT location_id, location_name, location_address, location_image
    FROM events
    WHERE id = ?
  `).get(event.id);

  assert.deepEqual(savedEvent, {
    location_id: null,
    location_name: location.name,
    location_address: location.address,
    location_image: location.location_image
  });
  assert.equal(fs.existsSync(locationPath), true);
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
  assert.match(body, /<td style="[^"]*text-align:center;?">\s*—\s*<\/td>/);
});

test('events admin page shows the recurring schedule and recorded events', async () => {
  const event = insertEvent({
    title: 'Spring Euchre Social',
    event_date: '2026-02-28',
    location_name: 'Harbor Hall',
    is_published: 1
  });
  insertLocation({ name: 'Harbor Hall' });
  const cookie = await signInAsAdmin();

  const response = await fetch(`${baseUrl}/admin/events`, {
    headers: { cookie }
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Recurring Event Schedule/);
  assert.match(body, /4th Saturday/);
  assert.match(body, /Upcoming Schedule/);
  assert.match(body, /Past Event History/);
  assert.match(body, /Spring Euchre Social/);
  assert.match(body, new RegExp(`/admin/dashboard\\?eventId=${event.id}`));
  assert.match(body, /Create event/);
  assert.match(body, /scheduled-create-modal/);
  assert.match(body, /create-modal-2026-04-25/);
  assert.match(body, /Event Notes/);
  assert.doesNotMatch(body, /Create from dashboard/);
});

test('quick-create from the events schedule returns to the scheduled entry instead of the dashboard default', async () => {
  const cookie = await signInAsAdmin();
  const location = insertLocation({ name: 'Harbor Hall' });

  const response = await fetch(`${baseUrl}/admin/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie
    },
    body: new URLSearchParams({
      return_to: 'events',
      title: 'Dunedin Euchre Night',
      public_slug: '',
      event_date: '2026-04-25',
      location_id: String(location.id),
      start_time: '18:00',
      end_time: '21:00',
      arrival_notes: 'Use the side entrance.'
    }),
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/events#scheduled-2026-04-25');

  const event = db.prepare(`
    SELECT event_date, location_id, arrival_notes
    FROM events
    WHERE event_date = ?
  `).get('2026-04-25');

  assert.deepEqual(event, {
    event_date: '2026-04-25',
    location_id: location.id,
    arrival_notes: 'Use the side entrance.'
  });
});
