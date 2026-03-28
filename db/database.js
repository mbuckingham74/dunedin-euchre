'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { ensureParticipantEmailUniqueIndex, runMigrations } = require('./migrations');

// In Docker the DB lives in the mounted data/ volume; tests can override it with DB_PATH.
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'euchre.db');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
runMigrations(db);
ensureParticipantEmailUniqueIndex(db);

module.exports = db;
