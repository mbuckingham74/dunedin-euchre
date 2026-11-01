'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dunedin-reminders-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

const db = require('../db/database');
const {
  buildReminderSubject,
  getDefaultReminderSchedule,
  __test__: { getEligibleReminderRecipients },
  processScheduledReminders,
  scheduleEventReminder
} = require('../services/reminders');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('getDefaultReminderSchedule targets 9am Eastern on the day before a spring event', () => {
  const schedule = getDefaultReminderSchedule({
    event_date: '2026-04-25'
  });

  assert.equal(schedule.reminderDateKey, '2026-04-24');
  assert.equal(schedule.scheduledAt, '2026-04-24T13:00:00.000Z');
});

test('getDefaultReminderSchedule targets 9am Eastern on the day before a winter event', () => {
  const schedule = getDefaultReminderSchedule({
    event_date: '2026-12-26'
  });

  assert.equal(schedule.reminderDateKey, '2026-12-25');
  assert.equal(schedule.scheduledAt, '2026-12-25T14:00:00.000Z');
});

test('buildReminderSubject falls back to the event title', () => {
  assert.equal(
    buildReminderSubject({
      title: 'Dunedin Euchre Night'
    }),
    'Reminder and Last Call for Dunedin Euchre Night'
  );
});

test('scheduled reminders stay in SQLite beyond SMTP2GO provider scheduling limits', async () => {
  const event = createEvent('Long Horizon Event', '2026-11-20');
  const participant = createParticipant('long-horizon@example.com');
  const scheduledAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const delivery = {
    statuses: [{ participant, emailId: 'invite-message-1', group: 'delivered' }]
  };

  const result = await scheduleEventReminder(event, [participant], {
    scheduledAt,
    delivery
  });

  const queued = db.prepare(`
    SELECT status, send_at, email_provider, provider_message_id
    FROM scheduled_reminders
    WHERE event_id = ? AND participant_id = ?
  `).get(event.id, participant.id);
  assert.equal(result.recipients.length, 1);
  assert.deepEqual(queued, {
    status: 'pending',
    send_at: scheduledAt,
    email_provider: null,
    provider_message_id: null
  });
});

test('reminder recipient selection excludes delivery issues unless explicitly included', () => {
  const accepted = { id: 1, email: 'accepted@example.com' };
  const issue = { id: 2, email: 'issue@example.com' };
  const missing = { id: 3, email: 'missing@example.com' };
  const delivery = {
    statuses: [
      { participant: accepted, emailId: 'invite-1', group: 'delivered' },
      { participant: issue, emailId: 'invite-2', group: 'issue' },
      { participant: missing, emailId: null, group: 'missing' }
    ]
  };

  assert.deepEqual(getEligibleReminderRecipients(delivery), [accepted]);
  assert.deepEqual(getEligibleReminderRecipients(delivery, { includeIssue: true }), [accepted, issue]);
});

test('SQLite reminder worker sends due reminders through the injected SMTP2GO sender and records IDs', async () => {
  const event = createEvent('Due Reminder Event', '2026-11-20');
  const participant = createParticipant('due-reminder@example.com');
  db.prepare(`
    INSERT INTO scheduled_reminders (event_id, participant_id, kind, send_at, subject)
    VALUES (?, ?, 'day_before_9am_pacific', ?, 'Test reminder')
  `).run(event.id, participant.id, new Date(Date.now() - 1000).toISOString());
  let sendCount = 0;

  await processScheduledReminders({
    sendReminder: async (sentParticipant, sentEvent, options) => {
      sendCount += 1;
      assert.equal(sentParticipant.id, participant.id);
      assert.equal(sentEvent.id, event.id);
      assert.equal(options.subject, 'Test reminder');
      return { id: 'smtp-reminder-1', deliveryKey: 'delivery-key-1' };
    }
  });

  const sent = db.prepare(`
    SELECT status, email_provider, provider_message_id, provider_delivery_status, delivery_key
    FROM scheduled_reminders
    WHERE event_id = ? AND participant_id = ?
  `).get(event.id, participant.id);
  assert.equal(sendCount, 1);
  assert.deepEqual(sent, {
    status: 'sent',
    email_provider: 'smtp2go',
    provider_message_id: 'smtp-reminder-1',
    provider_delivery_status: 'accepted',
    delivery_key: 'delivery-key-1'
  });
});

function createEvent(title, eventDate) {
  const result = db.prepare(`
    INSERT INTO events (title, event_date, location_name, start_time, end_time)
    VALUES (?, ?, 'Test Hall', '18:00', '20:00')
  `).run(title, eventDate);
  return { id: Number(result.lastInsertRowid), title, event_date: eventDate };
}

function createParticipant(email) {
  const result = db.prepare(`
    INSERT INTO participants (name, email, rsvp_token, active)
    VALUES ('Reminder Test', ?, ?, 1)
  `).run(email, `reminder-token-${email}`);
  return { id: Number(result.lastInsertRowid), name: 'Reminder Test', email };
}
