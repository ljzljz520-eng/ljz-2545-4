import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import {
  addException,
  effectiveWindows,
  getStoreStatus,
  regenerateStoreWindows,
  weeklyWindows
} from '../src/schedule.js';
import {
  authorizeSession,
  bookSession,
  createEvent,
  createStore,
  mergeStores,
  renameStore
} from '../src/repositories.js';
import { createQuery, mapAggregates, searchStores } from '../src/query.js';
import { wallToUtcMs } from '../src/time.js';

const FIXED_NOW = Date.parse('2026-09-30T12:00:00Z');

function makeStore(db, overrides = {}) {
  return createStore(db, {
    name: '测试书店',
    city: '测试城',
    address: '测试路 1 号',
    lat: 31.2,
    lng: 121.4,
    timezone: 'Asia/Shanghai',
    themes: ['文学小说'],
    seats: { 咖啡座: 4 },
    weeklyHours: [
      { weekday: 3, startClock: '10:00', endClock: '23:00' },
      { weekday: 4, startClock: '22:00', endClock: '02:00' }
    ],
    ...overrides
  }, FIXED_NOW);
}

function startServer(db) {
  const server = createApp(db);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise(r => server.close(r))
      });
    });
  });
}

async function request(base, method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, body: json, headers: res.headers };
}

test('秋季 DST 重复挂钟生成两个不同 UTC 营业实例，且不按浏览者日期截断', () => {
  const db = openDb(':memory:');
  const store = createStore(db, {
    name: '重复书店', city: 'NY', address: 'x', lat: 40.68, lng: -73.97,
    timezone: 'America/New_York',
    weeklyHours: [{ weekday: 6, startClock: '01:00', endClock: '01:30' }]
  }, FIXED_NOW);
  const windows = weeklyWindows(db, store,
    Date.parse('2026-11-01T04:59:00Z'), Date.parse('2026-11-01T12:00:00Z'));
  assert.equal(windows.length, 2);
  const starts = windows.map(w => new Date(w.starts_ms).toISOString());
  assert.deepEqual(starts, ['2026-11-01T05:00:00.000Z', '2026-11-01T06:00:00.000Z']);
  assert.deepEqual(windows.map(w => w.ends_ms - w.starts_ms), [30 * 60_000, 30 * 60_000]);

  const first = wallToUtcMs('America/New_York',
    { year: 2026, month: 11, day: 1, hour: 1, minute: 0 }, { disambiguation: 'first' });
  const second = wallToUtcMs('America/New_York',
    { year: 2026, month: 11, day: 1, hour: 1, minute: 0 }, { disambiguation: 'second' });
  assert.equal(first.value + 3600_000, second.value);
});

test('春季 DST 不存在的 02:30 顺延且持续时长保持 60 分钟', () => {
  const db = openDb(':memory:');
  const store = createStore(db, {
    name: '春跳测试', city: 'NY', address: 'x', lat: 40.68, lng: -73.97,
    timezone: 'America/New_York',
    weeklyHours: [{ weekday: 6, startClock: '02:30', endClock: '03:30' }]
  }, FIXED_NOW);
  const windows = weeklyWindows(db, store,
    Date.parse('2027-03-13T00:00:00Z'), Date.parse('2027-03-15T12:00:00Z'));
  assert.equal(windows.length, 1);
  assert.equal(new Date(windows[0].starts_ms).toISOString(), '2027-03-14T07:30:00.000Z');
  assert.equal(new Date(windows[0].ends_ms).toISOString(), '2027-03-14T08:30:00.000Z');
});

test('跨午夜营业归属实际开始日，临时闭店优先挖空常规时间', () => {
  const db = openDb(':memory:');
  const store = makeStore(db);
  // 周五 22:00 到周六 02:00（上海 UTC+8），周六 00:30 仍属于周五营业实例。
  const saturdayEarly = Date.parse('2026-10-02T16:30:00Z'); // 2026-10-03 00:30 Shanghai
  assert.equal(getStoreStatus(db, store, saturdayEarly).state, 'open');
  addException(db, store.id, 'closed', '临时闭店',
    '2026-10-03T00:00', '2026-10-03T02:00', '', saturdayEarly);
  assert.equal(getStoreStatus(db, store, saturdayEarly, { forceRecompute: true }).state, 'closed');
  const windows = effectiveWindows(db, store,
    Date.parse('2026-10-01T14:00:00Z'), Date.parse('2026-10-01T18:00:00Z'));
  assert.deepEqual(windows.map(w => [w.starts_ms, w.ends_ms]), [
    [Date.parse('2026-10-01T14:00:00Z'), Date.parse('2026-10-01T15:00:00Z')]
  ]);
});

test('闭店活动既不自动取消也不自动放行，必须显式授权后才能报名', () => {
  const db = openDb(':memory:');
  const store = makeStore(db);
  addException(db, store.id, 'closed', '私场日',
    '2026-10-01T18:00', '2026-10-01T22:00', '', FIXED_NOW);
  const event = createEvent(db, {
    storeId: store.id, title: '闭店朗读', theme: '文学小说',
    date: '2026-10-01', startTime: '19:00', endTime: '20:00',
    capacity: 4, isPrivate: true
  }, FIXED_NOW);
  assert.equal(event.session.closed_required, 1);
  assert.equal(event.session.authorized, 0);
  assert.throws(() => bookSession(db, event.session.id, {
    contactName: '甲', contactEmail: 'a@example.com', seats: 1
  }, FIXED_NOW), /显式授权/);
  const authorized = authorizeSession(db, event.session.id, '店主确认专人值守', 'tester', FIXED_NOW);
  assert.equal(authorized.authorized, 1);
  const booking = bookSession(db, event.session.id, {
    contactName: '甲', contactEmail: 'a@example.com', seats: 1
  }, FIXED_NOW);
  assert.equal(booking.receipt.actual_session.session_id, event.session.id);
  assert.equal(booking.receipt.closure_authorized, true);
});

test('新增临时闭店改变边界后，旧授权失效并必须重新授权', () => {
  const db = openDb(':memory:');
  const store = makeStore(db);
  const event = createEvent(db, {
    storeId: store.id, title: '未来夜谈', theme: '文学小说',
    date: '2026-10-01', startTime: '20:00', endTime: '21:00', capacity: 5
  }, FIXED_NOW);
  // 原营业时段无需授权。
  assert.equal(event.session.closed_required, 0);
  addException(db, store.id, 'closed', '设备维修',
    '2026-10-01T19:00', '2026-10-01T22:00', '', FIXED_NOW);
  const stale = db.prepare('SELECT * FROM event_sessions WHERE id=?').get(event.session.id);
  assert.equal(stale.closed_required, 1);
  assert.equal(stale.authorized, 0);
  assert.throws(() => bookSession(db, event.session.id, {
    contactName: '乙', contactEmail: 'b@example.com'
  }, FIXED_NOW), /显式授权/);
});

test('状态缓存命中到下一状态点，手工修改后旧 queryId 传播 409，地图与列表同版', async () => {
  const db = openDb(':memory:');
  const store = makeStore(db);
  const cachedAt = Date.parse('2026-10-02T14:59:00Z');
  const cached = getStoreStatus(db, store, cachedAt);
  assert.equal(cached.cache, 'miss');
  const later = getStoreStatus(db, store, Date.parse('2026-10-02T15:00:00Z'));
  assert.equal(later.cache, 'hit');
  assert.equal(later.next_change_ms, Date.parse('2026-10-02T18:00:00Z'));

  const query = createQuery(db, { city: '测试城' }, FIXED_NOW);
  const list = searchStores(db, query.queryId, { page: 1, pageSize: 2 }, FIXED_NOW);
  const map = mapAggregates(db, query.queryId, 9, FIXED_NOW);
  assert.equal(list.queryId, map.queryId);
  assert.equal(list.catalogVersion, map.catalogVersion);
  assert.equal(list.total, 1);
  assert.equal(map.clusters[0].storeIds[0], store.id);

  renameStore(db, store.id, '更正后的书店', 'tester', FIXED_NOW + 1);
  assert.throws(() => searchStores(db, query.queryId, {}, FIXED_NOW + 1), /手工更正/);
  assert.throws(() => mapAggregates(db, query.queryId, 9, FIXED_NOW + 1), /手工更正/);

  const app = await startServer(db);
  try {
    const stale = await request(app.url, 'GET', `/api/stores?queryId=${query.queryId}`, undefined);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'QUERY_VERSION_STALE');
  } finally { await app.stop(); }
});

test('最后一席并发抢占只允许一个请求成功', async () => {
  const workerCode = `
    const { workerData, parentPort } = require('worker_threads');
    const Database = require('better-sqlite3');
    const db = new Database(workerData.path);
    db.pragma('busy_timeout = 10000');
    try {
      const row = db.prepare('SELECT * FROM event_sessions WHERE id=?').get(workerData.sessionId);
      db.prepare("BEGIN IMMEDIATE").run();
      const current = db.prepare('SELECT booked_count, capacity FROM event_sessions WHERE id=?').get(workerData.sessionId);
      if (current.booked_count + 1 > current.capacity) throw new Error('SEATS_FULL');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      db.prepare('UPDATE event_sessions SET booked_count=booked_count+1 WHERE id=?').run(workerData.sessionId);
      db.prepare('COMMIT').run();
      parentPort.postMessage('ok');
    } catch (e) { try{db.prepare('ROLLBACK').run()}catch{} parentPort.postMessage(e.message); }
  `;
  // 使用临时文件，让主线程和 worker 共享同一个 SQLite 数据库。
  // better-sqlite3 不能直接复制内存库；这里改用持久库重新建立同等数据。
  const dir = mkdtempSync(join(tmpdir(), 'night-shelf-'));
  const path = join(dir, 'race.sqlite');
  const fileDb = openDb(path);
  const fileStore = makeStore(fileDb);
  const fileEvent = createEvent(fileDb, {
    storeId: fileStore.id, title: '最后一席', theme: '文学小说',
    date: '2026-10-07', startTime: '11:00', endTime: '12:00', capacity: 1
  }, FIXED_NOW);

  const workers = [0, 1].map(() => new Worker(workerCode, {
    eval: true,
    workerData: { path, sessionId: fileEvent.session.id }
  }));
  const outcomes = await Promise.all(workers.map(async w => {
    const [message] = await once(w, 'message');
    await w.terminate();
    return message;
  }));
  assert.deepEqual(outcomes.sort(), ['SEATS_FULL', 'ok']);
  assert.equal(fileDb.prepare('SELECT booked_count FROM event_sessions WHERE id=?')
    .get(fileEvent.session.id).booked_count, 1);
});

test('店铺合并更名后旧名可追踪，活动转移，回执快照仍绑定实际场次与原门店名', () => {
  const db = openDb(':memory:');
  const source = makeStore(db, { id: 'st_source', name: '旧店', slug: 'old-shop' });
  const target = makeStore(db, {
    id: 'st_target', name: '承接店', slug: 'target-shop',
    city: '测试城', themes: ['诗歌戏剧'], weeklyHours: [
      { weekday: 3, startClock: '09:00', endClock: '22:00' }
    ]
  });
  const event = createEvent(db, {
    storeId: source.id, title: '合并前活动', theme: '文学小说',
    date: '2026-10-01', startTime: '11:00', endTime: '12:00', capacity: 3
  }, FIXED_NOW);
  const booking = bookSession(db, event.session.id, {
    contactName: '丙', contactEmail: 'c@example.com'
  }, FIXED_NOW);
  mergeStores(db, source.id, target.id, '租约调整', FIXED_NOW + 1);
  renameStore(db, target.id, '新承接书局', 'tester', FIXED_NOW + 2);
  const movedSession = db.prepare('SELECT * FROM event_sessions WHERE id=?').get(event.session.id);
  assert.equal(movedSession.store_id, target.id);
  const receipt = db.prepare('SELECT * FROM bookings WHERE code=?').get(booking.code);
  const snapshot = JSON.parse(receipt.receipt_snapshot_json);
  assert.equal(snapshot.store.id, source.id);
  assert.equal(snapshot.store.name, '旧店');
  assert.equal(snapshot.actual_session.starts_ms, event.session.starts_ms);
  const aliases = db.prepare('SELECT alias FROM store_aliases WHERE store_id=?').all(target.id).map(r => r.alias);
  assert.ok(aliases.includes('旧店'));
});

test('预生成窗口与实时窗口对账，手工临时改营业会重建窗口且状态过期不标当前', () => {
  const db = openDb(':memory:');
  const store = makeStore(db);
  regenerateStoreWindows(db, store, FIXED_NOW, 400);
  const before = db.prepare('SELECT COUNT(*) AS count FROM open_windows WHERE store_id=?').get(store.id).count;
  assert.ok(before > 0);
  addException(db, store.id, 'open', '临时加开',
    '2026-10-05T08:00', '2026-10-05T09:00', '', FIXED_NOW);
  const added = effectiveWindows(db, store,
    Date.parse('2026-10-05T00:00:00Z'), Date.parse('2026-10-05T02:00:00Z'));
  assert.equal(added.length, 1);
  assert.equal(added[0].source_type, 'exception_open');
  const past = Date.parse('2000-01-01T00:00:00Z');
  const status = getStoreStatus(db, store, past, { explicitAsOf: true, referenceNow: FIXED_NOW });
  // 历史状态只作为明确 as-of 查询；UI/导出不得把它当实时状态。
  assert.equal(status.as_of_ms, past);
  assert.equal(status.historical, true);
  assert.equal(status.cache, 'historical');
  assert.ok(status.next_change_ms > past);
});
