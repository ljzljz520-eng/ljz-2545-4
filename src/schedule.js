'use strict';

const crypto = require('crypto');
const dbApi = require('./db');
const tz = require('./tz');

const DEFAULT_HORIZON_DAYS = 90;
const LOOKBACK_DAYS = 2;
const MAX_CACHE_MS = 5 * 60 * 1000;

function hashCanonical(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function activeStores() {
  return dbApi.all(
    `SELECT id, slug, name, lat, lng, time_zone AS timeZone, active
     FROM stores WHERE active = 1 AND merged_into_id IS NULL ORDER BY name`
  );
}

function getStore(storeId) {
  const s = dbApi.one(
    `SELECT id, slug, name, lat, lng, time_zone AS timeZone, active, merged_into_id AS mergedIntoId
     FROM stores WHERE id = ?`,
    [storeId]
  );
  if (!s) return null;
  s.themes = JSON.parse(dbApi.one('SELECT themes_json FROM stores WHERE id=?', [storeId]).themes_json);
  return s;
}

function localWeekday(dateText) {
  const { year, month, day } = tz.parseLocalDate(dateText);
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

function periodOccurrences(store, dateText, startMinute, endMinute) {
  const startHour = Math.floor(startMinute / 60);
  const startMin = startMinute % 60;
  const endHourRaw = Math.floor(endMinute / 60);
  const endMinRaw = endMinute % 60;
  const overnight = endMinute <= startMinute;
  const endDateText = overnight ? tz.addLocalDays(dateText, 1) : dateText;
  const endParts = tz.parseLocalDate(endDateText);
  const startParts = tz.parseLocalDate(dateText);
  const startWall = Date.UTC(startParts.year, startParts.month - 1, startParts.day, startHour, startMin);
  const endWall = Date.UTC(endParts.year, endParts.month - 1, endParts.day, endHourRaw, endMinRaw);
  const nominalDuration = endWall - startWall;
  const starts = tz.wallToUtcAll(startParts.year, startParts.month, startParts.day, startHour, startMin, store.timeZone).sort((a, b) => a - b);
  const ends = tz.wallToUtcAll(endParts.year, endParts.month, endParts.day, endHourRaw, endMinRaw, store.timeZone).sort((a, b) => a - b);
  const result = [];
  starts.forEach((startsAt, occurrenceIndex) => {
    // A civil interval [01:00,03:00) on a fall-back day has two meanings.
    // The first ends when the wall clock first reaches 03:00 after transition;
    // the second is another physical two-hour interval that also ends at 03:00.
    let endsAt;
    if (starts.length > 1) {
      endsAt = endWall - tz.offsetAt(startsAt + nominalDuration, store.timeZone);
    } else {
      endsAt = ends.find((candidate) => candidate > startsAt) ||
        ends.reduce((best, candidate) =>
          Math.abs(candidate - (startsAt + nominalDuration)) < Math.abs(best - (startsAt + nominalDuration)) ? candidate : best, ends[0]);
    }
    if (Number.isFinite(startsAt) && Number.isFinite(endsAt) && endsAt > startsAt) {
      result.push({ startsAt, endsAt });
    }
  });
  return result.sort((a, b) => a.startsAt - b.startsAt || a.endsAt - b.endsAt);
}

function startDateParts(dateText) {
  const p = tz.parseLocalDate(dateText);
  return [p.year, p.month - 1, p.day];
}

function exceptionsForDate(storeId, dateText) {
  return dbApi.all(
    `SELECT id, kind, start_minute AS startMinute, end_minute AS endMinute, reason
     FROM schedule_exceptions WHERE store_id=? AND local_date=? ORDER BY id`,
    [storeId, dateText]
  );
}

function weeklyPeriods(storeId, weekday) {
  return dbApi.all(
    `SELECT id, weekday, start_minute AS startMinute, end_minute AS endMinute, note
     FROM weekly_hours WHERE store_id=? AND weekday=? ORDER BY start_minute, id`,
    [storeId, weekday]
  );
}

function computeWindowsForDate(store, dateText) {
  const exceptions = exceptionsForDate(store.id, dateText);
  const closed = exceptions.some((e) => e.kind === 'closed');
  if (closed) return [];
  const modified = exceptions.filter((e) => e.kind === 'modified');
  const periods = modified.length
    ? modified.map((e) => ({ startMinute: e.startMinute, endMinute: e.endMinute, exceptionId: e.id }))
    : weeklyPeriods(store.id, localWeekday(dateText));
  const windows = [];
  for (const period of periods) {
    for (const occurrence of periodOccurrences(store, dateText, period.startMinute, period.endMinute)) {
      windows.push({
        ...occurrence,
        anchorLocalDate: dateText,
        weekday: localWeekday(dateText),
        source: modified.length ? 'exception' : 'weekly'
      });
    }
  }
  return windows;
}

function computeWindowRange(store, startDate, endDate) {
  const dates = tz.eachLocalDate(startDate, endDate);
  return dates.flatMap((date) => computeWindowsForDate(store, date));
}

async function regenerateSchedules(now = Date.now(), options = {}) {
  const horizonDays = options.horizonDays || DEFAULT_HORIZON_DAYS;
  return dbApi.withWrite((ctx) => regenerateSchedulesInTx(ctx, now, { ...options, horizonDays }));
}

function regenerateSchedulesInTx(ctx, now = Date.now(), options = {}) {
  const horizonDays = options.horizonDays || DEFAULT_HORIZON_DAYS;
  const stores = ctx.all(
    `SELECT id, slug, name, time_zone AS timeZone
     FROM stores WHERE active=1 AND merged_into_id IS NULL ORDER BY id`
  );
  let earliestHorizonEnd = Infinity;
  for (const store of stores) {
    const currentLocalDate = tz.localDate(now, store.timeZone);
    const startDate = tz.addLocalDays(currentLocalDate, -LOOKBACK_DAYS);
    const endDate = tz.addLocalDays(currentLocalDate, horizonDays);
    ctx.run('DELETE FROM business_windows WHERE store_id=?', [store.id]);
    const windows = withScheduleContext(ctx, () => computeWindowRange(store, startDate, endDate));
    const scheduleVersion = Number(ctx.getMeta('schedule_version', '0'));
    for (const w of windows) {
      ctx.run(
        `INSERT INTO business_windows
          (store_id, anchor_local_date, starts_at, ends_at, kind, source, weekday, schedule_version)
         VALUES (?,?,?,?, 'open', ?, ?, ?)`,
        [store.id, w.anchorLocalDate, w.startsAt, w.endsAt, w.source, w.weekday, scheduleVersion]
      );
    }
    const endParts = tz.parseLocalDate(endDate);
    const horizonEndLocal = tz.wallToUtc(endParts.year, endParts.month, endParts.day, 0, 0, store.timeZone);
    earliestHorizonEnd = Math.min(earliestHorizonEnd, horizonEndLocal);
  }
  ctx.setMeta('schedule_horizon_epoch', String(Math.floor(earliestHorizonEnd)));
  refreshEventAuthorizationsInTx(ctx, now);
  if (options.bumpVersion) {
    const next = ctx.bumpMeta('schedule_version');
    ctx.run('UPDATE business_windows SET schedule_version=?', [next]);
    invalidateQueryVersionsInTx(ctx, now, 'schedule corrected');
  }
  return { stores: stores.length, horizonEpoch: Math.floor(earliestHorizonEnd) };
}

async function ensureSchedules(now = Date.now()) {
  const target = now + (DEFAULT_HORIZON_DAYS - 7) * 86400000;
  const horizon = Number(dbApi.getMeta('schedule_horizon_epoch', '0'));
  if (horizon < target) {
    return regenerateSchedules(now, { bumpVersion: false });
  }
  return { extended: false, horizonEpoch: horizon };
}

function findWindowAt(windows, at) {
  return windows.find((w) => w.startsAt <= at && at < w.endsAt) || null;
}

function findNextWindow(windows, at) {
  return windows.filter((w) => w.startsAt > at).sort((a, b) => a.startsAt - b.startsAt)[0] || null;
}

function liveStatus(storeId, at = Date.now()) {
  const store = getStore(storeId);
  if (!store || !store.active || store.mergedIntoId) {
    return { isOpen: false, reason: 'inactive', current: null, next: null, stateChangedAt: null, source: 'live' };
  }
  const anchor = tz.localDate(at, store.timeZone);
  let windows = [
    tz.addLocalDays(anchor, -1),
    anchor,
    tz.addLocalDays(anchor, 1),
    tz.addLocalDays(anchor, 2)
  ].flatMap((date) => computeWindowsForDate(store, date));
  windows = windows.sort((a, b) => a.startsAt - b.startsAt);
  const current = findWindowAt(windows, at);
  const next = findNextWindow(windows, at);
  return {
    isOpen: Boolean(current),
    current: current ? serializeWindow(current) : null,
    next: next ? serializeWindow(next) : null,
    stateChangedAt: current ? current.endsAt : next ? next.startsAt : null,
    source: 'live-computed'
  };
}

function pregeneratedStatus(storeId, at = Date.now()) {
  const current = dbApi.one(
    `SELECT * FROM business_windows WHERE store_id=? AND starts_at <= ? AND ends_at > ? LIMIT 1`,
    [storeId, at, at]
  );
  const next = dbApi.one(
    `SELECT * FROM business_windows WHERE store_id=? AND starts_at > ? ORDER BY starts_at LIMIT 1`,
    [storeId, at]
  );
  return {
    isOpen: Boolean(current),
    current: current ? serializeWindow(current) : null,
    next: next ? serializeWindow(next) : null,
    stateChangedAt: current ? current.endsAt : next ? next.startsAt : null,
    source: 'pregenerated-window'
  };
}

async function getStatusWithComparison(storeId, at = Date.now()) {
  await ensureSchedules(at);
  const live = liveStatus(storeId, at);
  const pregenerated = pregeneratedStatus(storeId, at);
  const initialMatches = statusesEqual(live, pregenerated);
  let repaired = false;
  let finalLive = live;
  let finalPregenerated = pregenerated;
  if (!initialMatches) {
    await regenerateSchedules(at, { bumpVersion: false });
    repaired = true;
    finalLive = liveStatus(storeId, at);
    finalPregenerated = pregeneratedStatus(storeId, at);
  }
  return {
    ...finalLive,
    pregenerated: finalPregenerated,
    comparison: { matches: statusesEqual(finalLive, finalPregenerated), repaired, checkedAt: at }
  };
}

function statusesEqual(a, b) {
  if (a.isOpen !== b.isOpen) return false;
  const sig = (w) => w ? `${w.startsAt}/${w.endsAt}` : '';
  return sig(a.current) === sig(b.current) && sig(a.next) === sig(b.next);
}

function serializeWindow(w) {
  return {
    startsAt: w.starts_at ?? w.startsAt,
    endsAt: w.ends_at ?? w.endsAt,
    anchorLocalDate: w.anchor_local_date ?? w.anchorLocalDate,
    source: w.source,
    weekday: w.weekday
  };
}

function openWindowsAround(storeId, startsAt, endsAt) {
  const store = getStore(storeId);
  if (!store) return [];
  const startDate = tz.localDate(startsAt - 86400000, store.timeZone);
  const endDate = tz.localDate(endsAt + 86400000, store.timeZone);
  return computeWindowRange(store, startDate, endDate)
    .filter((w) => w.endsAt > startsAt && w.startsAt < endsAt)
    .sort((a, b) => a.startsAt - b.startsAt);
}

function overlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function eventScheduleFingerprint(storeId, startsAt, endsAt) {
  const store = getStore(storeId);
  const dates = [
    tz.localDate(startsAt - 86400000, store.timeZone),
    tz.localDate(startsAt, store.timeZone),
    tz.localDate(endsAt, store.timeZone),
    tz.localDate(endsAt + 86400000, store.timeZone)
  ];
  const uniqueDates = [...new Set(dates)].sort();
  const rules = dbApi.all(
    `SELECT weekday, start_minute, end_minute FROM weekly_hours WHERE store_id=? ORDER BY weekday,start_minute,end_minute`,
    [storeId]
  );
  const exceptions = dbApi.all(
    `SELECT local_date, kind, start_minute, end_minute, reason
     FROM schedule_exceptions WHERE store_id=? AND local_date BETWEEN ? AND ?
     ORDER BY local_date, kind, start_minute, end_minute`,
    [storeId, uniqueDates[0], uniqueDates[uniqueDates.length - 1]]
  );
  return hashCanonical({ timeZone: store.timeZone, rules, exceptions });
}

function assessClosedEvent(event) {
  const windows = openWindowsAround(event.store_id ?? event.storeId, event.starts_at ?? event.startsAt, event.ends_at ?? event.endsAt);
  const start = event.starts_at ?? event.startsAt;
  const end = event.ends_at ?? event.endsAt;
  const duration = end - start;
  let covered = 0;
  for (const w of windows) covered += overlapMs(start, end, w.startsAt, w.endsAt);
  const storeId = event.store_id ?? event.storeId;
  const fingerprint = eventScheduleFingerprint(storeId, start, end);
  let access = 'open';
  if (covered <= 0) access = 'closed';
  else if (covered < duration) access = 'mixed';
  const authorization = dbApi.one(
    `SELECT id, fingerprint, granted_at AS grantedAt, granted_by AS grantedBy, note
     FROM event_closed_authorizations WHERE event_id=? AND fingerprint=?`,
    [event.id, fingerprint]
  );
  return {
    access,
    requiresAuthorization: access !== 'open',
    coveredMs: covered,
    closedMs: duration - covered,
    fingerprint,
    authorized: Boolean(authorization),
    authorization: authorization || null
  };
}

function refreshEventAuthorizationsInTx(ctx, now = Date.now()) {
  const events = ctx.all(`SELECT * FROM event_sessions WHERE status='scheduled' AND ends_at >= ?`, [now - 30 * 86400000]);
  for (const event of events) {
    // Temporarily use the context-bound db module API through closures below.
    const assessment = assessEventWithContext(ctx, event);
    ctx.run(
      `UPDATE event_sessions
       SET requires_closed_authorization=?, closed_fingerprint=?, updated_at=?
       WHERE id=?`,
      [assessment.requiresAuthorization ? 1 : 0, assessment.requiresAuthorization ? assessment.fingerprint : null, now, event.id]
    );
  }
}

function assessEventWithContext(ctx, event) {
  const originalAll = dbApi.all;
  const originalOne = dbApi.one;
  // The module-level helpers use dbApi; swap for this synchronous transaction only.
  dbApi.all = ctx.all;
  dbApi.one = ctx.one;
  try {
    return assessClosedEvent(event);
  } finally {
    dbApi.all = originalAll;
    dbApi.one = originalOne;
  }
}

function withScheduleContext(ctx, worker) {
  const originalAll = dbApi.all;
  const originalOne = dbApi.one;
  dbApi.all = ctx.all;
  dbApi.one = ctx.one;
  try {
    return worker();
  } finally {
    dbApi.all = originalAll;
    dbApi.one = originalOne;
  }
}

function invalidateQueryVersionsInTx(ctx, now, reason) {
  ctx.run(
    `UPDATE query_versions SET invalidated_at=?, invalid_reason=COALESCE(invalid_reason, ?)
     WHERE invalidated_at IS NULL`,
    [now, reason]
  );
}

async function ensureStatusConsistency(now = Date.now()) {
  await ensureSchedules(now);
  const stores = activeStores();
  const compareAll = () => stores.map((store) => ({
    storeId: store.id,
    live: liveStatus(store.id, now),
    pregenerated: pregeneratedStatus(store.id, now)
  })).filter((x) => !statusesEqual(x.live, x.pregenerated));
  let mismatches = compareAll();
  let repaired = false;
  if (mismatches.length) {
    await regenerateSchedules(now, { bumpVersion: false });
    repaired = true;
    mismatches = compareAll();
  }
  return { checked: stores.length, mismatches: mismatches.length, repaired, mismatchIds: mismatches.map((x) => x.storeId) };
}

function cacheExpiryForStatuses(now, statuses) {
  const transitions = statuses
    .map((s) => Number(s.stateChangedAt))
    .filter((n) => Number.isFinite(n) && n > now)
    .sort((a, b) => a - b);
  const next = transitions[0] ? transitions[0] + 1000 : now + MAX_CACHE_MS;
  return Math.min(now + MAX_CACHE_MS, Math.max(now + 1000, next));
}

module.exports = {
  MAX_CACHE_MS,
  assessClosedEvent,
  cacheExpiryForStatuses,
  computeWindowsForDate,
  ensureSchedules,
  ensureStatusConsistency,
  eventScheduleFingerprint,
  getStatusWithComparison,
  getStore,
  invalidateQueryVersionsInTx,
  liveStatus,
  openWindowsAround,
  periodOccurrences,
  pregeneratedStatus,
  regenerateSchedules,
  regenerateSchedulesInTx,
  serializeWindow,
  statusesEqual,
  withScheduleContext
};
