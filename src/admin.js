'use strict';

const dbApi = require('./db');
const schedule = require('./schedule');
const tz = require('./tz');

function audit(ctx, action, targetType, targetId, before, after, actor, now) {
  ctx.run(
    `INSERT INTO admin_audit_log(action,target_type,target_id,before_json,after_json,actor,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [action, targetType, targetId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, actor, now]
  );
}

function assertStore(ctx, id) {
  const s = ctx.one(`SELECT * FROM stores WHERE id=?`, [id]);
  if (!s) {
    const err = new Error('门店不存在');
    err.statusCode = 404;
    throw err;
  }
  return s;
}

async function addException(storeId, body, actor, now = Date.now()) {
  const localDate = String(body.localDate || '');
  tz.parseLocalDate(localDate);
  const kind = body.kind === 'modified' ? 'modified' : 'closed';
  let startMinute = null;
  let endMinute = null;
  if (kind === 'modified') {
    startMinute = Number(body.startMinute);
    endMinute = Number(body.endMinute);
    if (![startMinute, endMinute].every((n) => Number.isInteger(n) && n >= 0 && n <= 1439) || startMinute === endMinute) {
      const err = new Error('临时营业时段需要不同的 0-1439 分钟；end<start 表示跨午夜，锚日为开场日');
      err.statusCode = 400;
      throw err;
    }
  }
  return dbApi.transaction((ctx) => {
    const store = assertStore(ctx, storeId);
    const before = { exceptions: ctx.all(`SELECT * FROM schedule_exceptions WHERE store_id=? AND local_date=?`, [storeId, localDate]) };
    // A correction replaces any earlier draft for the same date, but closed remains dominant.
    ctx.run('DELETE FROM schedule_exceptions WHERE store_id=? AND local_date=?', [storeId, localDate]);
    ctx.run(
      `INSERT INTO schedule_exceptions(store_id, local_date, kind, start_minute, end_minute, reason, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [storeId, localDate, kind, startMinute, endMinute, String(body.reason || ''), now]
    );
    audit(ctx, 'add_exception', 'store', storeId, before, body, actor, now);
    schedule.regenerateSchedulesInTx(ctx, now, { bumpVersion: true });
    ctx.bumpMeta('data_version');
    return { ok: true, storeId: store.name, localDate, kind };
  });
}

async function clearException(storeId, localDate, actor, now = Date.now()) {
  tz.parseLocalDate(localDate);
  return dbApi.transaction((ctx) => {
    assertStore(ctx, storeId);
    const before = ctx.all(`SELECT * FROM schedule_exceptions WHERE store_id=? AND local_date=?`, [storeId, localDate]);
    if (!before.length) {
      const err = new Error('该日期没有临时例外');
      err.statusCode = 404;
      throw err;
    }
    ctx.run('DELETE FROM schedule_exceptions WHERE store_id=? AND local_date=?', [storeId, localDate]);
    audit(ctx, 'clear_exception', 'store', storeId, { exceptions: before }, { localDate }, actor, now);
    schedule.regenerateSchedulesInTx(ctx, now, { bumpVersion: true });
    ctx.bumpMeta('data_version');
    return { ok: true, localDate };
  });
}

async function renameStore(storeId, newName, actor, now = Date.now()) {
  newName = String(newName || '').trim();
  if (newName.length < 2 || newName.length > 80) {
    const err = new Error('新名称长度需为 2-80');
    err.statusCode = 400;
    throw err;
  }
  return dbApi.transaction((ctx) => {
    const store = assertStore(ctx, storeId);
    if (store.name === newName) {
      const err = new Error('名称未变化');
      err.statusCode = 409;
      throw err;
    }
    const history = JSON.parse(store.name_history);
    if (!history.includes(newName)) history.push(newName);
    ctx.run('UPDATE stores SET name=?, name_history=?, updated_at=? WHERE id=?', [newName, JSON.stringify(history), now, storeId]);
    audit(ctx, 'rename_store', 'store', storeId, { name: store.name, nameHistory: JSON.parse(store.name_history) }, { name: newName, nameHistory: history }, actor, now);
    ctx.bumpMeta('data_version');
    schedule.invalidateQueryVersionsInTx(ctx, now, 'store renamed');
    return { ok: true, storeId, name: newName, nameHistory: history };
  });
}

async function mergeStore(sourceId, targetId, actor, now = Date.now()) {
  if (sourceId === targetId) {
    const err = new Error('不能并入自身');
    err.statusCode = 400;
    throw err;
  }
  return dbApi.transaction((ctx) => {
    const source = assertStore(ctx, sourceId);
    const target = assertStore(ctx, targetId);
    if (!target.active || target.merged_into_id) {
      const err = new Error('目标门店必须是当前有效门店');
      err.statusCode = 400;
      throw err;
    }
    const before = { source: { active: source.active, mergedInto: source.merged_into_id, name: source.name } };
    const registeredFuture = ctx.one(
      `SELECT COUNT(*) AS n FROM event_sessions e
       JOIN registrations r ON r.event_id=e.id AND r.status='confirmed'
       WHERE e.store_id=? AND e.status='scheduled' AND e.ends_at>?`,
      [sourceId, now]
    );
    if (Number(registeredFuture.n) > 0) {
      const err = new Error('源店尚有未来已报名活动，不能自动合并；请先逐场人工迁移或取消');
      err.statusCode = 409;
      throw err;
    }
    // Transfer unbooked future sessions to the surviving store; receipts of
    // past sessions intentionally retain their original actual store snapshot.
    ctx.run(`UPDATE event_sessions SET store_id=?, updated_at=? WHERE store_id=? AND status='scheduled' AND ends_at>=?`, [targetId, now, sourceId, now]);
    const mergedName = `${source.name}（已并入 ${target.name}）`;
    const history = JSON.parse(source.name_history);
    history.push(mergedName);
    ctx.run(
      `UPDATE stores SET active=0, merged_into_id=?, name=?, name_history=?, updated_at=? WHERE id=?`,
      [targetId, mergedName, JSON.stringify(history), now, sourceId]
    );
    audit(ctx, 'merge_store', 'store', sourceId, before, { targetId, targetName: target.name, mergedName }, actor, now);
    schedule.regenerateSchedulesInTx(ctx, now, { bumpVersion: true });
    ctx.bumpMeta('data_version');
    return { ok: true, sourceId, targetId, mergedName };
  });
}

async function rebuildSchedules(actor, now = Date.now()) {
  return dbApi.transaction((ctx) => {
    const result = schedule.regenerateSchedulesInTx(ctx, now, { bumpVersion: true });
    audit(ctx, 'rebuild_schedules', 'system', 'all', null, result, actor, now);
    return { ok: true, ...result };
  });
}

module.exports = { addException, clearException, mergeStore, rebuildSchedules, renameStore };
