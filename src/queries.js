'use strict';

const crypto = require('crypto');
const dbApi = require('./db');
const schedule = require('./schedule');
const tz = require('./tz');

const PAGE_SIZE_DEFAULT = 6;
const responseCache = new Map();

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function parseNumber(value, name, { min = -Infinity, max = Infinity, optional = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    const err = new Error(`${name} 必填`);
    err.statusCode = 400;
    throw err;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    const err = new Error(`${name} 无效`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function normalizeFilters(input = {}) {
  const themes = (Array.isArray(input.themes) ? input.themes : String(input.themes || '').split(','))
    .map((x) => String(x).trim()).filter(Boolean);
  const seatFeatures = (Array.isArray(input.seatFeatures) ? input.seatFeatures : String(input.seatFeatures || '').split(','))
    .map((x) => String(x).trim()).filter(Boolean);
  const seatTypes = (Array.isArray(input.seatTypes) ? input.seatTypes : String(input.seatTypes || '').split(','))
    .map((x) => String(x).trim()).filter(Boolean);
  const bbox = input.bbox ? normalizeBbox(input.bbox) : undefined;
  return {
    q: String(input.q || '').trim().slice(0, 120),
    themes: [...new Set(themes)].sort(),
    seatFeatures: [...new Set(seatFeatures)].sort(),
    seatTypes: [...new Set(seatTypes)].sort(),
    minSeats: parseNumber(input.minSeats, 'minSeats', { min: 1, max: 10000 }),
    openNow: Boolean(input.openNow),
    eventFrom: parseNumber(input.eventFrom, 'eventFrom', { min: 0, max: 4102444800000 }),
    eventTo: parseNumber(input.eventTo, 'eventTo', { min: 0, max: 4102444800000 }),
    eventTitle: String(input.eventTitle || '').trim().slice(0, 120),
    authorizedClosedEvents: Boolean(input.authorizedClosedEvents),
    bbox
  };
}

function normalizeBbox(input) {
  let arr = input;
  if (typeof input === 'string') arr = input.split(',').map(Number);
  if (!Array.isArray(arr) || arr.length !== 4 || arr.some((n) => !Number.isFinite(n))) {
    const err = new Error('bbox 必须是 [west,south,east,north]');
    err.statusCode = 400;
    throw err;
  }
  const [west, south, east, north] = arr;
  if (west >= east || south >= north || south < -90 || north > 90 || west < -180 || east > 180) {
    const err = new Error('bbox 经纬度范围无效');
    err.statusCode = 400;
    throw err;
  }
  return { west, south, east, north };
}

function filtersSignature(filters) {
  // bbox changes only the map view; it must not fork list/map query versions.
  const { bbox, ...versioned } = filters;
  return crypto.createHash('sha256').update(stableStringify(versioned)).digest('hex').slice(0, 24);
}

function hydrateStore(row) {
  return {
    ...row,
    themes: JSON.parse(row.themes_json),
    seats: JSON.parse(row.seats_json),
    nameHistory: JSON.parse(row.name_history)
  };
}

function totalSeats(store) {
  return store.seats.reduce((sum, s) => sum + Number(s.count || 0), 0);
}

function hasSeatFilter(store, filters) {
  if (filters.minSeats && totalSeats(store) < filters.minSeats) return false;
  if (filters.seatTypes.length) {
    const types = new Set(store.seats.map((s) => s.type));
    if (!filters.seatTypes.every((t) => types.has(t))) return false;
  }
  if (filters.seatFeatures.length) {
    const available = new Set(store.seats.flatMap((s) => s.features || []));
    if (!filters.seatFeatures.every((f) => available.has(f))) return false;
  }
  return true;
}

function hasThemeFilter(store, wanted) {
  if (!wanted.length) return true;
  const set = new Set(store.themes);
  return wanted.every((t) => set.has(t));
}

function eventVisibleInFilters(event, filters) {
  if (event.status !== 'scheduled') return false;
  if (filters.eventFrom && event.starts_at < filters.eventFrom) return false;
  if (filters.eventTo && event.ends_at > filters.eventTo) return false;
  if (filters.eventTitle && !event.title.toLowerCase().includes(filters.eventTitle.toLowerCase())) return false;
  if (filters.authorizedClosedEvents) {
    if (!event.requires_closed_authorization) return false;
    const auth = dbApi.one(
      `SELECT id FROM event_closed_authorizations WHERE event_id=? AND fingerprint=?`,
      [event.id, event.closed_fingerprint]
    );
    if (!auth) return false;
  }
  return true;
}

function findMatchingEvents(storeId, filters) {
  if (!filters.eventFrom && !filters.eventTo && !filters.eventTitle && !filters.authorizedClosedEvents) return [];
  const from = filters.eventFrom || 0;
  const to = filters.eventTo || 4102444800000;
  const events = dbApi.all(
    `SELECT * FROM event_sessions
     WHERE store_id=? AND status='scheduled' AND ends_at >= ? AND starts_at <= ?
     ORDER BY starts_at`,
    [storeId, from, to]
  );
  return events.filter((e) => eventVisibleInFilters(e, filters));
}

async function createOrReuseQueryVersion(rawFilters, now = Date.now()) {
  const filters = normalizeFilters(rawFilters);
  await schedule.ensureStatusConsistency(now);
  const signature = filtersSignature(filters);
  const existing = dbApi.one(
    `SELECT * FROM query_versions
     WHERE filter_signature=? AND invalidated_at IS NULL AND expires_at > ?
     ORDER BY generated_at DESC LIMIT 1`,
    [signature, now]
  );
  if (existing) return loadVersion(existing.id);

  return dbApi.transaction((ctx) => {
    const locked = ctx.one(
      `SELECT * FROM query_versions
       WHERE filter_signature=? AND invalidated_at IS NULL AND expires_at > ?
       ORDER BY generated_at DESC LIMIT 1`,
      [signature, now]
    );
    if (locked) return loadVersion(locked.id, ctx);

    const rows = ctx.all(
      `SELECT * FROM stores WHERE active=1 AND merged_into_id IS NULL ORDER BY name, id`
    ).map(hydrateStore);
    const statuses = [];
    const matches = [];
    for (const store of rows) {
      const text = `${store.name} ${store.description} ${store.address} ${store.themes.join(' ')}`.toLowerCase();
      if (filters.q && !text.includes(filters.q.toLowerCase())) continue;
      if (!hasThemeFilter(store, filters)) continue;
      if (!hasSeatFilter(store, filters)) continue;
      const events = findMatchingEvents(store.id, filters);
      if ((filters.eventFrom || filters.eventTo || filters.eventTitle || filters.authorizedClosedEvents) && !events.length) continue;
      const status = schedule.liveStatus(store.id, now);
      const pre = schedule.pregeneratedStatus(store.id, now);
      const comparisonMatches = schedule.statusesEqual(status, pre);
      if (filters.openNow && !status.isOpen) continue;
      statuses.push(status);
      const rank = scoreStore(store, status, events, filters);
      matches.push({ store, status, events, comparisonMatches, rank });
    }

    const id = `qv_${crypto.randomBytes(10).toString('hex')}`;
    const dataVersion = Number(ctx.getMeta('data_version', '0'));
    const scheduleVersion = Number(ctx.getMeta('schedule_version', '0'));
    const expiresAt = schedule.cacheExpiryForStatuses(now, statuses);
    ctx.run(
      `INSERT INTO query_versions
        (id, filters_json, filter_signature, data_version, schedule_version,
         generated_at, expires_at, last_match_count)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, JSON.stringify(filters), signature, dataVersion, scheduleVersion, now, expiresAt, matches.length]
    );
    for (const m of matches) {
      const snapshot = {
        id: m.store.id,
        slug: m.store.slug,
        name: m.store.name,
        address: m.store.address,
        lat: m.store.lat,
        lng: m.store.lng,
        timeZone: m.store.time_zone,
        themes: m.store.themes,
        seats: m.store.seats,
        totalSeats: totalSeats(m.store)
      };
      ctx.run(
        `INSERT INTO query_store_matches
          (query_version_id, store_id, rank_score, status_at_generation, state_changed_at, store_snapshot_json)
         VALUES (?,?,?,?,?,?)`,
        [id, m.store.id, m.rank, m.status.isOpen ? 'open' : 'closed', m.status.stateChangedAt, JSON.stringify(snapshot)]
      );
      for (const event of m.events) {
        const assessment = schedule.assessClosedEvent(event);
        ctx.run(
          `INSERT INTO query_event_matches(query_version_id, event_id, store_id, rank_score, event_snapshot_json)
           VALUES (?,?,?,?,?)`,
          [id, event.id, m.store.id, event.starts_at, JSON.stringify(serializeEvent(event, assessment))]
        );
      }
    }
    return loadVersion(id, ctx);
  });
}

function scoreStore(store, status, events, filters) {
  let score = 1000;
  if (status.isOpen) score += 20;
  if (filters.q && store.name.toLowerCase().includes(filters.q.toLowerCase())) score += 50;
  if (events.length) score += 10;
  score -= totalSeats(store) / 10000;
  return score;
}

function serializeEvent(event, assessment) {
  return {
    id: event.id,
    storeId: event.store_id,
    title: event.title,
    description: event.description,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    capacity: event.capacity,
    remaining: event.remaining,
    status: event.status,
    requiresClosedAuthorization: Boolean(event.requires_closed_authorization),
    closedFingerprint: event.closed_fingerprint,
    access: assessment ? assessment.access : undefined,
    authorized: assessment ? assessment.authorized : undefined
  };
}

function loadVersion(id, ctx = dbApi) {
  const qv = ctx.one(`SELECT * FROM query_versions WHERE id=?`, [id]);
  if (!qv) {
    const err = new Error('查询版不存在');
    err.statusCode = 404;
    err.code = 'QUERY_VERSION_NOT_FOUND';
    throw err;
  }
  qv.filters = JSON.parse(qv.filters_json);
  return qv;
}

function assertUsable(qv, now = Date.now()) {
  if (qv.invalidated_at) {
    const err = new Error(qv.invalid_reason || '查询版已被手工更正传播失效');
    err.statusCode = 410;
    err.code = 'QUERY_VERSION_INVALIDATED';
    err.generatedAt = qv.generated_at;
    err.expiresAt = qv.expires_at;
    err.invalidatedAt = qv.invalidated_at;
    throw err;
  }
  if (qv.expires_at <= now) {
    const err = new Error('查询版已到期，请用当前数据重建');
    err.statusCode = 410;
    err.code = 'QUERY_VERSION_EXPIRED';
    err.generatedAt = qv.generated_at;
    err.expiresAt = qv.expires_at;
    throw err;
  }
}

function cached(key, ttl, producer) {
  const old = responseCache.get(key);
  if (old && old.expiresAt > Date.now()) return old.value;
  const value = producer();
  responseCache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

function listMatches(id, { page = 1, pageSize = PAGE_SIZE_DEFAULT, bbox: rawBbox, now = Date.now() } = {}) {
  const qv = loadVersion(id);
  assertUsable(qv, now);
  page = Math.max(1, Number(page) || 1);
  pageSize = Math.min(50, Math.max(1, Number(pageSize) || PAGE_SIZE_DEFAULT));
  const bbox = rawBbox ? normalizeBbox(rawBbox) : qv.filters.bbox;
  const rows = dbApi.all(
    `SELECT * FROM query_store_matches WHERE query_version_id=? ORDER BY rank_score DESC, store_id`,
    [id]
  );
  let items = rows.map((r) => ({
    ...JSON.parse(r.store_snapshot_json),
    statusAtGeneration: r.status_at_generation,
    stateChangedAt: r.state_changed_at
  }));
  if (bbox) items = items.filter((s) => s.lat >= bbox.south && s.lat <= bbox.north && s.lng >= bbox.west && s.lng <= bbox.east);
  const total = items.length;
  const start = (page - 1) * pageSize;
  return envelope(qv, {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items: items.slice(start, start + pageSize)
  });
}

function clusterKey(value, step) {
  return Math.round(value / step);
}

function mapClusters(id, { bbox: rawBbox, zoom = 3, now = Date.now() } = {}) {
  const qv = loadVersion(id);
  assertUsable(qv, now);
  zoom = Math.min(12, Math.max(0, Number(zoom) || 3));
  const bbox = rawBbox ? normalizeBbox(rawBbox) : qv.filters.bbox;
  const rows = dbApi.all(
    `SELECT * FROM query_store_matches WHERE query_version_id=? ORDER BY rank_score DESC, store_id`,
    [id]
  );
  let stores = rows.map((r) => ({ ...JSON.parse(r.store_snapshot_json), statusAtGeneration: r.status_at_generation }));
  if (bbox) stores = stores.filter((s) => s.lat >= bbox.south && s.lat <= bbox.north && s.lng >= bbox.west && s.lng <= bbox.east);
  const step = Math.max(0.25, 40 / Math.pow(2, zoom));
  const groups = new Map();
  for (const s of stores) {
    const x = clusterKey(s.lng, step);
    const y = clusterKey(s.lat, step);
    const key = `${x}:${y}`;
    if (!groups.has(key)) groups.set(key, { x, y, stores: [] });
    groups.get(key).stores.push(s);
  }
  const clusters = [...groups.values()].map((g) => {
    const count = g.stores.length;
    const lat = g.stores.reduce((sum, s) => sum + s.lat, 0) / count;
    const lng = g.stores.reduce((sum, s) => sum + s.lng, 0) / count;
    const open = g.stores.filter((s) => s.statusAtGeneration === 'open').length;
    const seats = g.stores.reduce((sum, s) => sum + s.totalSeats, 0);
    return {
      lat,
      lng,
      count,
      openCount: open,
      closedCount: count - open,
      totalSeats: seats,
      storeIds: count <= 3 ? g.stores.map((s) => s.id) : undefined,
      single: count === 1 ? g.stores[0] : undefined
    };
  });
  return envelope(qv, { zoom, bbox: bbox || null, clusters });
}

function eventMatches(id, now = Date.now()) {
  const qv = loadVersion(id);
  assertUsable(qv, now);
  const rows = dbApi.all(
    `SELECT q.event_snapshot_json AS snapshot,
            e.remaining AS live_remaining,
            e.status AS live_status,
            e.session_version AS live_session_version
     FROM query_event_matches q
     JOIN event_sessions e ON e.id = q.event_id
     WHERE q.query_version_id=? ORDER BY q.rank_score, q.event_id`,
    [id]
  );
  return envelope(qv, {
    events: rows.map((r) => ({
      ...JSON.parse(r.snapshot),
      remaining: r.live_remaining,
      liveStatus: r.live_status,
      sessionVersion: r.live_session_version
    }))
  });
}

function envelope(qv, data) {
  return {
    queryVersionId: qv.id,
    generatedAt: qv.generated_at,
    expiresAt: qv.expires_at,
    dataVersion: qv.data_version,
    scheduleVersion: qv.schedule_version,
    ...data
  };
}

function pruneResponseCache() {
  const now = Date.now();
  for (const [key, val] of responseCache) if (val.expiresAt <= now) responseCache.delete(key);
}

setInterval(pruneResponseCache, 60000).unref?.();

module.exports = {
  createOrReuseQueryVersion,
  envelope,
  eventMatches,
  filtersSignature,
  listMatches,
  mapClusters,
  normalizeBbox,
  normalizeFilters,
  responseCache
};
