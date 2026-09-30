import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let dbInstance;

export function openDb(path = process.env.DB_PATH || './data/bookstores.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  migrate(db);
  return db;
}

export function getDb(path) {
  if (!path && dbInstance) return dbInstance;
  dbInstance = openDb(path);
  return dbInstance;
}

export function migrate(db) {
  db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS catalog_versions (
    version INTEGER PRIMARY KEY CHECK (version = 1),
    version_number INTEGER NOT NULL,
    changed_at_ms INTEGER NOT NULL,
    last_reason TEXT NOT NULL
  );
  INSERT OR IGNORE INTO catalog_versions(version, version_number, changed_at_ms, last_reason)
  VALUES (1, 1, 0, 'initial');

  CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    address TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    timezone TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    merged_into_id TEXT REFERENCES stores(id),
    merge_reason TEXT,
    hours_version INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS store_name_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    from_ms INTEGER NOT NULL,
    to_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_store_names_store ON store_name_history(store_id);

  CREATE TABLE IF NOT EXISTS store_aliases (
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    PRIMARY KEY (store_id, alias)
  );

  CREATE TABLE IF NOT EXISTS store_themes (
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    theme TEXT NOT NULL,
    PRIMARY KEY (store_id, theme)
  );
  CREATE INDEX IF NOT EXISTS idx_themes_theme ON store_themes(theme);

  CREATE TABLE IF NOT EXISTS store_seats (
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    seat_type TEXT NOT NULL,
    seats_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (store_id, seat_type)
  );
  CREATE INDEX IF NOT EXISTS idx_seats_type ON store_seats(seat_type);

  -- 周期时段：weekday 以周一为 0。只存起点和持续分钟，
  -- close <= open 的“跨午夜”歧义因此不存在。
  CREATE TABLE IF NOT EXISTS weekly_hours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1440),
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
    disambiguation TEXT NOT NULL DEFAULT 'compatible'
      CHECK (disambiguation IN ('compatible','first','second')),
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(store_id, weekday, start_minute, duration_minutes)
  );
  CREATE INDEX IF NOT EXISTS idx_weekly_store ON weekly_hours(store_id, active);

  CREATE TABLE IF NOT EXISTS hours_exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('closed','open')),
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    starts_local TEXT NOT NULL,
    ends_local TEXT NOT NULL,
    starts_ms INTEGER NOT NULL,
    ends_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_exceptions_store_time
    ON hours_exceptions(store_id, starts_ms, ends_ms);

  CREATE TABLE IF NOT EXISTS open_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    starts_ms INTEGER NOT NULL,
    ends_ms INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_ids TEXT NOT NULL DEFAULT '[]',
    hours_version INTEGER NOT NULL,
    generated_at_ms INTEGER NOT NULL,
    UNIQUE(store_id, starts_ms, ends_ms, source_type, source_ids)
  );
  CREATE INDEX IF NOT EXISTS idx_windows_store_point
    ON open_windows(store_id, starts_ms, ends_ms);
  CREATE INDEX IF NOT EXISTS idx_windows_time ON open_windows(starts_ms, ends_ms);

  CREATE TABLE IF NOT EXISTS status_cache (
    store_id TEXT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('open','closed')),
    computed_at_ms INTEGER NOT NULL,
    valid_at_ms INTEGER NOT NULL,
    next_change_ms INTEGER NOT NULL,
    hours_version INTEGER NOT NULL,
    source_ids TEXT NOT NULL DEFAULT '[]',
    window_consistent INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS manual_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
    correction_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL,
    catalog_version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS query_versions (
    id TEXT PRIMARY KEY,
    filters_json TEXT NOT NULL,
    catalog_version INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    last_used_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_query_versions_catalog ON query_versions(catalog_version);

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    theme TEXT NOT NULL DEFAULT '其他',
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    is_private INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS event_sessions (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores(id),
    starts_ms INTEGER NOT NULL,
    ends_ms INTEGER NOT NULL,
    starts_local_snapshot TEXT NOT NULL,
    ends_local_snapshot TEXT NOT NULL,
    timezone_snapshot TEXT NOT NULL,
    dst_choice TEXT,
    dst_repeated INTEGER NOT NULL DEFAULT 0,
    dst_gap INTEGER NOT NULL DEFAULT 0,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    booked_count INTEGER NOT NULL DEFAULT 0,
    closed_required INTEGER NOT NULL DEFAULT 0,
    authorized INTEGER NOT NULL DEFAULT 0,
    authorization_note TEXT,
    authorized_by TEXT,
    authorized_at_ms INTEGER,
    closure_digest TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_time ON event_sessions(starts_ms, ends_ms, status);
  CREATE INDEX IF NOT EXISTS idx_sessions_store_time ON event_sessions(store_id, starts_ms);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_booked_invariant
    ON event_sessions(id) WHERE booked_count > capacity;

  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES event_sessions(id),
    contact_name TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    seats INTEGER NOT NULL CHECK (seats > 0),
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
    receipt_snapshot_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    cancelled_at_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings(session_id, status);

  CREATE TRIGGER IF NOT EXISTS trg_session_no_overbooking_update
  BEFORE UPDATE OF booked_count ON event_sessions
  WHEN NEW.booked_count > NEW.capacity
  BEGIN
    SELECT RAISE(ABORT, 'event session capacity exceeded');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_session_no_overbooking_insert
  BEFORE INSERT ON event_sessions
  WHEN NEW.booked_count > NEW.capacity
  BEGIN
    SELECT RAISE(ABORT, 'event session capacity exceeded');
  END;
  `);
}

export function currentCatalogVersion(db) {
  return db.prepare('SELECT version_number AS version FROM catalog_versions WHERE version = 1').get().version;
}

export function bumpCatalogVersion(db, reason, storeId = null, type = null, payload = {}) {
  const tx = db.transaction(() => {
    const current = currentCatalogVersion(db);
    const next = current + 1;
    const now = Date.now();
    db.prepare(`UPDATE catalog_versions SET version_number = ?, changed_at_ms = ?, last_reason = ? WHERE version = 1`)
      .run(next, now, reason);
    db.prepare(`INSERT INTO manual_corrections(store_id, correction_type, payload_json, applied_at_ms, catalog_version)
                VALUES (?, ?, ?, ?, ?)`).run(storeId, type || reason, JSON.stringify(payload), now, next);
    // 旧查询版必须感知到更正，而不是静默继续画旧聚合。
    db.prepare(`DELETE FROM status_cache`).run();
    return next;
  });
  return tx();
}

export function bumpHoursVersion(db, storeId) {
  db.prepare(`UPDATE stores SET hours_version = hours_version + 1, updated_at_ms = ? WHERE id = ?`)
    .run(Date.now(), storeId);
  db.prepare('DELETE FROM status_cache WHERE store_id = ?').run(storeId);
}
