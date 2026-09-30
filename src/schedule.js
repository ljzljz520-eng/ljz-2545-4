import {
  addLocalDays,
  parseClock,
  parseLocalDateTime,
  toIsoUtc,
  wallDateAt,
  wallMatches,
  wallToUtcMs
} from './time.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const DEFAULT_HORIZON_DAYS = 750;
const STATUS_LOOKAHEAD_DAYS = 21;

function jsonIds(value) {
  try { return JSON.parse(value || '[]'); } catch { return []; }
}

function getStore(db, storeOrId) {
  const store = typeof storeOrId === 'string'
    ? db.prepare('SELECT * FROM stores WHERE id = ?').get(storeOrId)
    : storeOrId;
  if (!store) throw new Error('门店不存在');
  return store;
}

export function localRangeDates(timeZone, startMs, endMs) {
  // 两端各放宽一天，承接本地 00:00 之后才在 UTC 开始的周一规则，以及跨午夜尾巴。
  return {
    first: addLocalDays(wallDateAt(timeZone, startMs), -1),
    last: addLocalDays(wallDateAt(timeZone, endMs), 1)
  };
}

export function weeklyWindows(db, storeOrId, rangeStartMs, rangeEndMs) {
  const store = getStore(db, storeOrId);
  const rules = db.prepare(`SELECT * FROM weekly_hours WHERE store_id = ? AND active = 1
                            ORDER BY weekday, start_minute`).all(store.id);
  if (rules.length === 0) return [];
  const { first, last } = localRangeDates(store.timezone, rangeStartMs, rangeEndMs);
  const windows = [];
  let cursor = { ...first };

  while (cursor.year < last.year ||
         (cursor.year === last.year &&
          (cursor.month < last.month ||
           (cursor.month === last.month && cursor.day <= last.day)))) {
    // weekday 必须来自门店当地挂钟日期，不能用 Date#getUTCDay 按浏览器/UTC 日截断。
    const localUtcNoon = Date.UTC(cursor.year, cursor.month - 1, cursor.day, 12);
    const weekday = (new Date(localUtcNoon).getUTCDay() + 6) % 7;
    for (const rule of rules) {
      if (rule.weekday !== weekday) continue;
      const startClock = {
        hour: Math.floor(rule.start_minute / 60),
        minute: rule.start_minute % 60
      };
      const allMatches = wallMatches(store.timezone, { ...cursor, ...startClock });
      const selectedMatches = allMatches.length > 1 && rule.disambiguation === 'second'
        ? [allMatches[1]]
        : allMatches.length > 1 && rule.disambiguation === 'first'
          ? [allMatches[0]]
          : allMatches;
      const instances = selectedMatches.length > 0
        ? selectedMatches.map((m, index) => ({ value: m.when, repeated: allMatches.length > 1, gap: false, choice: allMatches.length > 1 && m.when === allMatches[1].when ? 'second' : 'first' }))
        : [wallToUtcMs(store.timezone, { ...cursor, ...startClock },
            { disambiguation: rule.disambiguation })];
      for (const start of instances) {
        const endMs = start.value + rule.duration_minutes * 60_000;
        windows.push({
          store_id: store.id,
          starts_ms: start.value,
          ends_ms: endMs,
          source_type: 'weekly',
          source_ids: [rule.id],
          dst_repeated: start.repeated,
          dst_gap: start.gap,
          dst_choice: start.choice
        });
      }
    }
    cursor = addLocalDays(cursor, 1);
  }
  // 以门店当地日期枚举；保留开始实例落在扩展查询范围内的窗口，跨午夜尾巴可自然探出。
  return windows.filter(w => w.starts_ms >= rangeStartMs && w.starts_ms < rangeEndMs)
    .sort((a, b) => a.starts_ms - b.starts_ms || b.ends_ms - a.ends_ms);
}

function closedExceptions(db, storeId, startMs, endMs) {
  return db.prepare(`SELECT * FROM hours_exceptions
                     WHERE store_id = ? AND kind = 'closed'
                       AND ends_ms > ? AND starts_ms < ?
                     ORDER BY starts_ms, ends_ms`)
    .all(storeId, startMs, endMs);
}

export function openExceptionWindows(db, storeOrId, startMs, endMs) {
  const store = getStore(db, storeOrId);
  return db.prepare(`SELECT * FROM hours_exceptions
                     WHERE store_id = ? AND kind = 'open'
                       AND ends_ms > ? AND starts_ms < ?
                     ORDER BY starts_ms, ends_ms`)
    .all(store.id, startMs, endMs).map(e => ({
      store_id: store.id,
      starts_ms: e.starts_ms,
      ends_ms: e.ends_ms,
      source_type: 'exception_open',
      source_ids: [e.id],
      title: e.title
    }));
}

function subtractInterval(segment, cut) {
  if (cut.ends_ms <= segment.starts_ms || cut.starts_ms >= segment.ends_ms) return [segment];
  const out = [];
  if (cut.starts_ms > segment.starts_ms) {
    out.push({ ...segment, starts_ms: segment.starts_ms, ends_ms: cut.starts_ms });
  }
  if (cut.ends_ms < segment.ends_ms) {
    out.push({ ...segment, starts_ms: cut.ends_ms, ends_ms: segment.ends_ms });
  }
  return out;
}

function mergeUnion(intervals) {
  const sorted = intervals
    .filter(i => i.ends_ms > i.starts_ms)
    .sort((a, b) => a.starts_ms - b.starts_ms || b.ends_ms - a.ends_ms);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.starts_ms <= last.ends_ms) {
      last.ends_ms = Math.max(last.ends_ms, interval.ends_ms);
      for (const source of interval.sources || []) {
        if (!last.sources.some(s => s.type === source.type && s.id === source.id)) last.sources.push(source);
      }
    } else {
      merged.push({
        starts_ms: interval.starts_ms,
        ends_ms: interval.ends_ms,
        sources: interval.sources ? [...interval.sources] : []
      });
    }
  }
  return merged.map(i => ({
    ...i,
    source_type: i.sources.length === 1 ? i.sources[0].type : 'combined',
    source_ids: [...new Set(i.sources.map(s => s.id))]
  }));
}

// 实时有效时间：常规营业 + 临时加开，再由临时闭店做高优先级挖空。
export function effectiveWindows(db, storeOrId, startMs, endMs) {
  const store = getStore(db, storeOrId);
  const expandedStart = startMs - DAY;
  const expandedEnd = endMs + DAY;
  const raw = [
    ...weeklyWindows(db, store, expandedStart, expandedEnd),
    ...openExceptionWindows(db, store, expandedStart, expandedEnd)
  ].map(w => ({
    starts_ms: Math.max(w.starts_ms, startMs),
    ends_ms: Math.min(w.ends_ms, endMs),
    sources: [{ type: w.source_type, id: w.source_ids[0] }]
  }));

  let intervals = raw;
  for (const closure of closedExceptions(db, store.id, startMs, endMs)) {
    intervals = intervals.flatMap(i => subtractInterval(i, closure));
  }
  return mergeUnion(intervals)
    .filter(w => w.ends_ms > startMs && w.starts_ms < endMs)
    .sort((a, b) => a.starts_ms - b.starts_ms);
}

export function regenerateStoreWindows(db, storeOrId, now = Date.now(), horizonDays = DEFAULT_HORIZON_DAYS) {
  const store = getStore(db, storeOrId);
  const horizonEnd = now + horizonDays * DAY;
  const expected = effectiveWindows(db, store, now, horizonEnd).map(w => ({
    store_id: store.id,
    starts_ms: w.starts_ms,
    ends_ms: w.ends_ms,
    source_type: w.source_type,
    source_ids: JSON.stringify(w.source_ids)
  }));

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM open_windows
                WHERE store_id = ? AND ends_ms > ? AND starts_ms < ?`)
      .run(store.id, now, horizonEnd);
    const stmt = db.prepare(`INSERT INTO open_windows
      (store_id, starts_ms, ends_ms, source_type, source_ids, hours_version, generated_at_ms)
      VALUES (@store_id, @starts_ms, @ends_ms, @source_type, @source_ids, @hours_version, @generated_at_ms)`);
    for (const row of expected) {
      stmt.run({ ...row, hours_version: store.hours_version, generated_at_ms: now });
    }
  });
  tx();
  return expected;
}

export function regenerateAllWindows(db, now = Date.now(), horizonDays = DEFAULT_HORIZON_DAYS) {
  const stores = db.prepare('SELECT * FROM stores WHERE active = 1 AND merged_into_id IS NULL').all();
  for (const store of stores) regenerateStoreWindows(db, store, now, horizonDays);
}

function materializedMatches(db, store, windows, now) {
  const rows = db.prepare(`SELECT starts_ms, ends_ms, source_type, source_ids
                           FROM open_windows
                           WHERE store_id = ? AND starts_ms <= ? AND ends_ms > ?`)
    .all(store.id, now, now);
  const actual = new Set(rows.map(r => `${r.starts_ms}|${r.ends_ms}|${r.source_type}|${r.source_ids}`));
  const expected = new Set(windows
    .filter(w => w.starts_ms <= now && w.ends_ms > now)
    .map(w => `${w.starts_ms}|${w.ends_ms}|${w.source_type}|${JSON.stringify(w.source_ids)}`));
  if (actual.size !== expected.size) return false;
  for (const value of expected) if (!actual.has(value)) return false;
  return true;
}

export function getStoreStatus(db, storeOrId, asOf = Date.now(), options = {}) {
  const store = getStore(db, storeOrId);
  const now = asOf;
  const historical = options.explicitAsOf && asOf < options.referenceNow - 60_000;
  if (!historical && !options.forceRecompute) {
    const cached = db.prepare('SELECT * FROM status_cache WHERE store_id = ?').get(store.id);
    if (cached && cached.hours_version === store.hours_version &&
        now >= cached.computed_at_ms && now < cached.next_change_ms) {
      return {
        state: cached.state,
        as_of_ms: now,
        next_change_ms: cached.next_change_ms,
        computed_at_ms: cached.computed_at_ms,
        cache: 'hit',
        cache_expires_at_ms: cached.next_change_ms,
        window_consistent: !!cached.window_consistent,
        historical: false,
        source_ids: jsonIds(cached.source_ids)
      };
    }
  }

  const rangeStart = now;
  const rangeEnd = now + STATUS_LOOKAHEAD_DAYS * DAY;
  let windows = effectiveWindows(db, store, rangeStart, rangeEnd);
  let consistent = materializedMatches(db, store, windows, now);

  if (!consistent && !historical) {
    regenerateStoreWindows(db, store, now, options.horizonDays || DEFAULT_HORIZON_DAYS);
    windows = effectiveWindows(db, store, rangeStart, rangeEnd);
    consistent = materializedMatches(db, store, windows, now);
  }

  const current = windows.filter(w => w.starts_ms <= now && w.ends_ms > now);
  let state;
  let nextChange;
  let sourceIds = [];
  if (current.length > 0) {
    state = 'open';
    nextChange = Math.min(...current.map(w => w.ends_ms));
    sourceIds = [...new Set(current.flatMap(w => w.source_ids))];
  } else {
    state = 'closed';
    const nextOpen = windows.find(w => w.starts_ms > now);
    nextChange = nextOpen ? nextOpen.starts_ms : rangeEnd;
  }

  if (!historical) {
    db.prepare(`INSERT INTO status_cache(store_id, state, computed_at_ms, valid_at_ms,
      next_change_ms, hours_version, source_ids, window_consistent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(store_id) DO UPDATE SET
      state=excluded.state,
      computed_at_ms=excluded.computed_at_ms,
      valid_at_ms=excluded.valid_at_ms,
      next_change_ms=excluded.next_change_ms,
      hours_version=excluded.hours_version,
      source_ids=excluded.source_ids,
      window_consistent=excluded.window_consistent`)
    .run(store.id, state, now, now, nextChange, store.hours_version, JSON.stringify(sourceIds), consistent ? 1 : 0);
  }

  return {
    state,
    as_of_ms: now,
    next_change_ms: nextChange,
    computed_at_ms: now,
    cache: historical ? 'historical' : 'miss',
    historical,
    cache_expires_at_ms: nextChange,
    window_consistent: consistent,
    source_ids: sourceIds
  };
}

export function isFullyOpen(db, storeOrId, startMs, endMs) {
  if (endMs <= startMs) throw new Error('活动结束时间必须晚于开始时间');
  const windows = mergeUnion(effectiveWindows(db, storeOrId, startMs, endMs)
    .map(w => ({ starts_ms: w.starts_ms, ends_ms: w.ends_ms, sources: w.source_ids.map(id => ({ type: w.source_type, id })) })));
  let cursor = startMs;
  for (const window of windows) {
    if (window.starts_ms > cursor) return false;
    if (window.ends_ms >= endMs) return true;
    cursor = Math.max(cursor, window.ends_ms);
  }
  return cursor >= endMs;
}

export function closureDigest(db, storeOrId, startMs, endMs) {
  const windows = effectiveWindows(db, storeOrId, startMs, endMs);
  return JSON.stringify({
    v: 2,
    fully_open: isFullyOpen(db, storeOrId, startMs, endMs),
    windows: windows.map(w => [w.starts_ms, w.ends_ms, w.source_type, w.source_ids.join('.')])
  });
}

export function recomputeSessionAuthorization(db, session, now = Date.now()) {
  const store = getStore(db, session.store_id);
  const fullyOpen = isFullyOpen(db, store.id, session.starts_ms, session.ends_ms);
  const digest = closureDigest(db, store.id, session.starts_ms, session.ends_ms);
  const closedRequired = !fullyOpen;
  const digestChanged = session.closure_digest && session.closure_digest !== digest;

  // 营业边界一变，闭店专场的旧授权不能静默沿用；必须按新边界重新显式授权。
  const authorized = !digestChanged && closedRequired ? !!session.authorized : false;
  db.prepare(`UPDATE event_sessions
              SET closed_required = ?, closure_digest = ?, authorized = ?,
                  authorization_note = CASE WHEN ? THEN NULL ELSE authorization_note END,
                  authorized_by = CASE WHEN ? THEN NULL ELSE authorized_by END,
                  authorized_at_ms = CASE WHEN ? THEN NULL ELSE authorized_at_ms END,
                  updated_at_ms = ?
              WHERE id = ?`)
    .run(closedRequired ? 1 : 0, digest, authorized ? 1 : 0,
      digestChanged ? 1 : 0, digestChanged ? 1 : 0, digestChanged ? 1 : 0,
      now, session.id);
  return db.prepare('SELECT * FROM event_sessions WHERE id = ?').get(session.id);
}

export function refreshStoreSessionAuth(db, storeId, now = Date.now()) {
  const sessions = db.prepare(`SELECT * FROM event_sessions
                               WHERE store_id = ? AND status = 'active' AND ends_ms >= ?`)
    .all(storeId, now);
  return sessions.map(s => recomputeSessionAuthorization(db, s, now));
}

export function addException(db, storeId, kind, title, startsLocal, endsLocal, note = '', now = Date.now()) {
  const store = getStore(db, storeId);
  const start = wallToUtcMs(store.timezone, parseLocalDateTime(startsLocal), { disambiguation: 'compatible' });
  const endWall = parseLocalDateTime(endsLocal);
  let endMs = wallToUtcMs(store.timezone, endWall, { disambiguation: 'compatible' }).value;
  // 允许在本地挂钟上写 24:00；parseClock/parseLocalDateTime 会归一为 00:00，这里补回一天。
  if (/T24:00/.test(endsLocal)) endMs += DAY;
  if (endMs <= start.value) throw new Error('临时时段结束必须晚于开始');
  const info = db.prepare(`INSERT INTO hours_exceptions
    (store_id, kind, title, note, starts_local, ends_local, starts_ms, ends_ms, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(storeId, kind, title, note, startsLocal, endsLocal, start.value, endMs, now, now);
  bumpAndRefresh(db, storeId, `exception:${kind}`, now);
  return db.prepare('SELECT * FROM hours_exceptions WHERE rowid = last_insert_rowid()').get();
}

function bumpAndRefresh(db, storeId, reason, now) {
  db.prepare('UPDATE stores SET hours_version = hours_version + 1, updated_at_ms = ? WHERE id = ?')
    .run(now, storeId);
  db.prepare('DELETE FROM status_cache WHERE store_id = ?').run(storeId);
  regenerateStoreWindows(db, storeId, now);
  refreshStoreSessionAuth(db, storeId, now);
}

export { getStore, toIsoUtc, HOUR, DAY };
