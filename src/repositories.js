import { randomUUID } from 'node:crypto';
import { formatWall, wallToUtcMs } from './time.js';
import { closureDigest, refreshStoreSessionAuth, regenerateStoreWindows } from './schedule.js';
import { bumpCatalogVersion, currentCatalogVersion } from './db.js';

const DAY = 86_400_000;

export function id(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export function shortCode() {
  return Buffer.from(randomUUID().replace(/-/g, ''), 'hex').toString('base64url').slice(0, 10).toUpperCase();
}

export function slugify(input) {
  return String(input).toLowerCase().trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `shop-${Date.now()}`;
}

export function uniqueSlug(db, base) {
  let slug = slugify(base);
  let n = 2;
  while (db.prepare('SELECT 1 FROM stores WHERE slug = ?').get(slug)) {
    slug = `${slugify(base)}-${n++}`;
  }
  return slug;
}

export function validateTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    throw new Error('无效的 IANA 时区，例如 Asia/Shanghai');
  }
}

export function createStore(db, data, now = Date.now()) {
  if (!data.name || !data.city || !data.address) throw new Error('店名、城市和地址必填');
  const lat = Number(data.lat);
  const lng = Number(data.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('纬度必须在 -90 到 90');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error('经度必须在 -180 到 180');
  validateTimeZone(data.timezone);
  const storeId = data.id || id('st');
  const slug = data.slug || uniqueSlug(db, data.name);
  db.prepare(`INSERT INTO stores(id, slug, name, city, address, lat, lng, timezone,
      description, active, hours_version, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`).run(
    storeId, slug, data.name, data.city, data.address,
    lat, lng, data.timezone, data.description || '', now, now
  );
  db.prepare('INSERT INTO store_name_history(store_id, name, from_ms) VALUES (?, ?, ?)')
    .run(storeId, data.name, now);
  replaceThemes(db, storeId, data.themes || []);
  replaceSeats(db, storeId, data.seats || {});
  if (data.weeklyHours) replaceWeeklyHours(db, storeId, data.weeklyHours);
  regenerateStoreWindows(db, storeId, now);
  return getStoreById(db, storeId);
}

export function replaceThemes(db, storeId, themes) {
  db.prepare('DELETE FROM store_themes WHERE store_id = ?').run(storeId);
  const stmt = db.prepare('INSERT INTO store_themes(store_id, theme) VALUES (?, ?)');
  for (const theme of new Set(themes)) stmt.run(storeId, theme);
}

export function replaceSeats(db, storeId, seats) {
  db.prepare('DELETE FROM store_seats WHERE store_id = ?').run(storeId);
  const stmt = db.prepare('INSERT INTO store_seats(store_id, seat_type, seats_count) VALUES (?, ?, ?)');
  for (const [seatType, count] of Object.entries(seats)) stmt.run(storeId, seatType, Number(count));
}

export function replaceWeeklyHours(db, storeId, rules, now = Date.now()) {
  const normalized = normalizeWeeklyRules(rules);
  const tx = db.transaction(() => {
    db.prepare('UPDATE weekly_hours SET active = 0 WHERE store_id = ? AND active = 1').run(storeId);
    const stmt = db.prepare(`INSERT INTO weekly_hours
      (store_id, weekday, start_minute, duration_minutes, disambiguation, active)
      VALUES (?, ?, ?, ?, ?, 1)`);
    for (const rule of normalized) {
      stmt.run(storeId, rule.weekday, rule.start_minute, rule.duration_minutes,
        rule.disambiguation || 'compatible');
    }
    db.prepare('UPDATE stores SET hours_version = hours_version + 1, updated_at_ms = ? WHERE id = ?').run(now, storeId);
    db.prepare('DELETE FROM status_cache WHERE store_id = ?').run(storeId);
    regenerateStoreWindows(db, storeId, now);
    refreshStoreSessionAuth(db, storeId, now);
  });
  tx();
}

export function normalizeWeeklyRules(rules) {
  return rules.map(rule => {
    const weekday = Number(rule.weekday);
    const startClock = rule.startClock || rule.start || rule.startAt;
    const endClock = rule.endClock || rule.end || rule.endAt;
    const start = clockToMinutes(startClock);
    let end = clockToMinutes(endClock);
    let duration = end - start;
    // 22:00–02:00 等跨午夜：按持续时间处理，而不是把结束时刻截断到当天。
    if (duration <= 0) duration += 24 * 60;
    return {
      weekday,
      start_minute: start,
      duration_minutes: duration,
      disambiguation: rule.disambiguation || 'compatible'
    };
  }).filter(r => r.weekday >= 0 && r.weekday <= 6 && r.duration_minutes > 0 && r.duration_minutes <= 1440);
}

export function clockToMinutes(clock) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(clock));
  if (!m) throw new Error(`时分格式必须为 HH:mm：${clock}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) throw new Error(`非法时分：${clock}`);
  return hour * 60 + minute;
}

export function getStoreById(db, idValue) {
  return db.prepare(`SELECT s.*,
      COALESCE((SELECT SUM(seats_count) FROM store_seats WHERE store_id=s.id), 0) AS seat_total
    FROM stores s WHERE id = ?`).get(idValue);
}

export function storeTags(db, storeId) {
  return {
    themes: db.prepare('SELECT theme FROM store_themes WHERE store_id = ? ORDER BY theme').all(storeId).map(r => r.theme),
    seats: Object.fromEntries(db.prepare('SELECT seat_type, seats_count FROM store_seats WHERE store_id = ? ORDER BY seat_type')
      .all(storeId).map(r => [r.seat_type, r.seats_count])),
    aliases: db.prepare('SELECT alias FROM store_aliases WHERE store_id = ? ORDER BY alias').all(storeId).map(r => r.alias)
  };
}

function eventSessionStartEnd(store, date, startTime, endTime, disambiguation) {
  const startMinutes = clockToMinutes(startTime);
  const endMinutes = clockToMinutes(endTime);
  let durationMinutes = endMinutes - startMinutes;
  if (durationMinutes <= 0) durationMinutes += 24 * 60;
  const startWall = parseLocalDateTimeInput(date, startTime);
  const start = wallToUtcMs(store.timezone, startWall, { disambiguation });
  // 关键：结束点不独立换算。用“实际起点 + 挂钟持续时长”，
  // 这样春季跳字会顺延起点并保持时长，秋季重复时两个同名起点产生两个不同 UTC 场次。
  const endMs = start.value + durationMinutes * 60_000;
  return { start, endMs, endChoice: start.choice };
}

function crossMidnightEndSnapshot(store, date, endTime, times) {
  const wall = formatWall(store.timezone, times.endMs);
  return wall.slice(11) === endTime ? wall : `${wall.slice(0, 11)}${endTime}`;
}

function parseLocalDateTimeInput(date, clock) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error('日期必须为 YYYY-MM-DD');
  const c = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!c) throw new Error('时间必须为 HH:mm');
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(c[1]), minute: Number(c[2]) };
}

export function createEvent(db, data, now = Date.now()) {
  const store = getStoreById(db, data.storeId || data.store_id);
  if (!store || !store.active || store.merged_into_id) throw new Error('不能在已合并门店创建活动');
  const eventId = data.id || id('ev');
  const capacity = Number(data.capacity || 0);
  if (!(capacity > 0)) throw new Error('活动容量必须大于 0');
  db.prepare(`INSERT INTO events(id, store_id, title, description, theme, capacity, is_private, created_at_ms, updated_at_ms)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    eventId, store.id, data.title, data.description || '', data.theme || '其他',
    capacity, data.isPrivate ? 1 : 0, now, now
  );
  const sessionId = data.sessionId || id('es');
  const times = eventSessionStartEnd(store, data.date, data.startTime, data.endTime, data.disambiguation || 'compatible');
  const endLocalSnapshot = crossMidnightEndSnapshot(store, data.date, data.endTime, times);
  db.prepare(`INSERT INTO event_sessions(id, event_id, store_id, starts_ms, ends_ms,
      starts_local_snapshot, ends_local_snapshot, timezone_snapshot,
      dst_choice, dst_repeated, dst_gap, capacity, booked_count,
      closed_required, authorized, status, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 'active', ?, ?)`).run(
    sessionId, eventId, store.id, times.start.value, times.endMs,
    `${data.date} ${data.startTime}`, endLocalSnapshot,
    store.timezone, times.start.choice, times.start.repeated ? 1 : 0, times.start.gap ? 1 : 0,
    capacity, data.requireClosed ? 1 : 0, now, now
  );
  const session = db.prepare('SELECT * FROM event_sessions WHERE id = ?').get(sessionId);
  const updated = markSessionClosedState(db, session, now);
  return { event: db.prepare('SELECT * FROM events WHERE id = ?').get(eventId), session: updated };
}

export function markSessionClosedState(db, session, now = Date.now()) {
  const store = getStoreById(db, session.store_id);
  const digest = closureDigest(db, store, session.starts_ms, session.ends_ms);
  const fullyOpen = JSON.parse(digest).fully_open;
  const digestChanged = session.closure_digest && session.closure_digest !== digest;
  db.prepare(`UPDATE event_sessions
              SET closed_required = ?, closure_digest = ?,
                  authorized = CASE WHEN ? THEN 0 ELSE authorized END,
                  authorization_note = CASE WHEN ? THEN NULL ELSE authorization_note END,
                  authorized_by = CASE WHEN ? THEN NULL ELSE authorized_by END,
                  authorized_at_ms = CASE WHEN ? THEN NULL ELSE authorized_at_ms END,
                  updated_at_ms = ?
              WHERE id = ?`)
    .run(fullyOpen ? 0 : 1, digest, digestChanged ? 1 : 0, digestChanged ? 1 : 0,
      digestChanged ? 1 : 0, digestChanged ? 1 : 0, now, session.id);
  return db.prepare('SELECT * FROM event_sessions WHERE id = ?').get(session.id);
}

export function authorizeSession(db, sessionId, note, actor = 'admin', now = Date.now()) {
  const session = db.prepare('SELECT * FROM event_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('场次不存在');
  const marked = markSessionClosedState(db, session, now);
  if (!marked.closed_required) {
    throw new Error('该场次处于营业时段，无需闭店授权');
  }
  db.prepare(`UPDATE event_sessions SET authorized = 1, authorization_note = ?, authorized_by = ?,
              authorized_at_ms = ?, updated_at_ms = ? WHERE id = ?`)
    .run(note || '显式批准闭店专场', actor, now, now, sessionId);
  return db.prepare('SELECT * FROM event_sessions WHERE id = ?').get(sessionId);
}

export function bookSession(db, sessionId, body, now = Date.now()) {
  const seats = Number(body.seats || 1);
  if (!(seats > 0)) throw new Error('预订席位数必须大于 0');
  if (!body.contactName || !body.contactEmail) throw new Error('缺少联系人或邮箱');

  const tx = db.transaction(() => {
    const session = db.prepare(`SELECT es.*, e.title AS event_title, e.is_private
                                FROM event_sessions es JOIN events e ON e.id = es.event_id
                                WHERE es.id = ?`).get(sessionId);
    if (!session || session.status !== 'active') throw new Error('场次不存在或已取消');
    if (session.ends_ms <= now) throw new Error('活动已结束，不能报名');
    if (session.closed_required && !session.authorized) {
      throw new Error('闭店专场尚未显式授权，不能报名');
    }
    if (session.is_private && !session.authorized) throw new Error('私场尚未开放');
    if (session.booked_count + seats > session.capacity) {
      const left = Math.max(0, session.capacity - session.booked_count);
      const err = new Error(left === 0 ? '席位已满' : `仅剩 ${left} 席`);
      err.code = 'SEATS_FULL';
      err.remaining = left;
      throw err;
    }

    const bookingId = id('bk');
    const code = uniqueBookingCode(db);
    db.prepare(`UPDATE event_sessions SET booked_count = booked_count + ?, updated_at_ms = ? WHERE id = ?`)
      .run(seats, now, sessionId);
    const store = getStoreById(db, session.store_id);
    const updated = db.prepare('SELECT * FROM event_sessions WHERE id = ?').get(sessionId);
    const receipt = {
      code,
      booking_id: bookingId,
      actual_session: {
        session_id: sessionId,
        event_id: session.event_id,
        starts_ms: session.starts_ms,
        ends_ms: session.ends_ms,
        starts_local: session.starts_local_snapshot,
        ends_local: session.ends_local_snapshot,
        timezone: session.timezone_snapshot,
        dst_choice: session.dst_choice || undefined,
        dst_repeated: !!session.dst_repeated,
        dst_gap: !!session.dst_gap
      },
      store: {
        id: store.id,
        name: store.name,
        address: store.address,
        timezone: store.timezone
      },
      event_title: session.event_title,
      seats,
      contact: { name: body.contactName, email: body.contactEmail },
      issued_at_ms: now,
      closure_authorized: !!(session.closed_required && session.authorized)
    };
    db.prepare(`INSERT INTO bookings(id, code, session_id, contact_name, contact_email, seats,
        status, receipt_snapshot_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`)
      .run(bookingId, code, sessionId, body.contactName, body.contactEmail, seats,
        JSON.stringify(receipt), now);
    return {
      bookingId,
      code,
      sessionId,
      remaining: updated.capacity - updated.booked_count,
      receipt
    };
  });
  return tx();
}

function uniqueBookingCode(db) {
  for (let i = 0; i < 5; i++) {
    const code = shortCode();
    if (!db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code)) return code;
  }
  throw new Error('报名编号生成失败，请重试');
}

export function renameStore(db, storeId, newName, actor = 'admin', now = Date.now()) {
  const store = getStoreById(db, storeId);
  if (!store) throw new Error('门店不存在');
  const tx = db.transaction(() => {
    db.prepare('UPDATE store_name_history SET to_ms = ? WHERE store_id = ? AND to_ms IS NULL')
      .run(now, storeId);
    db.prepare('INSERT INTO store_name_history(store_id, name, from_ms) VALUES (?, ?, ?)')
      .run(storeId, newName, now);
    db.prepare('UPDATE stores SET name = ?, slug = ?, updated_at_ms = ? WHERE id = ?')
      .run(newName, uniqueSlug(db, newName), now, storeId);
    bumpCatalogVersion(db, `rename:${newName}`, storeId, 'rename',
      { from: store.name, to: newName, actor });
  });
  tx();
  return getStoreById(db, storeId);
}

export function mergeStores(db, sourceId, targetId, reason, now = Date.now()) {
  const source = getStoreById(db, sourceId);
  const target = getStoreById(db, targetId);
  if (!source || !target) throw new Error('门店不存在');
  if (sourceId === targetId) throw new Error('不能合并到自身');
  const tx = db.transaction(() => {
    db.prepare('UPDATE store_name_history SET to_ms = ? WHERE store_id = ? AND to_ms IS NULL')
      .run(now, sourceId);
    db.prepare('INSERT INTO store_aliases(store_id, alias) VALUES (?, ?)').run(targetId, source.name);
    for (const alias of db.prepare('SELECT alias FROM store_aliases WHERE store_id = ?').all(sourceId)) {
      db.prepare('INSERT OR IGNORE INTO store_aliases(store_id, alias) VALUES (?, ?)').run(targetId, alias.alias);
    }
    db.prepare(`INSERT OR IGNORE INTO store_themes(store_id, theme)
                SELECT ?, theme FROM store_themes WHERE store_id = ?`).run(targetId, sourceId);
    db.prepare(`DELETE FROM store_themes WHERE store_id = ?`).run(sourceId);
    db.prepare(`INSERT INTO store_seats(store_id, seat_type, seats_count)
                SELECT ?, seat_type, seats_count FROM store_seats WHERE store_id = ?
                ON CONFLICT(store_id, seat_type)
                DO UPDATE SET seats_count = store_seats.seats_count + excluded.seats_count`)
      .run(targetId, sourceId);
    db.prepare(`DELETE FROM store_seats WHERE store_id = ?`).run(sourceId);
    db.prepare(`UPDATE events SET store_id = ? WHERE store_id = ?`).run(targetId, sourceId);
    db.prepare(`UPDATE event_sessions SET store_id = ? WHERE store_id = ?`).run(targetId, sourceId);
    // 回执 JSON 不重写；它必须继续绑定报名时的实际场次和当时门店快照。
    db.prepare('UPDATE stores SET active = 0, merged_into_id = ?, merge_reason = ?, updated_at_ms = ? WHERE id = ?')
      .run(targetId, reason || '门店合并', now, sourceId);
    db.prepare(`INSERT INTO manual_corrections(store_id, correction_type, payload_json, applied_at_ms, catalog_version)
                VALUES (?, 'merge', ?, ?, (SELECT version_number FROM catalog_versions WHERE version=1))`)
      .run(sourceId, JSON.stringify({ source: sourceId, target: targetId, sourceName: source.name, targetName: target.name }), now);
    bumpCatalogVersion(db, `merge:${source.name}->${target.name}`, targetId, 'merge',
      { sourceId, targetId, reason });
  });
  tx();
  for (const session of db.prepare(`SELECT * FROM event_sessions WHERE store_id = ? AND status = 'active'`).all(targetId)) {
    markSessionClosedState(db, session, now);
  }
  return { source: getStoreById(db, sourceId), target: getStoreById(db, targetId) };
}

export function getOrCreateQueryVersion(db, filters, now = Date.now()) {
  const normalized = normalizeFilters(filters);
  const json = JSON.stringify(normalized);
  const catalogVersion = currentCatalogVersion(db);
  const existing = db.prepare(`SELECT * FROM query_versions
                               WHERE filters_json = ? AND catalog_version = ? AND expires_at_ms > ?`)
    .get(json, catalogVersion, now);
  if (existing) {
    db.prepare('UPDATE query_versions SET last_used_at_ms = ? WHERE id = ?').run(now, existing.id);
    return existing.id;
  }
  const qid = id('qv');
  db.prepare(`INSERT INTO query_versions(id, filters_json, catalog_version, created_at_ms, last_used_at_ms, expires_at_ms)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(qid, json, catalogVersion, now, now, now + 6 * 60 * 60 * 1000);
  return qid;
}

export function assertQueryVersion(db, qid, now = Date.now()) {
  if (!qid) throw Object.assign(new Error('缺少 queryId：地图聚合与列表必须使用同一查询版'), { code: 'QUERY_VERSION_REQUIRED' });
  const row = db.prepare('SELECT * FROM query_versions WHERE id = ?').get(qid);
  const current = currentCatalogVersion(db);
  if (!row) throw Object.assign(new Error('查询版不存在或已过期，请使用当前目录重新查询'), {
    code: 'QUERY_VERSION_STALE', currentVersion: current
  });
  if (row.catalog_version !== current) {
    throw Object.assign(new Error('目录已有手工更正，请刷新查询版'), {
      code: 'QUERY_VERSION_STALE', storedVersion: row.catalog_version, currentVersion: current
    });
  }
  if (row.expires_at_ms <= now) throw Object.assign(new Error('查询版已到期'), { code: 'QUERY_VERSION_STALE' });
  db.prepare('UPDATE query_versions SET last_used_at_ms = ? WHERE id = ?').run(now, qid);
  return JSON.parse(row.filters_json);
}

function filterList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(',');
}

export function normalizeFilters(input = {}) {
  const themes = filterList(input.themes || input.theme).map(s => String(s).trim()).filter(Boolean).sort();
  const seats = filterList(input.seatTypes || input.seat).map(s => String(s).trim()).filter(Boolean).sort();
  const includeClosedEvents = input.includeClosedEvents === true || input.includeClosedEvents === 'true';
  const bboxInput = filterList(input.bbox).length ? input.bbox : null;
  const bbox = bboxInput ? String(bboxInput).split(',').map(Number) : null;
  return {
    q: String(input.q || '').trim().slice(0, 120),
    city: String(input.city || '').trim(),
    themes,
    seatTypes: seats,
    openOnly: input.openOnly === true || input.openOnly === 'true',
    upcomingEvents: input.upcomingEvents === true || input.upcomingEvents === 'true',
    includeClosedEvents,
    bbox: bbox && bbox.length === 4 && bbox.every(Number.isFinite) ? bbox : null,
    lat: Number.isFinite(Number(input.lat)) ? Number(input.lat) : null,
    lng: Number.isFinite(Number(input.lng)) ? Number(input.lng) : null
  };
}
