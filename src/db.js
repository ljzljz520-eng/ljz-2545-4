'use strict';

const fs = require('fs/promises');
const path = require('path');
const initSqlJs = require('sql.js');
const { seedDatabase } = require('./seed');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'bookbar.sqlite');

let SQL;
let db;
let writeChain = Promise.resolve();
let persistTimer = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_history TEXT NOT NULL DEFAULT '[]',
  merged_into_id TEXT REFERENCES stores(id),
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  time_zone TEXT NOT NULL,
  themes_json TEXT NOT NULL DEFAULT '[]',
  seats_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stores_active ON stores(active);
CREATE TABLE IF NOT EXISTS weekly_hours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK(weekday BETWEEN 1 AND 7),
  start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER NOT NULL CHECK(end_minute BETWEEN 0 AND 1439),
  note TEXT NOT NULL DEFAULT '',
  UNIQUE(store_id, weekday, start_minute, end_minute)
);
CREATE TABLE IF NOT EXISTS schedule_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('closed','modified')),
  start_minute INTEGER CHECK(start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER CHECK(end_minute BETWEEN 0 AND 1439),
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(store_id, local_date, kind, start_minute, end_minute)
);
CREATE INDEX IF NOT EXISTS idx_exceptions_store_date ON schedule_exceptions(store_id, local_date);
CREATE TABLE IF NOT EXISTS event_sessions (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK(ends_at > starts_at),
  capacity INTEGER NOT NULL CHECK(capacity > 0),
  remaining INTEGER NOT NULL CHECK(remaining >= 0),
  requires_closed_authorization INTEGER NOT NULL,
  closed_fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','canceled')),
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_time ON event_sessions(starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_events_store_time ON event_sessions(store_id, starts_at);
CREATE TABLE IF NOT EXISTS event_closed_authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES event_sessions(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  granted_by TEXT NOT NULL DEFAULT 'manager',
  granted_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  UNIQUE(event_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES event_sessions(id),
  attendee_name TEXT NOT NULL,
  attendee_contact TEXT NOT NULL DEFAULT '',
  seats INTEGER NOT NULL CHECK(seats > 0),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','canceled')),
  actual_store_id TEXT NOT NULL,
  actual_store_name_at_booking TEXT NOT NULL,
  actual_title_at_booking TEXT NOT NULL,
  actual_start_at INTEGER NOT NULL,
  actual_end_at INTEGER NOT NULL,
  actual_time_zone TEXT NOT NULL,
  actual_session_version INTEGER NOT NULL,
  confirmation_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_event ON registrations(event_id);
CREATE TABLE IF NOT EXISTS business_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  anchor_local_date TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('open','closed_exception')),
  source TEXT NOT NULL CHECK(source IN ('weekly','exception')),
  weekday INTEGER,
  schedule_version INTEGER NOT NULL,
  UNIQUE(store_id, starts_at, ends_at, kind)
);
CREATE INDEX IF NOT EXISTS idx_windows_time ON business_windows(starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_windows_store_time ON business_windows(store_id, starts_at, ends_at);
CREATE TABLE IF NOT EXISTS query_versions (
  id TEXT PRIMARY KEY,
  filters_json TEXT NOT NULL,
  filter_signature TEXT NOT NULL UNIQUE,
  data_version INTEGER NOT NULL,
  schedule_version INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  invalidated_at INTEGER,
  invalid_reason TEXT,
  last_match_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_qv_expiry ON query_versions(expires_at);
CREATE TABLE IF NOT EXISTS query_store_matches (
  query_version_id TEXT NOT NULL REFERENCES query_versions(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL,
  rank_score REAL NOT NULL,
  status_at_generation TEXT NOT NULL,
  state_changed_at INTEGER,
  store_snapshot_json TEXT NOT NULL,
  PRIMARY KEY(query_version_id, store_id)
);
CREATE INDEX IF NOT EXISTS idx_qsm_store ON query_store_matches(store_id);
CREATE TABLE IF NOT EXISTS query_event_matches (
  query_version_id TEXT NOT NULL REFERENCES query_versions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  rank_score REAL NOT NULL,
  event_snapshot_json TEXT NOT NULL,
  PRIMARY KEY(query_version_id, event_id)
);
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function run(sql, params = []) {
  getDb().run(sql, params);
}

function one(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  let result = null;
  if (stmt.step()) result = stmt.getAsObject();
  stmt.free();
  return result;
}

function all(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getMeta(key, fallback = null) {
  const row = one('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]);
}

function bumpMeta(key, by = 1) {
  const next = Number(getMeta(key, '0')) + by;
  setMeta(key, String(next));
  return next;
}

async function flush() {
  const data = getDb().export();
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, Buffer.from(data));
}

function scheduleFlush() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeChain = writeChain.then(flush).catch((err) => {
      console.error('database persist failed', err);
    });
  }, 20);
}

async function withWrite(worker, { persist = true } = {}) {
  const call = async () => {
    const result = await worker({ run, all, one, getDb, bumpMeta, setMeta, getMeta });
    if (persist) scheduleFlush();
    return result;
  };
  const resultPromise = writeChain.then(call, call);
  // Keep the chain alive even when this caller handles the error.
  writeChain = resultPromise.then(() => undefined, () => undefined);
  return resultPromise;
}

async function transaction(worker, options = {}) {
  return withWrite(async (ctx) => {
    ctx.run('BEGIN IMMEDIATE');
    try {
      const result = await worker(ctx);
      ctx.run('COMMIT');
      return result;
    } catch (err) {
      try { ctx.run('ROLLBACK'); } catch (_) {}
      throw err;
    }
  }, options);
}

async function initDatabase() {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js/package.json')), 'dist', file)
  });
  await fs.mkdir(DATA_DIR, { recursive: true });
  let file;
  try {
    file = await fs.readFile(DB_PATH);
  } catch (_) {
    file = null;
  }
  db = file ? new SQL.Database(file) : new SQL.Database();
  db.run(SCHEMA);
  if (!getMeta('initialized_at')) {
    await seedDatabase({ run, all, one, getDb, setMeta, bumpMeta });
    await flush();
  }
  return db;
}

async function closeDatabase() {
  if (persistTimer) clearTimeout(persistTimer);
  await writeChain;
  if (db) {
    await flush();
    db.close();
    db = null;
  }
}

module.exports = {
  DB_PATH,
  all,
  bumpMeta,
  closeDatabase,
  flush,
  getDb,
  getMeta,
  initDatabase,
  one,
  run,
  setMeta,
  transaction,
  withWrite
};
