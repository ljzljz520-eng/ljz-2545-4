'use strict';

const crypto = require('crypto');
const { wallToUtc, zonedParts } = require('./tz');

const NOW = Date.now();

function uuid() {
  return crypto.randomUUID();
}

function insertStore(db, s) {
  db.run(
    `INSERT INTO stores
      (id, slug, name, name_history, merged_into_id, active, description, address,
       lat, lng, time_zone, themes_json, seats_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      s.id, s.slug, s.name, JSON.stringify(s.nameHistory || [s.name]),
      s.mergedInto || null, s.active === false ? 0 : 1, s.description, s.address,
      s.lat, s.lng, s.timeZone, JSON.stringify(s.themes), JSON.stringify(s.seats),
      NOW, NOW
    ]
  );
  for (const h of s.hours || []) {
    db.run(
      `INSERT INTO weekly_hours(store_id, weekday, start_minute, end_minute, note)
       VALUES (?,?,?,?,?)`,
      [s.id, h.weekday, h.start, h.end, h.note || '']
    );
  }
  for (const e of s.exceptions || []) {
    db.run(
      `INSERT INTO schedule_exceptions(store_id, local_date, kind, start_minute, end_minute, reason, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [s.id, e.date, e.kind, e.start ?? null, e.end ?? null, e.reason || '', NOW]
    );
  }
}

function addHoursClock(h, m) {
  return h * 60 + m;
}

// Build a demo event in local wall time. wallToUtc chooses the first DST fold
// occurrence; explicit DST tests insert both occurrences below.
function event(db, e) {
  const start = wallToUtc(...e.startDate, e.startHour, e.startMinute, e.timeZone, 'first');
  const end = wallToUtc(...e.endDate || e.startDate, e.endHour, e.endMinute, e.timeZone, 'first');
  const id = e.id || `event-${uuid()}`;
  db.run(
    `INSERT INTO event_sessions
      (id, store_id, title, description, starts_at, ends_at, capacity, remaining,
       requires_closed_authorization, closed_fingerprint, status, session_version,
       created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'scheduled',1,?,?)`,
    [id, e.storeId, e.title, e.description || '', start, end, e.capacity,
     e.capacity, e.requiresAuth ? 1 : 0, e.requiresAuth ? 'unauthorized-initial' : null, NOW, NOW]
  );
  return id;
}

async function seedDatabase(db) {
  const stores = [
    {
      id: 'store-brooklyn',
      slug: 'brooklyn-night-reader',
      name: '夜读者书店',
      description: '桥影下的社科、推理与黑胶听读角；深夜营业，窗边座有插座。',
      address: '58 Front St, Brooklyn, NY',
      lat: 40.7025,
      lng: -73.994,
      timeZone: 'America/New_York',
      themes: ['文学', '推理', '社科', '黑胶'],
      seats: [
        { type: '窗边座', count: 8, features: ['插座', '安静'] },
        { type: '咖啡座', count: 18, features: ['可交谈'] },
        { type: '活动椅', count: 40, features: ['投影'] }
      ],
      hours: [
        ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: addHoursClock(8, 0), end: addHoursClock(23, 30) })),
        { weekday: 6, start: addHoursClock(9, 0), end: addHoursClock(1, 30), note: '跨午夜' },
        { weekday: 7, start: addHoursClock(9, 0), end: addHoursClock(1, 30), note: '跨午夜' }
      ]
    },
    {
      id: 'store-london',
      slug: 'fog-and-quarto',
      name: '雾港四开本',
      description: '诗集、戏剧本与旅行文学；二楼壁炉旁适合读书会。',
      address: "12 Lamb's Passage, London",
      lat: 51.5205,
      lng: -0.0918,
      timeZone: 'Europe/London',
      themes: ['诗歌', '戏剧', '旅行', '艺术'],
      seats: [
        { type: '壁炉沙发', count: 6, features: ['安静'] },
        { type: '长桌', count: 20, features: ['插座'] },
        { type: '活动椅', count: 35 }
      ],
      hours: [
        ...[1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: addHoursClock(8, 30), end: addHoursClock(22, 0) })),
        { weekday: 7, start: addHoursClock(10, 0), end: addHoursClock(20, 0) }
      ]
    },
    {
      id: 'store-shanghai',
      slug: 'suzhou-creek-maple',
      name: '苏州河枫页',
      description: '漫画、电影书和独立杂志；凌晨仍开放的城市写作室。',
      address: '中国上海市静安区苏州河畔',
      lat: 31.245,
      lng: 121.456,
      timeZone: 'Asia/Shanghai',
      themes: ['漫画', '电影', '独立杂志', '城市'],
      seats: [
        { type: '河岸窗座', count: 10, features: ['插座', '夜景'] },
        { type: '沉默隔间', count: 5, features: ['隔音'] },
        { type: '活动椅', count: 28 }
      ],
      hours: [
        ...[1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: addHoursClock(10, 0), end: addHoursClock(2, 0), note: '跨午夜' }))
      ]
    },
    {
      id: 'store-tokyo',
      slug: 'jimbocho-neko',
      name: '神保町猫亭',
      description: '俳句、摄影集与手工书；榻榻米座位需脱鞋。',
      address: '日本東京都千代田区神田神保町',
      lat: 35.696,
      lng: 139.76,
      timeZone: 'Asia/Tokyo',
      themes: ['俳句', '摄影', '手工书', '儿童文学'],
      seats: [
        { type: '榻榻米', count: 12, features: ['脱鞋', '安静'] },
        { type: '吧台', count: 7, features: ['插座'] },
        { type: '活动椅', count: 24 }
      ],
      hours: [
        ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: addHoursClock(11, 0), end: addHoursClock(21, 0) })),
        { weekday: 6, start: addHoursClock(10, 0), end: addHoursClock(22, 0) },
        { weekday: 7, start: addHoursClock(10, 0), end: addHoursClock(20, 0) }
      ]
    },
    {
      id: 'store-portland',
      slug: 'pine-and-foldout',
      name: '松林折页',
      description: '自然写作、地图与科幻；夏令时重复时刻保留两场夜读。',
      address: '33 NW Park Ave, Portland, OR',
      lat: 45.5235,
      lng: -122.684,
      timeZone: 'America/Los_Angeles',
      themes: ['自然写作', '地图', '科幻', '环保'],
      seats: [
        { type: '森林窗座', count: 9, features: ['安静'] },
        { type: '折叠长桌', count: 16, features: ['插座'] },
        { type: '活动椅', count: 30 }
      ],
      hours: [
        ...[1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: addHoursClock(7, 0), end: addHoursClock(23, 0) })),
        { weekday: 7, start: addHoursClock(1, 0), end: addHoursClock(3, 0), note: '冬令时重复时段：01:00-03:00 两个实例' },
        { weekday: 7, start: addHoursClock(7, 0), end: addHoursClock(23, 0) }
      ]
    },
    {
      id: 'store-berlin',
      slug: 'keller-notizen',
      name: '地窖笔记',
      description: '哲学、音乐理论与 zine；地下室常有小型演出。',
      address: 'Kastanienallee, Berlin',
      lat: 52.537,
      lng: 13.402,
      timeZone: 'Europe/Berlin',
      themes: ['哲学', '音乐', 'zine', '艺术'],
      seats: [
        { type: '地窖台阶', count: 12 },
        { type: '长桌', count: 14, features: ['插座'] },
        { type: '活动椅', count: 50 }
      ],
      hours: [
        ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: addHoursClock(9, 0), end: addHoursClock(20, 0) })),
        { weekday: 6, start: addHoursClock(10, 0), end: addHoursClock(22, 0) },
        { weekday: 7, start: addHoursClock(11, 0), end: addHoursClock(18, 0) }
      ]
    },
    {
      id: 'store-old-voyage',
      slug: 'old-night-voyage',
      name: '夜航书铺（已并入）',
      nameHistory: ['夜航书铺'],
      mergedInto: 'store-brooklyn',
      active: false,
      description: '历史门店，已并入夜读者书店。',
      address: '旧地址（已关闭）',
      lat: 40.704,
      lng: -73.989,
      timeZone: 'America/New_York',
      themes: ['旅行'],
      seats: [],
      hours: []
    }
  ];

  for (const s of stores) insertStore(db, s);

  const p = zonedParts(NOW, 'America/New_York');
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day) + 86400000);
  event(db, {
    id: 'event-last-seat',
    storeId: 'store-brooklyn',
    title: '最后席位：短篇交享夜',
    description: '三人朗读与编辑点评；用于并发抢占验收。',
    startDate: [tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate()],
    startHour: 19, startMinute: 0,
    endHour: 20, endMinute: 30,
    capacity: 1,
    timeZone: 'America/New_York'
  });
  event(db, {
    id: 'event-london-after-hours',
    storeId: 'store-london',
    title: '壁炉闭店专场：手抄诗工作坊',
    description: '活动发生在常规闭店后，必须由店长显式授权。',
    startDate: [tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate()],
    startHour: 22, startMinute: 30,
    endHour: 23, endMinute: 30,
    capacity: 12,
    requiresAuth: true,
    timeZone: 'Europe/London'
  });

  const sh = zonedParts(NOW + 2 * 86400000, 'Asia/Shanghai');
  event(db, {
    id: 'event-shanghai-dawn',
    storeId: 'store-shanghai',
    title: '凌晨译者校对室',
    description: '跨午夜排程后的闭店/营业边界示范。',
    startDate: [sh.year, sh.month, sh.day],
    startHour: 0, startMinute: 30,
    endHour: 1, endMinute: 30,
    capacity: 8,
    requiresAuth: true,
    timeZone: 'Asia/Shanghai'
  });

  // 2026-11-01 01:30 occurs twice in Los Angeles. Two actual sessions are kept.
  for (const [suffix, occurrence] of [['第一次', 'first'], ['第二次', 'last']]) {
    const start = wallToUtc(2026, 11, 1, 1, 30, 'America/Los_Angeles', occurrence);
    // Each reading is one physical hour. Both therefore end at the first
    // unambiguous 02:30 after the fall-back transition.
    const end = wallToUtc(2026, 11, 1, 2, 30, 'America/Los_Angeles', 'first');
    db.run(
      `INSERT INTO event_sessions
        (id, store_id, title, description, starts_at, ends_at, capacity, remaining,
         requires_closed_authorization, closed_fingerprint, status, session_version,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,0,NULL,'scheduled',1,?,?)`,
      [`event-dst-fold-${occurrence}`, 'store-portland',
       `冬令时重复时刻朗读（${suffix}）`, '同一个墙上时间的两个实际 UTC 场次，回执分别绑定。',
       start, end, 6, 6, NOW, NOW]
    );
  }

  db.setMeta('initialized_at', new Date(NOW).toISOString());
  db.setMeta('schema_version', '1');
  db.setMeta('data_version', '1');
  db.setMeta('schedule_version', '0');
  db.setMeta('schedule_horizon_epoch', '0');
  db.setMeta('schedule_horizon_local_date', '');
}

module.exports = { seedDatabase };
