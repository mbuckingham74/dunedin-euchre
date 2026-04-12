'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { v4: uuidv4 } = require('uuid');

function parseCsvRecords(csvText) {
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const normalizedText = csvText.replace(/^\uFEFF/, '');

  for (let index = 0; index < normalizedText.length; index++) {
    const character = normalizedText[index];

    if (inQuotes) {
      if (character === '"') {
        if (normalizedText[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      continue;
    }

    if (character === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (character === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      continue;
    }

    if (character === '\r') continue;

    field += character;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  return records.filter(record => record.some(value => value.trim() !== ''));
}

function parseContactsCsv(csvText) {
  const records = parseCsvRecords(csvText);
  if (records.length === 0) {
    throw new Error('CSV file is empty.');
  }

  const header = records[0].map(value => value.trim());
  const firstNameIndex = header.indexOf('First Name');
  const lastNameIndex = header.indexOf('Last Name');
  const emailIndex = header.indexOf('Email Address');

  if (firstNameIndex === -1 || lastNameIndex === -1 || emailIndex === -1) {
    throw new Error(
      'CSV must contain the headers "First Name", "Last Name", and "Email Address".'
    );
  }

  const rows = records.slice(1).map((record, index) => {
    const firstName = (record[firstNameIndex] || '').trim();
    const lastName = (record[lastNameIndex] || '').trim();
    const email = (record[emailIndex] || '').trim().toLowerCase();
    const name = [firstName, lastName].filter(Boolean).join(' ').trim();

    return {
      rowNumber: index + 2,
      firstName,
      lastName,
      name,
      email
    };
  });

  const invalidRows = rows.filter(row => !row.name || !row.email);
  if (invalidRows.length > 0) {
    throw new Error(
      `CSV contains rows missing a name or email: ${invalidRows.map(row => row.rowNumber).join(', ')}`
    );
  }

  const seenEmails = new Map();
  const duplicateEmails = [];

  for (const row of rows) {
    if (seenEmails.has(row.email)) {
      duplicateEmails.push(`${row.email} (rows ${seenEmails.get(row.email)} and ${row.rowNumber})`);
      continue;
    }

    seenEmails.set(row.email, row.rowNumber);
  }

  if (duplicateEmails.length > 0) {
    throw new Error(`CSV contains duplicate email addresses: ${duplicateEmails.join(', ')}`);
  }

  return rows;
}

function getDuplicateParticipantEmails(db) {
  return db.prepare(`
    SELECT LOWER(email) AS email_key, COUNT(*) AS count
    FROM participants
    GROUP BY LOWER(email)
    HAVING COUNT(*) > 1
    ORDER BY email_key ASC
  `).all();
}

function importParticipants(db, rows) {
  const duplicateParticipantEmails = getDuplicateParticipantEmails(db);
  if (duplicateParticipantEmails.length > 0) {
    throw new Error(
      `Database already contains duplicate participant emails: ${duplicateParticipantEmails.map(row => row.email_key).join(', ')}`
    );
  }

  const findByEmail = db.prepare(
    'SELECT id, name, email, active FROM participants WHERE email = ? COLLATE NOCASE'
  );
  const insertParticipant = db.prepare(
    'INSERT INTO participants (name, email, rsvp_token, party_members) VALUES (?, ?, ?, ?)'
  );
  const reactivateParticipant = db.prepare(`
    UPDATE participants
    SET name = ?, party_members = ?, active = 1
    WHERE id = ?
  `);

  const executeImport = db.transaction((inputRows) => {
    const summary = {
      processed: inputRows.length,
      inserted: 0,
      reactivated: 0,
      skippedActive: 0
    };

    for (const row of inputRows) {
      const existing = findByEmail.get(row.email);

      if (!existing) {
        insertParticipant.run(row.name, row.email, uuidv4(), JSON.stringify([row.name]));
        summary.inserted++;
        continue;
      }

      if (Number(existing.active)) {
        summary.skippedActive++;
        continue;
      }

      reactivateParticipant.run(row.name, JSON.stringify([row.name]), existing.id);
      summary.reactivated++;
    }

    return summary;
  });

  return executeImport(rows);
}

function main() {
  const csvPathArgument = process.argv[2];
  if (!csvPathArgument) {
    throw new Error('Usage: node scripts/import-participants-csv.js /absolute/path/to/contacts.csv');
  }

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

  const csvPath = path.resolve(csvPathArgument);
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const rows = parseContactsCsv(csvText);
  const db = require('../db/database');

  try {
    const summary = importParticipants(db, rows);
    const activeCount = db.prepare('SELECT COUNT(*) AS count FROM participants WHERE active = 1').get().count;

    console.log(`Imported participants from ${csvPath}`);
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Active participants in database: ${activeCount}`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  importParticipants,
  parseContactsCsv,
  parseCsvRecords
};
