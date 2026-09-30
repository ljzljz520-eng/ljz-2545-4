'use strict';

const crypto = require('crypto');
const dbApi = require('./db');
const schedule = require('./schedule');

function code() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(8);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `BB-${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

function getEvent(id) {
  return dbApi.one(`SELECT * FROM event_sessions WHERE id=?`, [id]);
}

function getRegistration(id) {
  return dbApi.one(`SELECT * FROM registrations WHERE id=? OR confirmation_code=?`, [id, id]);
}

function serializeRegistration(reg) {
  return {
    id: reg.id,
    confirmationCode: reg.confirmation_code,
    eventId: reg.event_id,
    attendeeName: reg.attendee_name,
    attendeeContact: reg.attendee_contact,
    seats: reg.seats,
    status: reg.status,
    createdAt: reg.created_at,
    actualSession: {
      storeId: reg.actual_store_id,
      storeName: reg.actual_store_name_at_booking,
      title: reg.actual_title_at_booking,
      startsAt: reg.actual_start_at,
      endsAt: reg.actual_end_at,
      timeZone: reg.actual_time_zone,
      sessionVersion: reg.actual_session_version
    }
  };
}

async function register(eventId, body = {}, now = Date.now()) {
  const attendeeName = String(body.attendeeName || '').trim();
  const attendeeContact = String(body.attendeeContact || '').trim();
  const seats = Number(body.seats || 1);
  if (!attendeeName) {
    const err = new Error('attendeeName 必填');
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isInteger(seats) || seats < 1 || seats > 20) {
    const err = new Error('报名席位数必须是 1-20 的整数');
    err.statusCode = 400;
    throw err;
  }

  // BEGIN IMMEDIATE serializes last-seat races with sql.js's single writer.
  return dbApi.transaction((ctx) => {
    const event = ctx.one(`SELECT * FROM event_sessions WHERE id=?`, [eventId]);
    if (!event) {
      const err = new Error('活动不存在');
      err.statusCode = 404;
      throw err;
    }
    if (event.status !== 'scheduled' || event.ends_at < now) {
      const err = new Error('活动已取消或已结束');
      err.statusCode = 409;
      throw err;
    }
    if (event.starts_at < now) {
      const err = new Error('活动已经开始，停止报名');
      err.statusCode = 409;
      throw err;
    }
    if (event.requires_closed_authorization) {
      const auth = ctx.one(
        `SELECT id FROM event_closed_authorizations WHERE event_id=? AND fingerprint=?`,
        [event.id, event.closed_fingerprint]
      );
      if (!auth) {
        const err = new Error('闭店专场尚未显式授权，不能报名，也不会自动放行');
        err.statusCode = 403;
        err.code = 'CLOSED_EVENT_UNAUTHORIZED';
        err.fingerprint = event.closed_fingerprint;
        throw err;
      }
    }
    ctx.run(
      `UPDATE event_sessions SET remaining = remaining - ?, updated_at=?
       WHERE id=? AND remaining >= ? AND status='scheduled'`,
      [seats, now, event.id, seats]
    );
    if (ctx.getDb().getRowsModified() === 0) {
      const err = new Error('最后席位已被其他请求抢占');
      err.statusCode = 409;
      err.code = 'NO_SEATS_AVAILABLE';
      throw err;
    }
    const fresh = ctx.one(`SELECT * FROM event_sessions WHERE id=?`, [event.id]);
    const store = ctx.one(`SELECT * FROM stores WHERE id=?`, [event.store_id]);
    const id = `reg_${crypto.randomBytes(12).toString('hex')}`;
    const confirmation = code();
    ctx.run(
      `INSERT INTO registrations
        (id, event_id, attendee_name, attendee_contact, seats, status,
         actual_store_id, actual_store_name_at_booking, actual_title_at_booking,
         actual_start_at, actual_end_at, actual_time_zone, actual_session_version,
         confirmation_code, created_at)
       VALUES (?,?,?,?,?, 'confirmed', ?,?,?,?,?,?,?,?,?)`,
      [id, event.id, attendeeName, attendeeContact, seats, store.id, store.name,
       event.title, event.starts_at, event.ends_at, store.time_zone,
       event.session_version, confirmation, now]
    );
    ctx.bumpMeta('data_version');
    const reg = ctx.one(`SELECT * FROM registrations WHERE id=?`, [id]);
    return {
      registration: serializeRegistration(reg),
      remaining: fresh.remaining,
      capacity: fresh.capacity
    };
  });
}

async function cancelRegistration(registrationId, now = Date.now()) {
  return dbApi.transaction((ctx) => {
    const reg = ctx.one(`SELECT * FROM registrations WHERE id=? OR confirmation_code=?`, [registrationId, registrationId]);
    if (!reg) {
      const err = new Error('回执不存在');
      err.statusCode = 404;
      throw err;
    }
    if (reg.status === 'canceled') return { registration: serializeRegistration(reg), refundedSeats: 0 };
    if (reg.actual_start_at < now) {
      const err = new Error('活动开始后不能自助取消');
      err.statusCode = 409;
      throw err;
    }
    ctx.run(`UPDATE registrations SET status='canceled' WHERE id=?`, [reg.id]);
    ctx.run(
      `UPDATE event_sessions SET remaining=remaining+?, updated_at=? WHERE id=? AND status='scheduled'`,
      [reg.seats, now, reg.event_id]
    );
    ctx.bumpMeta('data_version');
    return { registration: serializeRegistration(ctx.one(`SELECT * FROM registrations WHERE id=?`, [reg.id])), refundedSeats: reg.seats };
  });
}

async function grantClosedEvent(eventId, actor, note, now = Date.now()) {
  return dbApi.transaction((ctx) => {
    const event = ctx.one(`SELECT * FROM event_sessions WHERE id=?`, [eventId]);
    if (!event) {
      const err = new Error('活动不存在');
      err.statusCode = 404;
      throw err;
    }
    if (event.status !== 'scheduled' || event.ends_at < now) {
      const err = new Error('活动不可授权：已取消或已结束');
      err.statusCode = 409;
      throw err;
    }
    // Recompute from live weekly hours + exceptions inside the same transaction.
    // No closed event is auto-authorized.
    const assessment = schedule.withScheduleContext(ctx, () => schedule.assessClosedEvent(event));
    if (!assessment.requiresAuthorization) {
      const err = new Error('该活动位于营业时段，无需闭店专场授权');
      err.statusCode = 409;
      err.assessment = assessment;
      throw err;
    }
    ctx.run(
      `INSERT INTO event_closed_authorizations(event_id, fingerprint, granted_by, granted_at, note)
       VALUES (?,?,?,?,?)
       ON CONFLICT(event_id, fingerprint) DO UPDATE SET granted_by=excluded.granted_by,
         granted_at=excluded.granted_at, note=excluded.note`,
      [eventId, assessment.fingerprint, actor, now, note || '']
    );
    ctx.run(
      `UPDATE event_sessions SET requires_closed_authorization=1, closed_fingerprint=?, updated_at=? WHERE id=?`,
      [assessment.fingerprint, now, eventId]
    );
    ctx.bumpMeta('data_version');
    schedule.invalidateQueryVersionsInTx(ctx, now, 'closed-event authorization changed');
    return { ok: true, eventId, ...assessment, authorized: true, grantedAt: now };
  });
}

module.exports = {
  cancelRegistration,
  getEvent,
  getRegistration,
  grantClosedEvent,
  register,
  serializeRegistration
};
