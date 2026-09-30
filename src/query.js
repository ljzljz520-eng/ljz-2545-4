import { getStoreStatus } from './schedule.js';
import { assertQueryVersion, getOrCreateQueryVersion, normalizeFilters, storeTags } from './repositories.js';
import { currentCatalogVersion } from './db.js';

const PAGE_SIZE_DEFAULT = 12;

function baseStoreSql(filters, { count = false } = {}) {
  const where = [`s.active = 1`, `s.merged_into_id IS NULL`];
  const params = {};
  if (filters.city) {
    where.push(`s.city = @city`);
    params.city = filters.city;
  }
  if (filters.q) {
    where.push(`(
      s.name LIKE @like OR
      s.description LIKE @like OR
      EXISTS (SELECT 1 FROM store_aliases a WHERE a.store_id = s.id AND a.alias LIKE @like) OR
      EXISTS (SELECT 1 FROM store_themes t WHERE t.store_id = s.id AND t.theme LIKE @like)
    )`);
    params.like = `%${filters.q}%`;
  }
  if (filters.themes.length) {
    where.push(`(${filters.themes.map((_, i) => `EXISTS (SELECT 1 FROM store_themes ft${i}
       WHERE ft${i}.store_id=s.id AND ft${i}.theme=@theme${i})`).join(' OR ')})`);
    filters.themes.forEach((t, i) => { params[`theme${i}`] = t; });
  }
  if (filters.seatTypes.length) {
    where.push(`(${filters.seatTypes.map((_, i) => `COALESCE((SELECT seats_count FROM store_seats fs${i}
       WHERE fs${i}.store_id=s.id AND fs${i}.seat_type=@seat${i}), 0) > 0`).join(' OR ')})`);
    filters.seatTypes.forEach((t, i) => { params[`seat${i}`] = t; });
  }
  if (filters.bbox) {
    const [minLng, minLat, maxLng, maxLat] = filters.bbox;
    where.push(`s.lat BETWEEN @minLat AND @maxLat AND s.lng BETWEEN @minLng AND @maxLng`);
    Object.assign(params, { minLat, maxLat, minLng, maxLng });
  }
  const select = count ? 'SELECT COUNT(DISTINCT s.id) AS total' : `
    SELECT DISTINCT s.*, COALESCE((SELECT SUM(seats_count) FROM store_seats WHERE store_id=s.id),0) AS seat_total`;
  return { sql: `${select} FROM stores s WHERE ${where.join(' AND ')}`, params };
}

function searchCandidateIds(db, filters) {
  const { sql, params } = baseStoreSql(filters);
  return db.prepare(`${sql} ORDER BY s.city, s.name, s.id`).all(params).map(r => r.id);
}

export function createQuery(db, rawFilters, now = Date.now()) {
  const filters = normalizeFilters(rawFilters);
  const queryId = getOrCreateQueryVersion(db, filters, now);
  return {
    queryId,
    catalogVersion: currentCatalogVersion(db),
    filters,
    expiresAtMs: now + 6 * 60 * 60 * 1000
  };
}

function decorateStore(db, store, now, includeDebug = false, statusOptions = {}) {
  const tags = storeTags(db, store.id);
  const status = getStoreStatus(db, store.id, now, statusOptions);
  const upcoming = upcomingSessions(db, store.id, now, 3);
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    city: store.city,
    address: store.address,
    lat: store.lat,
    lng: store.lng,
    timezone: store.timezone,
    description: store.description,
    themes: tags.themes,
    seats: tags.seats,
    seatTotal: store.seat_total,
    aliases: tags.aliases,
    status: {
      state: status.state,
      asOf: status.as_of_ms,
      computedAt: status.computed_at_ms,
      nextChange: status.next_change_ms,
      cacheExpiresAt: status.cache_expires_at_ms,
      cache: status.cache,
      historical: !!status.historical,
      current: !status.historical
    },
    upcomingEvents: upcoming,
    ...(includeDebug ? { debug: { status, hoursVersion: store.hours_version } } : {})
  };
}

function serializeSession(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    storeId: row.store_id,
    title: row.event_title,
    theme: row.theme,
    isPrivate: !!row.is_private,
    startsAt: row.starts_ms,
    endsAt: row.ends_ms,
    startsLocal: row.starts_local_snapshot,
    endsLocal: row.ends_local_snapshot,
    timezone: row.timezone_snapshot,
    dstChoice: row.dst_choice,
    dstRepeated: !!row.dst_repeated,
    dstGap: !!row.dst_gap,
    capacity: row.capacity,
    bookedCount: row.booked_count,
    remaining: row.capacity - row.booked_count,
    closedRequired: !!row.closed_required,
    authorized: !!row.authorized,
    bookable: row.status === 'active' &&
      !(!!row.closed_required && !row.authorized) &&
      row.booked_count < row.capacity,
    status: row.status
  };
}

export function serializeSessionPublic(row) { return serializeSession(row); }

function sessionVisibility(row, filters, now) {
  if (row.status !== 'active' || row.ends_ms <= now) return false;
  if (filters.themes.length && !filters.themes.includes(row.theme)) return false;
  if (filters.includeClosedEvents) return true;
  if (row.closed_required && !row.authorized) return false;
  return true;
}

function candidateIdsWithEvents(db, filters, ids, now) {
  if (!filters.upcomingEvents) return ids;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT DISTINCT es.store_id FROM event_sessions es
    JOIN events e ON e.id=es.event_id
    WHERE es.store_id IN (${placeholders}) AND es.status='active' AND es.ends_ms > ?
    ORDER BY es.store_id`).all(...ids, now);
  const visible = new Set(ids);
  return rows.filter(r => {
    const session = db.prepare(`SELECT es.*, e.title AS event_title, e.theme, e.is_private
                                FROM event_sessions es JOIN events e ON e.id=es.event_id
                                WHERE es.store_id=? AND es.status='active' AND es.ends_ms > ?
                                ORDER BY es.starts_ms LIMIT 1`).get(r.store_id, now);
    return sessionVisibility(session, filters, now);
  }).map(r => r.store_id).filter(idValue => visible.has(idValue));
}

export function searchStores(db, queryId, rawPage = {}, now = Date.now(), options = {}) {
  const statusOptions = options.explicitAsOf
    ? { explicitAsOf: true, referenceNow: options.referenceNow || now }
    : {};
  const filters = assertQueryVersion(db, queryId, now);
  const page = Math.max(1, Number(rawPage.page || 1));
  const pageSize = Math.min(50, Math.max(1, Number(rawPage.pageSize || PAGE_SIZE_DEFAULT)));
  const candidateIds = searchCandidateIds(db, filters);
  let decorated = candidateIds.map(idValue => {
    const store = db.prepare(`SELECT s.*, COALESCE((SELECT SUM(seats_count) FROM store_seats
      WHERE store_id=s.id),0) AS seat_total FROM stores s WHERE s.id=?`).get(idValue);
    return decorateStore(db, store, now, false, statusOptions);
  });
  if (filters.upcomingEvents) decorated = decorated.filter(s => s.upcomingEvents.length > 0);
  if (filters.openOnly) decorated = decorated.filter(s => s.status.state === 'open');
  decorated.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id));
  const total = decorated.length;
  const items = decorated.slice((page - 1) * pageSize, page * pageSize);
  return {
    queryId,
    catalogVersion: currentCatalogVersion(db),
    filters,
    page,
    pageSize,
    total,
    hasMore: page * pageSize < total,
    nextCursor: page * pageSize < total ? String(page + 1) : null,
    asOf: now,
    items
  };
}

export function mapAggregates(db, queryId, rawZoom = 9, now = Date.now(), options = {}) {
  const statusOptions = options.explicitAsOf
    ? { explicitAsOf: true, referenceNow: options.referenceNow || now }
    : {};
  const filters = assertQueryVersion(db, queryId, now);
  let ids = searchCandidateIds(db, filters);
  ids = candidateIdsWithEvents(db, filters, ids, now);
  let stores = ids.map(idValue => decorateStore(db,
    db.prepare('SELECT * FROM stores WHERE id = ?').get(idValue), now, false, statusOptions));
  if (filters.upcomingEvents) stores = stores.filter(s => s.upcomingEvents.length > 0);
  if (filters.openOnly) stores = stores.filter(s => s.status.state === 'open');

  const zoom = Math.max(1, Math.min(18, Number(rawZoom || 9)));
  const digits = zoom <= 7 ? 1 : zoom <= 11 ? 2 : zoom <= 14 ? 3 : 4;
  const factor = 10 ** digits;
  const groups = new Map();
  for (const store of stores) {
    const key = `${Math.round(store.lat * factor)},${Math.round(store.lng * factor)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(store);
  }
  const clusters = [...groups.values()].map(group => {
    const lat = group.reduce((sum, s) => sum + s.lat, 0) / group.length;
    const lng = group.reduce((sum, s) => sum + s.lng, 0) / group.length;
    return {
      id: `cluster_${Math.round(lat * 10000)}_${Math.round(lng * 10000)}`,
      count: group.length,
      lat,
      lng,
      storeIds: group.map(s => s.id),
      openCount: group.filter(s => s.status.state === 'open').length,
      isCluster: group.length > 1,
      preview: group.slice(0, 5).map(s => ({ id: s.id, name: s.name, status: s.status.state }))
    };
  }).sort((a, b) => b.count - a.count || a.lat - b.lat);

  return { queryId, catalogVersion: currentCatalogVersion(db), asOf: now, zoom, clusters };
}

export function upcomingSessions(db, storeId, now, limit = 5, includeUnauthorized = false) {
  let rows = db.prepare(`SELECT es.*, e.title AS event_title, e.theme, e.is_private
                         FROM event_sessions es JOIN events e ON e.id=es.event_id
                         WHERE es.store_id = ? AND es.status='active' AND es.ends_ms > ?
                         ORDER BY es.starts_ms, es.id LIMIT ?`)
    .all(storeId, now, limit * 3);
  if (!includeUnauthorized) rows = rows.filter(r => !(r.closed_required && !r.authorized));
  return rows.slice(0, limit).map(serializeSession);
}

export function eventSessionDetails(db, sessionId, now = Date.now()) {
  const row = db.prepare(`SELECT es.*, e.title AS event_title, e.description AS event_description,
      e.theme, e.is_private, s.name AS store_name, s.address AS store_address
      FROM event_sessions es
      JOIN events e ON e.id=es.event_id
      JOIN stores s ON s.id=es.store_id
      WHERE es.id=?`).get(sessionId);
  if (!row) return null;
  return { ...serializeSession(row), eventDescription: row.event_description, storeName: row.store_name, storeAddress: row.store_address };
}

export function listCitiesAndFacets(db) {
  return {
    cities: db.prepare('SELECT city, COUNT(*) AS count FROM stores WHERE active=1 AND merged_into_id IS NULL GROUP BY city ORDER BY city').all(),
    themes: db.prepare('SELECT theme, COUNT(*) AS count FROM store_themes GROUP BY theme ORDER BY theme').all(),
    seatTypes: db.prepare('SELECT seat_type, SUM(seats_count) AS count FROM store_seats GROUP BY seat_type ORDER BY seat_type').all()
  };
}
