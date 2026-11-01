'use strict';

const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TABLE_COUNT_QUERIES = Object.freeze({
  _codex_probe: 'SELECT COUNT(*) AS count FROM _codex_probe',
  admin_tokens: 'SELECT COUNT(*) AS count FROM admin_tokens',
  email_delivery_history: 'SELECT COUNT(*) AS count FROM email_delivery_history',
  event_public_slugs: 'SELECT COUNT(*) AS count FROM event_public_slugs',
  events: 'SELECT COUNT(*) AS count FROM events',
  locations: 'SELECT COUNT(*) AS count FROM locations',
  notification_settings: 'SELECT COUNT(*) AS count FROM notification_settings',
  participants: 'SELECT COUNT(*) AS count FROM participants',
  responses: 'SELECT COUNT(*) AS count FROM responses',
  scheduled_reminders: 'SELECT COUNT(*) AS count FROM scheduled_reminders',
  scheduled_rsvp_summaries: 'SELECT COUNT(*) AS count FROM scheduled_rsvp_summaries',
  schema_migrations: 'SELECT COUNT(*) AS count FROM schema_migrations',
  sessions: 'SELECT COUNT(*) AS count FROM sessions'
});

function assertIntegrity(database, label) {
  const rows = database.pragma('integrity_check');
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') {
    const details = rows.map(row => row.integrity_check).join('; ');
    throw new Error(`${label} PRAGMA integrity_check failed: ${details || 'no result'}`);
  }
}

function inspectDatabase(database, label) {
  assertIntegrity(database, label);

  const tables = database.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `).all();

  if (!tables.some(table => table.name === 'schema_migrations')) {
    throw new Error(`${label} is missing the schema_migrations table`);
  }

  const migrations = database.prepare(`
    SELECT id, applied_at
    FROM schema_migrations
    ORDER BY id ASC
  `).all();

  if (migrations.length === 0) {
    throw new Error(`${label} has no recorded migrations`);
  }

  const rowCounts = Object.fromEntries(tables.map(({ name }) => {
    const query = TABLE_COUNT_QUERIES[name];
    if (!query) {
      throw new Error(`${label} has no registered row-count query for table ${name}`);
    }
    const result = database.prepare(query).get();
    return [name, result.count];
  }));

  return {
    tables,
    migrations,
    rowCounts
  };
}

function assertSameInventory(expected, actual) {
  for (const key of ['tables', 'migrations', 'rowCounts']) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) {
      throw new Error(`Restored database ${key} differ from the backup`);
    }
  }
}

async function main() {
  const backupArgument = process.argv[2];
  if (!backupArgument || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/verify-sqlite-backup.js <backup.sqlite3>');
  }

  const backupPath = fs.realpathSync(path.resolve(backupArgument));
  const repositoryRoot = path.resolve(__dirname, '..');
  const pathFromRepository = path.relative(repositoryRoot, backupPath);
  if (pathFromRepository === '' || (!pathFromRepository.startsWith('..') && !path.isAbsolute(pathFromRepository))) {
    throw new Error('Keep backup files outside the application repository');
  }

  const repositoryDatabases = [
    path.join(repositoryRoot, 'data', 'euchre.db'),
    path.join(repositoryRoot, 'euchre.db')
  ];
  for (const databasePath of repositoryDatabases) {
    if (fs.existsSync(databasePath) && fs.realpathSync(databasePath) === backupPath) {
      throw new Error('Refusing to inspect an application database in place; pass a separate backup file');
    }
  }

  const oldUmask = process.umask(0o077);
  const restoreDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dunedin-euchre-restore-'));
  fs.chmodSync(restoreDirectory, 0o700);
  const restoredPath = path.join(restoreDirectory, 'restored.sqlite3');
  let backupDatabase;
  let restoredDatabase;

  try {
    backupDatabase = new Database(backupPath, { readonly: true, fileMustExist: true });
    backupDatabase.pragma('query_only = ON');
    const backupInventory = inspectDatabase(backupDatabase, 'Backup');

    await backupDatabase.backup(restoredPath);
    backupDatabase.close();
    backupDatabase = undefined;

    restoredDatabase = new Database(restoredPath, { readonly: true, fileMustExist: true });
    restoredDatabase.pragma('query_only = ON');
    const restoredInventory = inspectDatabase(restoredDatabase, 'Restored temporary database');
    assertSameInventory(backupInventory, restoredInventory);

    console.log('Backup PRAGMA integrity_check: ok');
    console.log('Temporary restore PRAGMA integrity_check: ok');
    console.log(`Tables and migrations preserved: ${backupInventory.tables.length} tables, ${backupInventory.migrations.length} migrations`);
    for (const [table, count] of Object.entries(backupInventory.rowCounts)) {
      console.log(`  ${table}: ${count} rows`);
    }
    console.log('PASS: restored table definitions, migration rows, and per-table row counts match the backup');
  } finally {
    if (restoredDatabase) restoredDatabase.close();
    if (backupDatabase) backupDatabase.close();
    fs.rmSync(restoreDirectory, { recursive: true, force: true });
    process.umask(oldUmask);
  }
}

main().catch(error => {
  console.error(`Backup verification failed: ${error.message}`);
  process.exitCode = 1;
});
