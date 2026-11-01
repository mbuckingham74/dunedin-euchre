'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dunedin-reminder-cli-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

const db = require('../db/database');
const { getReminderRecipients, parseArgs } = require('../scripts/schedule-reminder-email');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('reminder CLI parses a future SQLite schedule and dry-run defaults', () => {
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const options = parseArgs(['--event-id', '42', '--scheduled-at', scheduledAt]);

  assert.equal(options.eventId, 42);
  assert.equal(options.scheduledAt, scheduledAt);
  assert.equal(options.confirm, false);
});

test('reminder CLI recipient selection preserves invite-ID and issue-status rules', () => {
  const included = { id: 1, email: 'included@example.com' };
  const issue = { id: 2, email: 'issue@example.com' };
  const noInvite = { id: 3, email: 'missing@example.com' };
  const statuses = [
    { participant: included, emailId: 'smtp2go-id', group: 'delivered' },
    { participant: issue, emailId: 'smtp2go-id-2', group: 'issue' },
    { participant: noInvite, emailId: null, group: 'missing' }
  ];

  assert.deepEqual(getReminderRecipients(statuses, { includeIssue: false }), [included]);
  assert.deepEqual(getReminderRecipients(statuses, { includeIssue: true }), [included, issue]);
});

test('reminder CLI accepts long horizons for SQLite scheduling', () => {
  const scheduledAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const options = parseArgs(['--event-id', '42', '--scheduled-at', scheduledAt]);
  assert.equal(options.scheduledAt, scheduledAt);
});
