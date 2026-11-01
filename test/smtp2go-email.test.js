'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  sendEmail,
  __test__: {
    buildSmtp2goPayload,
    formatSmtp2goSender,
    isRetryableSmtp2goError,
    sendWithSmtp2go
  }
} = require('../services/email');

function apiResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function successResponse(data = {}) {
  return apiResponse({
    request_id: 'request-123',
    data: { succeeded: 1, failed: 0, email_id: 'smtp-email-123', ...data }
  });
}

test('SMTP2GO adapter maps the existing email payload and validates the send response', async () => {
  let request;
  const result = await sendWithSmtp2go({
    from: 'admin@dunedin-euchre.com',
    to: 'mike@example.com',
    subject: 'Admin sign-in link',
    html: '<p>Sign in</p>'
  }, {
    apiKey: 'api-test-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return successResponse();
    }
  });

  assert.equal(request.url, 'https://api.smtp2go.com/v3/email/send');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.equal(request.options.headers['X-Smtp2go-Api-Key'], 'api-test-key');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.options.body), {
    sender: 'Dunedin Euchre <admin@dunedin-euchre.com>',
    to: ['mike@example.com'],
    subject: 'Admin sign-in link',
    html_body: '<p>Sign in</p>'
  });
  assert.deepEqual(result.data, {
    succeeded: 1,
    failed: 0,
    email_id: 'smtp-email-123',
    id: 'smtp-email-123',
    emailId: 'smtp-email-123',
    scheduleId: null,
    requestId: 'request-123'
  });
});

test('SMTP2GO adapter preserves formatted senders and rejects provider-side scheduling', async () => {
  assert.equal(
    formatSmtp2goSender('Dunedin Club <admin@dunedin-euchre.com>'),
    'Dunedin Club <admin@dunedin-euchre.com>'
  );
  assert.equal(
    formatSmtp2goSender('Do_Not_Reply@dunedin-euchre.com'),
    'Dunedin Euchre No Reply <Do_Not_Reply@dunedin-euchre.com>'
  );

  let calls = 0;
  await assert.rejects(
    sendWithSmtp2go({
      from: 'Do_Not_Reply@dunedin-euchre.com',
      to: ['alice@example.com', 'bob@example.com'],
      subject: 'Scheduled reminder',
      html: '<p>Reminder</p>',
      scheduledAt: '2026-11-02T17:00:00.000Z'
    }, {
      apiKey: 'api-test-key',
      fetchImpl: async () => {
        calls += 1;
        return successResponse();
      }
    }),
    /Queue email in SQLite/
  );
  assert.equal(calls, 0);
});

test('SMTP2GO adapter maps optional supported fields and accepts text-only email payloads', () => {
  assert.deepEqual(buildSmtp2goPayload({
    from: 'Dunedin Club <admin@dunedin-euchre.com>',
    to: ['alice@example.com', '', 'bob@example.com'],
    subject: 'Plain text',
    text: 'Hello',
    cc: ['copy@example.com'],
    custom_headers: [{ header: 'Reply-To', value: 'admin@dunedin-euchre.com' }]
  }), {
    sender: 'Dunedin Club <admin@dunedin-euchre.com>',
    to: ['alice@example.com', 'bob@example.com'],
    subject: 'Plain text',
    text_body: 'Hello',
    cc: ['copy@example.com'],
    custom_headers: [{ header: 'Reply-To', value: 'admin@dunedin-euchre.com' }]
  });
});

test('SMTP2GO adapter fails before network access when configuration or recipients are missing', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return successResponse();
  };

  await assert.rejects(
    sendWithSmtp2go({ from: 'admin@dunedin-euchre.com', to: 'mike@example.com' }, { fetchImpl }),
    error => error.name === 'smtp2go_configuration_error'
      && error.message === 'Missing SMTP2GO_API_KEY.'
  );

  await assert.rejects(
    sendWithSmtp2go({ from: 'admin@dunedin-euchre.com', to: [] }, {
      apiKey: 'api-test-key',
      fetchImpl
    }),
    /At least one email recipient is required/
  );

  assert.equal(calls, 0);
});

test('SMTP2GO adapter reports HTTP errors and non-retryable partial send failures', async () => {
  await assert.rejects(
    sendWithSmtp2go({ from: 'admin@dunedin-euchre.com', to: 'mike@example.com' }, {
      apiKey: 'api-test-key',
      fetchImpl: async () => apiResponse({
        request_id: 'request-unauthorized',
        data: { error_code: 'INVALID_API_KEY', error: 'API key rejected.' }
      }, 401)
    }),
    error => error.name === 'INVALID_API_KEY'
      && error.statusCode === 401
      && error.message === 'API key rejected.'
      && isRetryableSmtp2goError(error) === false
  );

  await assert.rejects(
    sendWithSmtp2go({ from: 'admin@dunedin-euchre.com', to: 'mike@example.com' }, {
      apiKey: 'api-test-key',
      fetchImpl: async () => apiResponse({
        request_id: 'request-failed',
        data: {
          succeeded: 0,
          failed: 1,
          failures: [{ error: 'Sender is not authorized.' }]
        }
      })
    }),
    error => error.name === 'smtp2go_send_error'
      && error.statusCode === 422
      && error.message === 'Sender is not authorized.'
      && isRetryableSmtp2goError(error) === false
  );
});

test('SMTP2GO adapter rejects malformed success responses and invalid JSON', async () => {
  await assert.rejects(
    sendWithSmtp2go({ from: 'admin@dunedin-euchre.com', to: 'mike@example.com' }, {
      apiKey: 'api-test-key',
      fetchImpl: async () => apiResponse({ request_id: 'missing-data' })
    }),
    /without a data object/
  );

  await assert.rejects(
    sendWithSmtp2go({ from: 'admin@dunedin-euchre.com', to: 'mike@example.com' }, {
      apiKey: 'api-test-key',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('invalid JSON'); }
      })
    }),
    /not valid JSON/
  );

  await assert.rejects(
    sendWithSmtp2go({ from: 'admin@dunedin-euchre.com', to: 'mike@example.com' }, {
      apiKey: 'api-test-key',
      fetchImpl: async () => apiResponse({
        request_id: 'missing-email-id',
        data: { succeeded: 1, failed: 0 }
      })
    }),
    /without returning an email_id/
  );

});

test('SMTP2GO adapter retries explicit rate limits but does not retry ambiguous server errors', async () => {
  const sleeps = [];
  let calls = 0;
  await assert.rejects(sendEmail({
    from: 'admin@dunedin-euchre.com',
    to: 'mike@example.com',
    subject: 'Retry test',
    html: '<p>Retry</p>'
  }, {
    provider: 'smtp2go',
    apiKey: 'api-test-key',
    maxRetries: 3,
    retryDelayMs: 250,
    sleep: async ms => sleeps.push(ms),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return apiResponse({ data: { error_code: 'RATE_LIMITED', error: 'Slow down.' } }, 429);
      }
      if (calls === 2) {
        return apiResponse({ data: { error_code: 'TEMPORARY_FAILURE', error: 'Try again.' } }, 503);
      }
      return successResponse();
    }
  }), error => error.statusCode === 503 && error.ambiguous === true);

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [250]);
});

test('SMTP2GO adapter does not retry ambiguous transport errors and stops permanent API errors', async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(sendEmail({
    from: 'admin@dunedin-euchre.com',
    to: 'mike@example.com',
    subject: 'Transport test',
    html: '<p>Retry</p>'
  }, {
    provider: 'smtp2go',
    apiKey: 'api-test-key',
    maxRetries: 3,
    retryDelayMs: 100,
    sleep: async ms => sleeps.push(ms),
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('Temporary network failure.');
    }
  }), error => error.name === 'TypeError' && error.ambiguous === true);

  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);

  calls = 0;
  await assert.rejects(
    sendEmail({
      from: 'admin@dunedin-euchre.com',
      to: 'mike@example.com',
      subject: 'Permanent error',
      html: '<p>Do not retry</p>'
    }, {
      provider: 'smtp2go',
      apiKey: 'api-test-key',
      maxRetries: 3,
      fetchImpl: async () => {
        calls += 1;
        return apiResponse({ data: { error_code: 'INVALID_TO', error: 'Invalid recipient.' } }, 400);
      }
    }),
    error => error.name === 'INVALID_TO' && error.statusCode === 400
  );
  assert.equal(calls, 1);
});

test('sendEmail always uses the SMTP2GO adapter', async () => {
  let requestCount = 0;
  const result = await sendEmail({
    from: 'admin@dunedin-euchre.com',
    to: 'mike@example.com',
    subject: 'SMTP2GO only',
    html: '<p>Configured</p>'
  }, {
    apiKey: 'api-test-key',
    fetchImpl: async () => {
      requestCount += 1;
      return successResponse();
    }
  });

  assert.equal(requestCount, 1);
  assert.equal(result.id, 'smtp-email-123');
});
