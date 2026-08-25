'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_key';

const {
  buildReminderSubject,
  getDefaultReminderSchedule
} = require('../services/reminders');

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
