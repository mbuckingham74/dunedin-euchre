'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_key';

const {
  __test__: { sendEmail }
} = require('../services/email');

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
