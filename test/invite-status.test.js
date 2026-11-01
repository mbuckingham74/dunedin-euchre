'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dunedin-invite-status-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

const db = require('../db/database');
const { createDeliveryAttempt, markDeliveryAccepted } = require('../services/email-delivery-history');
const {
  formatInviteDeliveryLabel,
  getEventInviteDeliveryStatus
} = require('../services/invite-status');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createInviteRecord(participant, event, messageId, purpose = 'invitation') {
  const attempt = createDeliveryAttempt({
    purpose,
    eventId: event.id,
    participantId: participant.id,
    recipientEmail: participant.email,
    subject: 'Dunedin Euchre – RSVP for Dunedin Euchre Night'
  });
  markDeliveryAccepted(attempt.deliveryKey, {
    providerMessageId: messageId,
    sentAt: '2026-04-22T23:41:49.000Z'
  });
  return attempt.deliveryKey;
}

test('invite status uses SQLite message IDs and refreshes matching SMTP2GO activity', async () => {
  const participant = { id: 66, name: 'Alice Example', email: 'alice@example.com' };
  const event = { id: 4, title: 'Dunedin Euchre Night' };
  createInviteRecord(participant, event, 'smtp-invite-66');
  createInviteRecord(participant, { id: 3 }, 'smtp-wrong-event');

  let queryCount = 0;
  const delivery = await getEventInviteDeliveryStatus([participant], event, {
    apiKey: 'smtp-test-key',
    searchActivity: async filters => {
      queryCount += 1;
      assert.equal(filters.search_subject, 'Dunedin Euchre – RSVP for Dunedin Euchre Night');
      assert.equal(filters.search_sender, 'Do_Not_Reply@dunedin-euchre.com');
      assert.deepEqual(filters.custom_headers, ['X-Dunedin-Delivery-ID']);
      return {
        events: [
          {
            email_id: 'smtp-invite-66',
            event: 'delivered',
            date: '2026-04-23T01:00:00.000Z',
            recipient: 'alice@example.com'
          },
          {
            email_id: 'smtp-wrong-event',
            event: 'hard-bounced',
            recipient: 'alice@example.com'
          }
        ],
        continue_token: null
      };
    }
  });

  assert.equal(queryCount, 1);
  assert.equal(delivery.available, true);
  assert.deepEqual(delivery.summary, { delivered: 1, pending: 0, issue: 0, missing: 0 });
  assert.equal(delivery.statuses[0].emailId, 'smtp-invite-66');
  assert.equal(delivery.statuses[0].group, 'delivered');
  assert.equal(delivery.statuses[0].label, 'Delivered');
  assert.equal(delivery.statuses[0].sentAt, '2026-04-22T23:41:49.000Z');
});

test('ambiguous invitation sends remain visible and do not appear missing', async () => {
  const participant = { id: 52, name: 'Carol Example', email: 'carol@example.com' };
  const event = { id: 6, title: 'June Euchre' };
  const attempt = createDeliveryAttempt({
    purpose: 'invitation',
    eventId: event.id,
    participantId: participant.id,
    recipientEmail: participant.email,
    subject: 'Dunedin Euchre – RSVP for June Euchre'
  });
  const ambiguous = new Error('Connection closed before response.');
  ambiguous.ambiguous = true;
  db.prepare(`
    UPDATE email_delivery_history
    SET delivery_status = 'ambiguous', last_error = ?
    WHERE delivery_key = ?
  `).run(ambiguous.message, attempt.deliveryKey);

  const delivery = await getEventInviteDeliveryStatus([participant], event, {
    apiKey: 'smtp-test-key',
    searchActivity: async () => ({ events: [], continue_token: null })
  });

  assert.equal(delivery.summary.pending, 1);
  assert.equal(delivery.summary.missing, 0);
  assert.equal(delivery.statuses[0].emailId, null);
  assert.equal(delivery.statuses[0].label, 'Delivery Unknown');
});

test('cached delivery status remains visible when SMTP2GO activity is temporarily unavailable', async () => {
  const participant = { id: 58, name: 'Jamie Example', email: 'jamie@example.com' };
  const event = { id: 7, title: 'July Euchre' };
  createInviteRecord(participant, event, 'smtp-cached');

  const delivery = await getEventInviteDeliveryStatus([participant], event, {
    apiKey: 'smtp-test-key',
    searchActivity: async () => { throw new Error('SMTP2GO activity unavailable.'); }
  });

  assert.equal(delivery.available, true);
  assert.equal(delivery.error, 'SMTP2GO activity unavailable.');
  assert.equal(delivery.statuses[0].emailId, 'smtp-cached');
  assert.equal(delivery.statuses[0].label, 'Accepted');
});

test('invite status marks participants missing without a stored invitation', async () => {
  const participant = { id: 61, name: 'Taylor Example', email: 'taylor@example.com' };
  const delivery = await getEventInviteDeliveryStatus([participant], { id: 8 });

  assert.deepEqual(delivery.summary, { delivered: 0, pending: 0, issue: 0, missing: 1 });
  assert.equal(delivery.statuses[0].group, 'missing');
  assert.equal(delivery.statuses[0].sentAt, null);
});

test('formatInviteDeliveryLabel formats events and unresolved sends for display', () => {
  assert.equal(formatInviteDeliveryLabel('delivered', true), 'Delivered');
  assert.equal(formatInviteDeliveryLabel('hard-bounced', true), 'Hard Bounced');
  assert.equal(formatInviteDeliveryLabel(null, true, 'ambiguous'), 'Delivery Unknown');
  assert.equal(formatInviteDeliveryLabel(null, false), 'Missing');
});
