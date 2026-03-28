'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { ensureParticipantEmailUniqueIndex, runMigrations } = require('../db/migrations');
const { importParticipants, parseContactsCsv } = require('../scripts/import-participants-csv');

function createTestDatabase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dunedin-euchre-import-'));
  const db = new Database(path.join(tempDir, 'test.db'));

  db.pragma('foreign_keys = ON');
  runMigrations(db);
  ensureParticipantEmailUniqueIndex(db);

  return { db, tempDir };
}

test('importParticipants inserts new rows, reactivates inactive rows, and skips active matches', () => {
  const { db, tempDir } = createTestDatabase();

  try {
    db.prepare(`
      INSERT INTO participants (name, email, rsvp_token, active)
      VALUES (?, ?, ?, ?)
    `).run('Alice Existing', 'alice@example.com', 'alice-token', 1);

    db.prepare(`
      INSERT INTO participants (name, email, rsvp_token, active)
      VALUES (?, ?, ?, ?)
    `).run('Bob Old', 'bob@example.com', 'bob-token', 0);

    const rows = parseContactsCsv(`
First Name,Last Name,Email Address
Alice,Example,ALICE@example.com
Bob,Example,bob@example.com
Carol,Example,carol@example.com
`.trim());

    const summary = importParticipants(db, rows);

    assert.deepEqual(summary, {
      processed: 3,
      inserted: 1,
      reactivated: 1,
      skippedActive: 1
    });

    const participants = db.prepare(`
      SELECT name, email, active
      FROM participants
      ORDER BY email ASC
    `).all();

    assert.deepEqual(participants, [
      { name: 'Alice Existing', email: 'alice@example.com', active: 1 },
      { name: 'Bob Example', email: 'bob@example.com', active: 1 },
      { name: 'Carol Example', email: 'carol@example.com', active: 1 }
    ]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
