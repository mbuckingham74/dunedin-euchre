'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_key';

const {
  buildRsvpReminderEmail,
  __test__: { sendEmail }
} = require('../services/email');
const { buildRsvpUrl } = require('../services/links');

test('sendEmail retries rate-limited responses and eventually succeeds', async () => {
  let attempts = 0;
  const sleeps = [];

  const result = await sendEmail(
    { subject: 'RSVP invite' },
    {
      maxRetries: 3,
      send: async () => {
        attempts += 1;

        if (attempts < 3) {
          return {
            data: null,
            error: {
              name: 'rate_limit_exceeded',
              message: 'Too many requests.',
              statusCode: 429
            }
          };
        }

        return {
          data: { id: 'email_123' },
          error: null
        };
      },
      sleep: async ms => {
        sleeps.push(ms);
      }
    }
  );

  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.deepEqual(result, { id: 'email_123' });
});

test('sendEmail throws non-retryable Resend API errors', async () => {
  let attempts = 0;

  await assert.rejects(
    sendEmail(
      { subject: 'RSVP invite' },
      {
        maxRetries: 3,
        send: async () => {
          attempts += 1;
          return {
            data: null,
            error: {
              name: 'invalid_parameter',
              message: 'Invalid `to` field.',
              statusCode: 400
            }
          };
        }
      }
    ),
    error => {
      assert.equal(error.name, 'invalid_parameter');
      assert.equal(error.message, 'Invalid `to` field.');
      assert.equal(error.statusCode, 400);
      return true;
    }
  );

  assert.equal(attempts, 1);
});

test('sendEmail retries transient transport errors thrown by the client', async () => {
  let attempts = 0;
  const sleeps = [];

  const result = await sendEmail(
    { subject: 'RSVP invite' },
    {
      maxRetries: 2,
      send: async () => {
        attempts += 1;

        if (attempts === 1) {
          const error = new Error('Unable to fetch data. The request could not be resolved.');
          error.name = 'application_error';
          throw error;
        }

        return {
          data: { id: 'email_456' },
          error: null
        };
      },
      sleep: async ms => {
        sleeps.push(ms);
      }
    }
  );

  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(result, { id: 'email_456' });
});

test('buildRsvpReminderEmail uses the provided subject and includes the event RSVP link', () => {
  const participant = {
    id: 47,
    name: 'Mike Buckingham',
    email: 'mikebuckingham@gmail.com'
  };
  const event = {
    id: 4,
    title: 'Dunedin Euchre Night 4/25',
    event_date: '2026-04-25',
    location_name: 'Manatee Recreation Center',
    location_address: '1512 Hillborough Trail\nThe Villages, FL 32163',
    start_time: '18:00',
    end_time: '20:30',
    arrival_notes: 'Please RSVP before noon.'
  };

  const reminder = buildRsvpReminderEmail(participant, event, {
    subject: 'Reminder and Last Call for Dunedin Euchre Night 4/25'
  });
  const expectedLink = buildRsvpUrl('https://dunedin-euchre.com', participant, event);

  assert.equal(reminder.subject, 'Reminder and Last Call for Dunedin Euchre Night 4/25');
  assert.match(reminder.html, /Reminder and Last Call/);
  assert.match(reminder.html, /Please RSVP before noon\./);
  assert.match(reminder.html, new RegExp(expectedLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
