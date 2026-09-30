'use strict';

const fs = require('fs/promises');
const path = require('path');
const dbApi = require('./db');
const schedule = require('./schedule');
const queries = require('./queries');
const eventsApi = require('./events');
const admin = require('./admin');
const tz = require('./tz');

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-manager-token';

function sendJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        const err = new Error('请求体过大');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) {
        const err = new Error('JSON 格式错误');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function urlQuery(req) {
  return Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
}

function requireAdmin(req, res) {
  const token = req.headers['x-admin-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token !== ADMIN_TOKEN) {
    sendJson(res, 401, { error: '需要管理员令牌', hint: '开发环境使用 X-Admin-Token: dev-manager-token' });
    return false;
  }
  return true;
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(id, query, res, now) {
  const list = queries.listMatches(id, { page: 1, pageSize: 50, bbox: query.bbox, now });
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="bookstores-${id}.csv"`,
    'x-query-version': id,
    'x-generated-at': String(list.generatedAt),
    'x-expires-at': String(list.expiresAt),
    'cache-control': 'no-store'
  });
  const header = ['storeId', 'name', 'timeZone', 'address', 'lat', 'lng', 'themes', 'seatTypes', 'totalSeats', 'frozenStatusAtGeneration', 'queryGeneratedAtUtc', 'queryExpiresAtUtc'];
  const lines = [header.join(',')];
  for (const s of list.items) {
    lines.push([
      s.id,
      s.name,
      s.timeZone,
      s.address,
      s.lat,
      s.lng,
      s.themes.join('|'),
      s.seats.map((x) => `${x.type}:${x.count}`).join('|'),
      s.totalSeats,
      s.statusAtGeneration,
      new Date(list.generatedAt).toISOString(),
      new Date(list.expiresAt).toISOString()
    ].map(csvCell).join(','));
  }
  res.end('﻿' + lines.join('\n'));
}

async function storeDetail(identifier, at = Date.now()) {
  const row = dbApi.one(
    `SELECT * FROM stores WHERE id=? OR slug=?`,
    [identifier, identifier]
  );
  if (!row) return null;
  const themes = JSON.parse(row.themes_json);
  const seats = JSON.parse(row.seats_json);
  const mergedInto = row.merged_into_id ? dbApi.one(`SELECT id, slug, name FROM stores WHERE id=?`, [row.merged_into_id]) : null;
  const status = row.active && !row.merged_into_id ? await schedule.getStatusWithComparison(row.id, at) : null;
  const includeFuture = Boolean(row.active && !row.merged_into_id);
  const upcoming = includeFuture ? dbApi.all(
    `SELECT * FROM event_sessions WHERE store_id=? AND status='scheduled' AND ends_at>=? ORDER BY starts_at LIMIT 10`,
    [row.id, at]
  ).map((ev) => ({ ...ev, access: schedule.assessClosedEvent(ev) })) : [];
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    nameHistory: JSON.parse(row.name_history),
    active: Boolean(row.active),
    mergedInto,
    description: row.description,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    timeZone: row.time_zone,
    themes,
    seats,
    status,
    upcomingEvents: upcoming.map((ev) => ({
      id: ev.id,
      title: ev.title,
      startsAt: ev.starts_at,
      endsAt: ev.ends_at,
      capacity: ev.capacity,
      remaining: ev.remaining,
      requiresClosedAuthorization: Boolean(ev.requires_closed_authorization),
      access: ev.access
    }))
  };
}

function parseAt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 4102444800000) {
    const err = new Error('at 必须是 0 到 2100-01-01 之间的 Unix 毫秒时间戳');
    err.statusCode = 400;
    throw err;
  }
  return n;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const query = urlQuery(req);
  let now;
  try {
    now = query.at === undefined ? Date.now() : parseAt(query.at);
  } catch (err) {
    return sendError(res, err);
  }

  if (p === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      now: Date.now(),
      dataVersion: Number(dbApi.getMeta('data_version', '0')),
      scheduleVersion: Number(dbApi.getMeta('schedule_version', '0')),
      scheduleHorizonEpoch: Number(dbApi.getMeta('schedule_horizon_epoch', '0'))
    });
  }

  let m = p.match(/^\/api\/query-versions\/([A-Za-z0-9_]+)$/);
  if (m && req.method === 'GET') {
    try {
      const qv = await require('../src/queries');
      return sendJson(res, 200, qv.envelope(qv.loadVersion(m[1]), { filters: qv.loadVersion(m[1]).filters }));
    } catch (err) { return sendError(res, err); }
  }

  m = p.match(/^\/api\/query-versions$|^\/api\/query-versions$/);
  if (p === '/api/query-versions' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const qv = await queries.createOrReuseQueryVersion(body, now);
      return sendJson(res, 200, queries.envelope(qv, { filters: qv.filters }));
    } catch (err) { return sendError(res, err); }
  }

  m = p.match(/^\/api\/query-versions\/([A-Za-z0-9_]+)\/map$/);
  if (m && req.method === 'GET') {
    try {
      return sendJson(res, 200, queries.mapClusters(m[1], { bbox: query.bbox, zoom: query.zoom, now }));
    } catch (err) { return sendError(res, err); }
  }

  m = p.match(/^\/api\/query-versions\/([A-Za-z0-9_]+)\/stores$/);
  if (m && req.method === 'GET') {
    try {
      return sendJson(res, 200, queries.listMatches(m[1], { page: query.page, pageSize: query.pageSize, bbox: query.bbox, now }));
    } catch (err) { return sendError(res, err); }
  }

  m = p.match(/^\/api\/query-versions\/([A-Za-z0-9_]+)\/events$/);
  if (m && req.method === 'GET') {
    try {
      return sendJson(res, 200, queries.eventMatches(m[1], now));
    } catch (err) { return sendError(res, err); }
  }

  m = p.match(/^\/api\/query-versions\/([A-Za-z0-9_]+)\/export\.csv$/);
  if (m && req.method === 'GET') {
    try {
      return exportCsv(m[1], query, res, now);
    } catch (err) { return sendError(res, err); }
  }

  if (p === '/api/stores' && req.method === 'GET') {
    const rows = dbApi.all(
      `SELECT s.id,s.slug,s.name,s.active,s.merged_into_id AS mergedIntoId,
              s.time_zone AS timeZone,s.lat,s.lng,s.themes_json,s.seats_json,
              t.name AS mergedIntoName
       FROM stores s LEFT JOIN stores t ON t.id=s.merged_into_id
       ORDER BY s.active DESC, s.name`
    ).map((r) => ({
      id: r.id, slug: r.slug, name: r.name, active: Boolean(r.active),
      mergedIntoId: r.mergedIntoId, mergedIntoName: r.mergedIntoName,
      timeZone: r.timeZone, lat: r.lat, lng: r.lng,
      themes: JSON.parse(r.themes_json), seats: JSON.parse(r.seats_json)
    }));
    return sendJson(res, 200, { generatedAt: now, items: rows });
  }

  m = p.match(/^\/api\/stores\/([^/]+)\/status$/);
  if (m && req.method === 'GET') {
    try {
      const detail = await storeDetail(m[1], now);
      if (!detail) return sendJson(res, 404, { error: '门店不存在' });
      return sendJson(res, 200, { storeId: detail.id, name: detail.name, timeZone: detail.timeZone, at: now, ...detail.status });
    } catch (err) { return sendError(res, err); }
  }

  m = p.match(/^\/api\/stores\/([^/]+)$/);
  if (m && req.method === 'GET') {
    try {
      const detail = await storeDetail(m[1], now);
      if (!detail) return sendJson(res, 404, { error: '门店不存在' });
      return sendJson(res, 200, detail);
    } catch (err) { return sendError(res, err); }
  }

  m = p.match(/^\/api\/events\/([^/]+)$/);
  if (m && req.method === 'GET') {
    try {
      const event = eventsApi.getEvent(m[1]);
      if (!event) return sendJson(res, 404, { error: '活动不存在' });
      const store = dbApi.one(`SELECT id,name,slug,time_zone AS timeZone FROM stores WHERE id=?`, [event.store_id]);
      return sendJson(res, 200, { ...event, assessment: schedule.assessClosedEvent(event), store });
    } catch (err) { return sendError(res, err); }
  }

  m = p.match(/^\/api\/events\/([^/]+)\/registrations$/);
  if (m && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = await eventsApi.register(m[1], body, now);
      return sendJson(res, 201, result);
    } catch (err) { return sendError(res, err); }
  }

  m = p.match(/^\/api\/receipts\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const reg = eventsApi.getRegistration(m[1]);
    if (!reg) return sendJson(res, 404, { error: '回执不存在' });
    const currentStore = dbApi.one(`SELECT id,name,slug FROM stores WHERE id=?`, [reg.actual_store_id]);
    return sendJson(res, 200, { ...eventsApi.serializeRegistration(reg), currentStoreName: currentStore ? currentStore.name : null });
  }

  if (p === '/api/admin/schedules/rebuild' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      return sendJson(res, 200, await admin.rebuildSchedules('manager', now));
    } catch (err) { return sendError(res, err); }
  }

  m = p.match(/^\/api\/admin\/stores\/([^/]+)\/exceptions$/);
  if (m && (req.method === 'POST' || req.method === 'DELETE')) {
    if (!requireAdmin(req, res)) return;
    try {
      const body = req.method === 'POST' ? await readBody(req) : { localDate: query.localDate };
      const result = req.method === 'POST'
        ? await admin.addException(m[1], body, 'manager', now)
        : await admin.clearException(m[1], query.localDate, 'manager', now);
      return sendJson(res, 200, result);
    } catch (err) { return sendError(res, err); }
  }

  m = p.match(/^\/api\/admin\/stores\/([^/]+)\/rename$/);
  if (m && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = await readBody(req);
      return sendJson(res, 200, await admin.renameStore(m[1], body.name, 'manager', now));
    } catch (err) { return sendError(res, err); }
  }

  if (p === '/api/admin/merge' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = await readBody(req);
      return sendJson(res, 200, await admin.mergeStore(body.sourceId, body.targetId, 'manager', now));
    } catch (err) { return sendError(res, err); }
  }

  m = p.match(/^\/api\/admin\/events\/([^/]+)\/authorize$/);
  if (m && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = await readBody(req);
      return sendJson(res, 200, await eventsApi.grantClosedEvent(m[1], 'manager', body.note, now));
    } catch (err) { return sendError(res, err); }
  }

  if (p === '/api/admin/audit' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    return sendJson(res, 200, { items: dbApi.all(`SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT 50`) });
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'API 路径不存在' });
  return serveStatic(p, res);
}

async function serveStatic(p, res) {
  const requested = p === '/' ? '/index.html' : p;
  const relative = requested.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (_) {
    try {
      const index = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(index);
    } catch (_) {
      res.writeHead(404); res.end('Not found');
    }
  }
}

function sendError(res, err) {
  const status = err.statusCode || 500;
  if (status >= 500) console.error(err);
  sendJson(res, status, {
    error: err.message || '服务器错误',
    code: err.code,
    generatedAt: err.generatedAt,
    expiresAt: err.expiresAt,
    invalidatedAt: err.invalidatedAt
  });
}

module.exports = { route };
