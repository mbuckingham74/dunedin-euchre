'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_key';

const {
  buildRsvpInviteEmail,
  buildRsvpReminderEmail,
  buildRsvpSummaryEmail,
  FROM,
  REMINDER_DEADLINE_NOTICE,
  ROSTER_EMAIL_NOTICE,
  ROSTER_FROM,
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

test('buildRsvpReminderEmail places the bold red RSVP deadline notice first', () => {
  const reminder = buildRsvpReminderEmail(
    { id: 47, name: 'Mike Buckingham', email: 'mikebuckingham@gmail.com' },
    {
      id: 4,
      title: 'Dunedin Euchre Night 4/25',
      event_date: '2026-04-25',
      location_name: 'Manatee Recreation Center',
      start_time: '18:00',
      end_time: '20:30'
    }
  );

  assert.match(reminder.html, /color: #dc2626/);
  assert.match(reminder.html, /font-weight: 700/);
  assert.match(reminder.html, new RegExp(REMINDER_DEADLINE_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(reminder.html.indexOf(REMINDER_DEADLINE_NOTICE) < reminder.html.indexOf(ROSTER_EMAIL_NOTICE));
});

test('roster emails use the no-reply sender and place the no-reply notice first', () => {
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
    start_time: '18:00',
    end_time: '20:30'
  };

  const invite = buildRsvpInviteEmail(participant, event);
  const reminder = buildRsvpReminderEmail(participant, event);

  assert.equal(ROSTER_FROM, process.env.ROSTER_FROM_EMAIL || 'Do_Not_Reply@dunedin-euchre.com');
  for (const email of [invite, reminder]) {
    assert.match(email.html, new RegExp(ROSTER_EMAIL_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(email.html.indexOf(ROSTER_EMAIL_NOTICE) < email.html.indexOf('<h2'));
    const noticeIndex = email.html.indexOf(ROSTER_EMAIL_NOTICE);
    const noticeStart = email.html.lastIndexOf('<p ', noticeIndex);
    const noticeEnd = email.html.indexOf('</p>', noticeIndex);
    const noticeMarkup = email.html.slice(noticeStart, noticeEnd);
    assert.match(noticeMarkup, /color: #dc2626/);
    assert.doesNotMatch(noticeMarkup, /font-weight|<strong>/);
  }
  assert.doesNotMatch(ROSTER_EMAIL_NOTICE, /555-1212/);
});

test('buildRsvpSummaryEmail renders readable coming and declined tables', () => {
  const summary = buildRsvpSummaryEmail(
    {
      title: 'Dunedin Euchre Night',
      event_date: '2026-04-25',
      location_name: 'Manatee Recreation Center',
      start_time: '18:00'
    },
    [
      {
        attendeeNames: ['Alice Example'],
        declinedNames: ['Bob Example'],
        maybeNames: [],
        pendingNames: [],
        comment: 'Bringing cards'
      },
      {
        attendeeNames: ['<Casey>'],
        declinedNames: [],
        maybeNames: [],
        pendingNames: [],
        comment: '<script>alert(1)</script>'
      },
      {
        attendeeNames: [],
        declinedNames: ['Dana Example'],
        maybeNames: ['Morgan Example'],
        pendingNames: ['Pat Example'],
        comment: ''
      }
    ]
  );

  assert.equal(summary.subject, 'RSVP list for Dunedin Euchre Night');
  assert.match(summary.html, /Coming \(2\)/);
  assert.match(summary.html, /Declined \(2\)/);
  assert.match(summary.html, /Alice Example/);
  assert.match(summary.html, /Bob Example/);
  assert.match(summary.html, /&lt;Casey&gt;/);
  assert.match(summary.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(summary.html, /<script>/);
  assert.match(summary.html, /<strong>1<\/strong> maybe/);
  assert.match(summary.html, /<strong>1<\/strong> with no response/);
  assert.equal(FROM, process.env.FROM_EMAIL || 'admin@dunedin-euchre.com');
});
