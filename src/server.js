import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, currentCatalogVersion } from './db.js';
import {
  assertQueryVersion,
  authorizeSession,
  bookSession,
  createEvent,
  createStore,
  mergeStores,
  normalizeWeeklyRules,
  renameStore,
  replaceWeeklyHours
} from './repositories.js';
import {
  createQuery,
  eventSessionDetails,
  listCitiesAndFacets,
  mapAggregates,
  searchStores,
  serializeSessionPublic,
  upcomingSessions
} from './query.js';
import {
  addException,
  getStoreStatus,
  regenerateAllWindows
} from './schedule.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1_000_000) reject(Object.assign(new Error('请求体过大'), { status: 413 }));
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('JSON 格式不正确'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function requireAdmin(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-admin-token'] || '');
  if (token !== ADMIN_TOKEN) {
    json(res, 401, { error: { code: 'ADMIN_UNAUTHORIZED', message: '需要管理员令牌' } });
    return false;
  }
  return true;
}

function asOfNow(url, req) {
  // 生产默认用服务端当前时间；测试用 X-Test-Now 或 asOf 传 UTC ISO，不能传浏览器本地日期。
  const input = req.headers['x-test-now'] || url.searchParams.get('asOf');
  if (!input) return Date.now();
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) throw Object.assign(new Error('asOf 必须是 UTC ISO 时间戳，不接受本地日期'), { status: 400 });
  return ms;
}

const routes = [];
function route(method, pattern, handler, options = {}) {
  routes.push({ method, pattern, handler, admin: options.admin });
}

route('GET', /^\/api\/health$/, (req, res, url, { db, now }) => {
  json(res, 200, {
    ok: true,
    now,
    nowIso: new Date(now).toISOString(),
    catalogVersion: currentCatalogVersion(db),
    service: 'night-shelf'
  });
});

route('GET', /^\/api\/facets$/, (req, res, url, ctx) => {
  json(res, 200, listCitiesAndFacets(ctx.db));
});

route('POST', /^\/api\/queries$/, async (req, res, url, ctx) => {
  const body = await readBody(req);
  json(res, 201, createQuery(ctx.db, body, ctx.now));
});

route('GET', /^\/api\/stores$/, (req, res, url, ctx) => {
  const queryId = url.searchParams.get('queryId');
  if (!queryId) {
    throw Object.assign(new Error('必须先 POST /api/queries 获取同一查询版 queryId'), { status: 400 });
  }
  json(res, 200, searchStores(ctx.db, queryId, Object.fromEntries(url.searchParams), ctx.now, ctx.statusContext));
});

route('GET', /^\/api\/map$/, (req, res, url, ctx) => {
  const queryId = url.searchParams.get('queryId');
  if (!queryId) throw Object.assign(new Error('地图必须携带 queryId'), { status: 400 });
  json(res, 200, mapAggregates(ctx.db, queryId, url.searchParams.get('zoom'), ctx.now, ctx.statusContext));
});

route('GET', /^\/api\/stores\/([^/]+)$/, (req, res, url, ctx) => {
  const id = url.pathname.split('/').pop();
  const store = ctx.db.prepare(`SELECT * FROM stores WHERE id = ? OR slug = ?`).get(id, id);
  if (!store || !store.active) throw Object.assign(new Error('门店不存在'), { status: 404 });
  if (store.merged_into_id) {
    const target = ctx.db.prepare('SELECT * FROM stores WHERE id = ?').get(store.merged_into_id);
    return json(res, 303, {
      error: { code: 'STORE_MERGED', message: '门店已合并', redirectStoreId: target.id },
      store: { id: store.id, name: store.name, mergedInto: { id: target.id, name: target.name, slug: target.slug } }
    }, { 'x-merged-into': target.id });
  }
  const status = getStoreStatus(ctx.db, store.id, ctx.now, ctx.statusContext);
  const sessions = upcomingSessions(ctx.db, store.id, ctx.now, 20, true);
  json(res, 200, { store, status, sessions: sessions.map(serializeSessionPublic) });
});

route('GET', /^\/api\/sessions\/([^/]+)$/, (req, res, url, ctx) => {
  const id = url.pathname.split('/').pop();
  const session = eventSessionDetails(ctx.db, id, ctx.now);
  if (!session) throw Object.assign(new Error('场次不存在'), { status: 404 });
  json(res, 200, session);
});

route('POST', /^\/api\/sessions\/([^/]+)\/bookings$/, async (req, res, url, ctx) => {
  const id = url.pathname.split('/')[3];
  const body = await readBody(req);
  try {
    const result = bookSession(ctx.db, id, body, ctx.now);
    json(res, 201, result);
  } catch (error) {
    if (error.code === 'SEATS_FULL' || /席位|活动已结束|授权|私场/.test(error.message)) {
      error.status = error.code === 'SEATS_FULL' ? 409 : 400;
    }
    throw error;
  }
});

route('GET', /^\/api\/bookings\/([^/]+)$/, (req, res, url, ctx) => {
  const code = url.pathname.split('/').pop();
  const row = ctx.db.prepare(`SELECT b.*, es.event_id, es.starts_ms AS bound_starts_ms, es.ends_ms AS bound_ends_ms,
      s.name AS current_store_name
      FROM bookings b JOIN event_sessions es ON es.id=b.session_id
      JOIN stores s ON s.id=es.store_id WHERE b.code=?`).get(code);
  if (!row) throw Object.assign(new Error('预约不存在'), { status: 404 });
  json(res, 200, {
    code: row.code,
    status: row.status,
    currentStoreName: row.current_store_name,
    receipt: JSON.parse(row.receipt_snapshot_json),
    actualBindingCheck: {
      sessionIdMatchesReceipt: row.receipt_snapshot_json.includes(row.session_id),
      startsMsMatchesReceipt: JSON.parse(row.receipt_snapshot_json).actual_session.starts_ms === row.bound_starts_ms,
      endsMsMatchesReceipt: JSON.parse(row.receipt_snapshot_json).actual_session.ends_ms === row.bound_ends_ms
    }
  });
});

route('GET', /^\/api\/export$/, (req, res, url, ctx) => {
  // 导出永远按当前目录重新建立查询版，避免把旧 queryId 的过期状态导成“当前”。
  const filters = Object.fromEntries(url.searchParams);
  const exportNow = ctx.realNow;
  const query = createQuery(ctx.db, filters, exportNow);
  const page = searchStores(ctx.db, query.queryId, { page: 1, pageSize: 500 }, exportNow);
  const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
  if (format === 'json') {
    return json(res, 200, { exportedAt: exportNow, query, stores: page.items });
  }
  const header = [
    'id', 'name', 'city', 'address', 'timezone', 'themes', 'seats',
    'status_as_of_utc', 'state', 'next_change_utc', 'generated_at_utc'
  ];
  const rows = page.items.map(s => [
    s.id, s.name, s.city, s.address, s.timezone, s.themes.join('|'),
    Object.entries(s.seats).map(([k, v]) => `${k}:${v}`).join('|'),
    new Date(s.status.asOf).toISOString(), s.status.state,
    new Date(s.status.nextChange).toISOString(), new Date(s.status.computedAt).toISOString()
  ]);
  const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="bookstores-${new Date(exportNow).toISOString().slice(0,10)}.csv"`
  });
  res.end('﻿' + csv);
});

route('POST', /^\/api\/admin\/stores$/, async (req, res, url, ctx) => {
  const body = await readBody(req);
  if (!body.weeklyHours || !Array.isArray(body.weeklyHours)) body.weeklyHours = [];
  const store = createStore(ctx.db, body, ctx.now);
  if (body.weeklyHours.length) replaceWeeklyHours(ctx.db, store.id, body.weeklyHours, ctx.now);
  json(res, 201, store);
}, { admin: true });

route('PATCH', /^\/api\/admin\/stores\/([^/]+)\/hours$/, async (req, res, url, ctx) => {
  const storeId = url.pathname.split('/')[4];
  const body = await readBody(req);
  normalizeWeeklyRules(body.weeklyHours || []);
  replaceWeeklyHours(ctx.db, storeId, body.weeklyHours, ctx.now);
  json(res, 200, { ok: true, storeId, hoursVersion: ctx.db.prepare('SELECT hours_version FROM stores WHERE id=?').get(storeId).hours_version });
}, { admin: true });

route('POST', /^\/api\/admin\/stores\/([^/]+)\/exceptions$/, async (req, res, url, ctx) => {
  const storeId = url.pathname.split('/')[4];
  const body = await readBody(req);
  if (!['closed', 'open'].includes(body.kind)) throw Object.assign(new Error('kind 必须是 closed/open'), { status: 400 });
  const row = addException(ctx.db, storeId, body.kind, body.title, body.startsLocal, body.endsLocal, body.note, ctx.now);
  json(res, 201, row);
}, { admin: true });

route('PATCH', /^\/api\/admin\/stores\/([^/]+)\/rename$/, async (req, res, url, ctx) => {
  const storeId = url.pathname.split('/')[4];
  const body = await readBody(req);
  json(res, 200, renameStore(ctx.db, storeId, body.name, body.actor || 'admin', ctx.now));
}, { admin: true });

route('POST', /^\/api\/admin\/stores\/([^/]+)\/merge$/, async (req, res, url, ctx) => {
  const sourceId = url.pathname.split('/')[4];
  const body = await readBody(req);
  json(res, 200, mergeStores(ctx.db, sourceId, body.targetStoreId, body.reason, ctx.now));
}, { admin: true });

route('POST', /^\/api\/admin\/events$/, async (req, res, url, ctx) => {
  const body = await readBody(req);
  json(res, 201, createEvent(ctx.db, body, ctx.now));
}, { admin: true });

route('POST', /^\/api\/admin\/sessions\/([^/]+)\/authorize$/, async (req, res, url, ctx) => {
  const sessionId = url.pathname.split('/')[4];
  const body = await readBody(req);
  json(res, 200, authorizeSession(ctx.db, sessionId, body.note, body.actor || 'admin', ctx.now));
}, { admin: true });

function csvCell(value) {
  const s = String(value ?? '');
  // 防止 CSV 公式注入，并统一引号转义。
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function serveStatic(url, res) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = normalize(join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    if (extname(filePath)) {
      res.writeHead(404);
      res.end('Not found');
    } else {
      const data = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.html'] });
      res.end(data);
    }
  }
}

export function createApp(db) {
  return createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-admin-token, x-test-now');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (!url.pathname.startsWith('/api/')) return await serveStatic(url, res);
    const realNow = Date.now();
    const now = asOfNow(url, req);
    const statusContext = { explicitAsOf: !!url.searchParams.get('asOf'), referenceNow: realNow };
    for (const candidate of routes) {
        if (candidate.method !== req.method) continue;
        const match = candidate.pattern.exec(url.pathname);
        if (!match) continue;
        if (candidate.admin && !requireAdmin(req, res)) return;
        return await candidate.handler(req, res, url, { db, now, realNow, statusContext });
      }
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'API 不存在' } });
    } catch (error) {
      const status = error.status || (
        error.code === 'QUERY_VERSION_REQUIRED' ? 400 :
        error.code === 'QUERY_VERSION_STALE' ? 409 :
        /不存在|找不到/.test(error.message) ? 404 : 400
      );
      json(res, status, {
        error: {
          code: error.code || 'REQUEST_ERROR',
          message: error.message,
          ...(error.currentVersion ? { currentVersion: error.currentVersion } : {}),
          ...(error.storedVersion ? { storedVersion: error.storedVersion } : {})
        }
      });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  regenerateAllWindows(db);
  const server = createApp(db);
  server.listen(PORT, () => {
    console.log(`Night Shelf listening on http://localhost:${PORT}`);
  });
}
