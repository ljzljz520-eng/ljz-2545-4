'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tmpDir = path.join(os.tmpdir(), `bookbar-acceptance-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.PORT = String(4180 + (process.pid % 200));
process.env.ADMIN_TOKEN = 'test-token';

const db = require('../src/db');
const schedule = require('../src/schedule');
const tz = require('../src/tz');
const queries = require('../src/queries');
const eventsApi = require('../src/events');
const admin = require('../src/admin');

const port = Number(process.env.PORT);
let server;
const base = `http://127.0.0.1:${port}`;

async function jsonFetch(url, options = {}) {
  const res = await fetch(new URL(url, base), {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const text = await res.text();
  let body = {};
  if (text && (res.headers.get('content-type') || '').includes('application/json')) body = JSON.parse(text);
  return { status: res.status, headers: res.headers, body, text };
}

before(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  await db.initDatabase();
  await schedule.ensureSchedules(Date.now());
  const http = require('http');
  const { route } = require('../src/http');
  await new Promise((resolve) => {
    server = http.createServer((req, res) => route(req, res));
    server.listen(port, '127.0.0.1', resolve);
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.closeDatabase();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('夏令时重复墙上时刻生成两个实际 UTC 营业实例，且不被浏览器日期截断', () => {
  const store = schedule.getStore('store-portland');
  const windows = schedule.computeWindowsForDate(store, '2026-11-01')
    .filter((w) => w.startsAt === Date.parse('2026-11-01T08:00:00Z') || w.startsAt === Date.parse('2026-11-01T09:00:00Z'));
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((w) => [new Date(w.startsAt).toISOString(), new Date(w.endsAt).toISOString()]), [
    ['2026-11-01T08:00:00.000Z', '2026-11-01T11:00:00.000Z'],
    ['2026-11-01T09:00:00.000Z', '2026-11-01T11:00:00.000Z']
  ]);
  assert.equal(tz.localDate(windows[1].endsAt, store.timeZone), '2026-11-01');
});

test('跨午夜窗口锚定开场日，闭店例外优先于常规营业', () => {
  const store = schedule.getStore('store-shanghai');
  const windows = schedule.computeWindowsForDate(store, '2026-10-02');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].anchorLocalDate, '2026-10-02');
  assert.equal(tz.localDate(windows[0].startsAt, store.timeZone), '2026-10-02');
  assert.equal(tz.localDate(windows[0].endsAt, store.timeZone), '2026-10-03');
});

test('春令时不存在的墙上时段向前调整，且不生成幽灵营业实例', () => {
  const store = schedule.getStore('store-berlin');
  const windows = schedule.periodOccurrences(store, '2026-03-29', 2 * 60, 5 * 60);
  assert.equal(windows.length, 1);
  assert.equal(new Date(windows[0].startsAt).toISOString(), '2026-03-29T01:00:00.000Z');
  assert.equal(new Date(windows[0].endsAt).toISOString(), '2026-03-29T03:00:00.000Z');
  assert.equal(tz.localDate(windows[0].startsAt, store.timeZone), '2026-03-29');
  assert.equal(tz.zonedParts(windows[0].startsAt, store.timeZone).hour, 3);
  assert.equal(tz.zonedParts(windows[0].endsAt, store.timeZone).hour, 5);
});

test('临时改营业替换当天常规时间，撤销后恢复常规排程', async () => {
  const store = schedule.getStore('store-tokyo');
  const date = '2026-10-03';
  const regular = schedule.computeWindowsForDate(store, date);
  await admin.addException(store.id, {
    localDate: date, kind: 'modified', startMinute: 12 * 60, endMinute: 15 * 60, reason: '作者到店短开'
  }, 'tester', Date.parse('2026-09-30T00:00:00Z'));
  const modified = schedule.computeWindowsForDate(store, date);
  assert.equal(modified.length, 1);
  assert.equal(modified[0].source, 'exception');
  assert.equal(tz.localDate(modified[0].startsAt, store.timeZone), date);
  assert.equal(tz.localDate(modified[0].endsAt, store.timeZone), date);
  await admin.clearException(store.id, date, 'tester', Date.parse('2026-09-30T00:00:00Z'));
  const restored = schedule.computeWindowsForDate(store, date);
  assert.deepEqual(restored.map((w) => [w.startsAt, w.endsAt]), regular.map((w) => [w.startsAt, w.endsAt]));
});

test('临时闭店后重算并传播，使地图/列表共享查询版失效', async () => {
  const created = await queries.createOrReuseQueryVersion({ q: '神保' }, Date.now());
  assert.ok(created.id);
  const beforeList = queries.listMatches(created.id, { now: Date.now() });
  assert.equal(beforeList.total, 1);
  const localDate = tz.localDate(Date.now(), 'Asia/Tokyo');
  await admin.addException('store-tokyo', { localDate, kind: 'closed', reason: '边界测试临时闭店' }, 'tester', Date.now());
  assert.throws(() => queries.listMatches(created.id, { now: Date.now() }), /corrected|更正|查询版/);
  const rebuilt = await queries.createOrReuseQueryVersion({ q: '神保', openNow: true }, Date.now());
  const list = queries.listMatches(rebuilt.id, { now: Date.now() });
  assert.equal(list.total, 0);
  const map = queries.mapClusters(rebuilt.id, { now: Date.now() });
  assert.equal(map.queryVersionId, list.queryVersionId);
  assert.equal(map.clusters.length, 0);
  await admin.clearException('store-tokyo', localDate, 'tester', Date.now());
});

test('实时状态与预生成时间窗比较并可在漂移时修复', async () => {
  const status = await schedule.getStatusWithComparison('store-berlin', Date.now());
  assert.equal(status.comparison.matches, true);
  assert.equal(status.pregenerated.source, 'pregenerated-window');
});

test('闭店专场未显式授权时拒绝，授权后报名并在回执绑定实际场次', async () => {
  const eventId = 'event-london-after-hours';
  await assert.rejects(
    () => eventsApi.register(eventId, { attendeeName: '未授权读者', seats: 1 }, Date.now()),
    /显式授权|不能报名/
  );
  const auth = await eventsApi.grantClosedEvent(eventId, 'tester', '边界测试批准', Date.now());
  assert.equal(auth.access, 'closed');
  assert.equal(auth.authorized, true);
  const result = await eventsApi.register(eventId, {
    attendeeName: '诗社读者', attendeeContact: 'reader@example.com', seats: 1
  }, Date.now());
  assert.equal(result.registration.eventId, eventId);
  assert.equal(result.registration.actualSession.title, '壁炉闭店专场：手抄诗工作坊');
  assert.match(result.registration.confirmationCode, /^BB-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  await eventsApi.cancelRegistration(result.registration.id, Date.now());
});

test('最后席位并发抢占只允许一个请求成功', async () => {
  const eventId = 'event-last-seat';
  // Cancel any registrations left by other tests, without assuming row ids.
  db.run(
    `UPDATE registrations SET status='canceled' WHERE event_id=? AND status='confirmed'`,
    [eventId]
  );
  db.run('UPDATE event_sessions SET remaining=1, capacity=1 WHERE id=?', [eventId]);
  await db.flush();

  const attempts = await Promise.allSettled([
    eventsApi.register(eventId, { attendeeName: '并发读者 A', seats: 1 }, Date.now()),
    eventsApi.register(eventId, { attendeeName: '并发读者 B', seats: 1 }, Date.now()),
    eventsApi.register(eventId, { attendeeName: '并发读者 C', seats: 1 }, Date.now())
  ]);
  const fulfilled = attempts.filter((r) => r.status === 'fulfilled');
  const rejected = attempts.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].reason.message, /最后席位/);
  const event = eventsApi.getEvent(eventId);
  assert.equal(event.remaining, 0);
  await eventsApi.cancelRegistration(fulfilled[0].value.registration.id, Date.now());
});

test('店铺更名写入历史，合并门店从结果移除且旧查询不能继续当当前数据使用', async () => {
  const qv = await queries.createOrReuseQueryVersion({ q: '猫亭' }, Date.now());
  assert.equal(queries.listMatches(qv.id, {}).total, 1);
  await admin.renameStore('store-tokyo', '神保町猫亭二号', 'tester', Date.now());
  assert.throws(() => queries.listMatches(qv.id, {}), /renamed|更名|查询版/);
  const withNewName = await queries.createOrReuseQueryVersion({ q: '二号' }, Date.now());
  assert.equal(queries.listMatches(withNewName.id, {}).total, 1);

  const history = db.one(`SELECT name_history FROM stores WHERE id='store-tokyo'`);
  assert.ok(JSON.parse(history.name_history).includes('神保町猫亭二号'));

  // Reuse a dedicated inactive historical store from seed; it has no future booked sessions.
  const merge = await admin.mergeStore('store-old-voyage', 'store-tokyo', 'tester', Date.now());
  assert.equal(merge.targetId, 'store-tokyo');
  const source = db.one(`SELECT active, merged_into_id FROM stores WHERE id='store-old-voyage'`);
  assert.equal(source.active, 0);
  assert.equal(source.merged_into_id, 'store-tokyo');
});

test('HTTP 边界：CSV 标注生成时刻、不把过期状态写成当前；410 携带到期点', async () => {
  const qv = await queries.createOrReuseQueryVersion({}, Date.now());
  const csv = await jsonFetch(`/api/query-versions/${qv.id}/export.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /frozenStatusAtGeneration/);
  assert.match(csv.text, /queryExpiresAtUtc/);
  db.run('UPDATE query_versions SET expires_at=? WHERE id=?', [Date.now() - 1, qv.id]);
  await db.flush();
  const stale = await jsonFetch(`/api/query-versions/${qv.id}/stores`);
  assert.equal(stale.status, 410);
  assert.equal(stale.body.code, 'QUERY_VERSION_EXPIRED');
  assert.ok(stale.body.expiresAt < Date.now());
});

test('查询前若预生成窗口漂移，会先比较并修复而不是直接使用陈旧窗口', async () => {
  const storeId = 'store-berlin';
  const now = Date.now();
  db.run('DELETE FROM business_windows WHERE store_id=?', [storeId]);
  await db.flush();
  const consistency = await schedule.ensureStatusConsistency(now);
  assert.equal(consistency.repaired, true);
  assert.equal(consistency.mismatches, 0);
  const repaired = schedule.pregeneratedStatus(storeId, now);
  const live = schedule.liveStatus(storeId, now);
  assert.equal(repaired.isOpen, live.isOpen);
});

test('缓存到期点不晚于下一次状态切换，并随切窗立即到期', async () => {
  const store = schedule.getStore('store-shanghai');
  const current = schedule.liveStatus(store.id, Date.now());
  assert.ok(current.stateChangedAt > Date.now());
  const now = Date.now();
  const expiresAt = schedule.cacheExpiryForStatuses(now, [current]);
  assert.ok(expiresAt <= current.stateChangedAt + 1000);
  assert.ok(expiresAt > now);
  assert.ok(expiresAt <= now + schedule.MAX_CACHE_MS);
  assert.throws(() => {
    queries.listMatches('missing-version', { now: current.stateChangedAt + 1000 });
  }, /不存在/);
});

test('DST 重复时刻是两个可报名实际场次，回执绑定不同 UTC 开始时间', async () => {
  const first = await eventsApi.register('event-dst-fold-first', { attendeeName: '早场读者', seats: 1 }, Date.now());
  const second = await eventsApi.register('event-dst-fold-last', { attendeeName: '晚场读者', seats: 1 }, Date.now());
  assert.equal(new Date(first.registration.actualSession.startsAt).toISOString(), '2026-11-01T08:30:00.000Z');
  assert.equal(new Date(second.registration.actualSession.startsAt).toISOString(), '2026-11-01T09:30:00.000Z');
  assert.equal(new Date(first.registration.actualSession.endsAt).toISOString(), new Date(second.registration.actualSession.endsAt).toISOString());
  assert.notEqual(first.registration.confirmationCode, second.registration.confirmationCode);
});

test('HTTP 边界：未知门店和无效参数返回结构化错误', async () => {
  const missing = await jsonFetch('/api/stores/no-such-store');
  assert.equal(missing.status, 404);
  const badAt = await jsonFetch('/api/stores?at=not-a-date');
  assert.equal(badAt.status, 400);
  const bad = await jsonFetch('/api/query-versions', {
    method: 'POST', body: JSON.stringify({ minSeats: -3 })
  });
  assert.equal(bad.status, 400);
});
