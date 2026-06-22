'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger'); // we'll create this soon

// Resolve DB path from env variable, relative to the project root (not this file's location)
const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || './data/techfest.db');

// Ensure the directory for the DB file exists.
// better-sqlite3 will create the file, but NOT the parent directory.
// If ./data/ doesn't exist, the open() call silently fails on some systems.
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true }); // recursive: true = mkdir -p
}

// Open (or create) the SQLite database file.
// verbose: logs every SQL statement in development — very helpful for debugging.
const db = new Database(dbPath, {
  verbose: process.env.NODE_ENV === 'development' ? (sql) => logger.trace({ sql }, 'SQLite') : null,
});

/**
 * Run the schema file to create all tables if they don't exist.
 * Using IF NOT EXISTS means this is safe to call every time the server starts.
 * It won't drop or alter existing tables.
 */
function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Execute the entire schema as a batch.
  // exec() runs multiple SQL statements separated by semicolons.
  // We can't use .prepare() here because it only accepts single statements.
  db.exec(schema);

  logger.info({ dbPath }, 'SQLite schema initialised');
}

/**
 * Apply performance PRAGMAs every time the DB connection opens.
 * These are session-level settings — they reset when the connection closes.
 * WAL mode is persistent on disk, but the other PRAGMAs need to be re-set.
 */
function applyPragmas() {
  db.pragma('journal_mode = WAL');     // already in schema.sql, but doesn't hurt to repeat
  db.pragma('foreign_keys = ON');      // CRITICAL: SQLite disables FK checks by default
  db.pragma('synchronous = NORMAL');   // Safer than OFF, faster than FULL. Good WAL mode default.
  db.pragma('cache_size = -64000');    // 64 MB page cache (negative = kilobytes). Speeds up reads.
  db.pragma('temp_store = MEMORY');    // Store temp tables in RAM, not on disk
  db.pragma('mmap_size = 268435456'); // 256 MB memory-mapped I/O for faster reads
}

// Run setup
applyPragmas();
initSchema();

// Export the db instance. All other files import this — single connection shared across app.
// better-sqlite3 is synchronous and handles its own thread safety internally.
module.exports = db;