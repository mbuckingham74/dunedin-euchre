'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dunedin-euchre-summary-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || `re_${crypto.randomBytes(24).toString('hex')}`;
process.env.ADMIN_EMAIL = 'mom@example.com,admin@example.com';
process.env.EVENT_RSVP_SUMMARY_TIMEZONE = 'America/New_York';

const db = require('../db/database');
const {
  SUMMARY_RECIPIENT_EMAIL,
  getDefaultRsvpSummarySchedule,
  processScheduledRsvpSummaries
} = require('../services/rsvp-summary');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('RSVP summaries target 4pm Eastern across daylight-saving changes', () => {
  const spring = getDefaultRsvpSummarySchedule({ event_date: '2026-04-25' });
  const winter = getDefaultRsvpSummarySchedule({ event_date: '2026-12-26' });

  assert.equal(spring.scheduledAt, '2026-04-25T20:00:00.000Z');
  assert.equal(winter.scheduledAt, '2026-12-26T21:00:00.000Z');
  assert.equal(spring.timeZone, 'America/New_York');
  assert.equal(SUMMARY_RECIPIENT_EMAIL, 'mom@example.com');
});

test('the event-day worker sends the current roster once and records the Resend id', async () => {
  const eventResult = db.prepare(`
    INSERT INTO events (title, event_date, location_name, start_time, end_time, is_published)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run('April Euchre', '2026-04-25', 'Manatee Recreation Center', '18:00', '20:30');
  const eventId = Number(eventResult.lastInsertRowid);

  const aliceParty = db.prepare(`
    INSERT INTO participants (name, email, rsvp_token, party_members)
    VALUES (?, ?, ?, ?)
  `).run(
    'Alice and Bob Example',
    'alice@example.com',
    'alice-token',
    JSON.stringify(['Alice Example', 'Bob Example'])
  );
  const carolParty = db.prepare(`
    INSERT INTO participants (name, email, rsvp_token, party_members)
    VALUES (?, ?, ?, ?)
  `).run(
    'Carol Example',
    'carol@example.com',
    'carol-token',
    JSON.stringify(['Carol Example'])
  );

  db.prepare(`
    INSERT INTO responses (participant_id, event_id, status, comment, attendee_names)
    VALUES (?, ?, 'yes', ?, ?)
  `).run(
    aliceParty.lastInsertRowid,
    eventId,
    'Alice is attending',
    JSON.stringify(['Alice Example'])
  );
  db.prepare(`
    INSERT INTO responses (participant_id, event_id, status, comment, attendee_names)
    VALUES (?, ?, 'no', ?, NULL)
  `).run(carolParty.lastInsertRowid, eventId, 'Out of town');

  const sends = [];
  const sendSummary = async (recipientEmail, event, roster, options) => {
    sends.push({ recipientEmail, event, roster, options });
    return { id: 'resend-summary-123' };
  };
  const processingOptions = {
    recipientEmail: 'mom@example.com',
    timeZone: 'America/New_York',
    referenceDate: new Date('2026-04-25T20:00:00.000Z'),
    sendSummary
  };

  await processScheduledRsvpSummaries(processingOptions);
  await processScheduledRsvpSummaries(processingOptions);

  assert.equal(sends.length, 1);
  assert.equal(sends[0].recipientEmail, 'mom@example.com');
  assert.deepEqual(sends[0].roster[0].attendeeNames, ['Alice Example']);
  assert.deepEqual(sends[0].roster[0].declinedNames, ['Bob Example']);
  assert.deepEqual(sends[0].roster[1].declinedNames, ['Carol Example']);

  const delivery = db.prepare(`
    SELECT status, recipient_email, resend_email_id, send_at
    FROM scheduled_rsvp_summaries
    WHERE event_id = ?
  `).get(eventId);
  assert.deepEqual(delivery, {
    status: 'sent',
    recipient_email: 'mom@example.com',
    resend_email_id: 'resend-summary-123',
    send_at: '2026-04-25T20:00:00.000Z'
  });
});

test('test events never create an RSVP summary delivery', async () => {
  db.prepare(`
    INSERT INTO events (title, event_date, location_name, start_time, end_time, is_published)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run('[TEST] April Euchre', '2026-04-25', 'Test Venue', '18:00', '20:30');

  await processScheduledRsvpSummaries({
    recipientEmail: 'mom@example.com',
    timeZone: 'America/New_York',
    referenceDate: new Date('2026-04-25T20:00:00.000Z'),
    sendSummary: async () => {
      throw new Error('A test event should not send an RSVP summary.');
    }
  });

  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM scheduled_rsvp_summaries s
    JOIN events e ON e.id = s.event_id
    WHERE e.title LIKE '[TEST]%'
  `).get().count;
  assert.equal(count, 0);
});
