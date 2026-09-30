import { rmSync } from 'node:fs';
import { openDb } from './db.js';
import { addException } from './schedule.js';
import {
  authorizeSession,
  createEvent,
  createStore,
  mergeStores,
  renameStore
} from './repositories.js';

const DB_PATH = process.env.DB_PATH || './data/bookstores.sqlite';
try {
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
} catch {}

const db = openDb(DB_PATH);
const now = Date.parse('2026-09-30T12:00:00Z');

const stores = [
  {
    id: 'st_inkwell',
    slug: 'inkwell-attic',
    name: '墨井阁楼',
    city: '上海',
    address: '安福路藏书弄 18 号 2 楼',
    lat: 31.2156,
    lng: 121.4376,
    timezone: 'Asia/Shanghai',
    description: '文学夜读、阁楼靠窗座和小型译者沙龙。',
    themes: ['文学小说', '诗歌戏剧', '二手珍本'],
    seats: { 靠窗座: 8, 安静自习: 14, 咖啡座: 10, 沙发: 5, 无障碍: 2 },
    weeklyHours: [
      { weekday: 0, startClock: '11:00', endClock: '22:00' },
      { weekday: 1, startClock: '11:00', endClock: '22:00' },
      { weekday: 2, startClock: '11:00', endClock: '23:30' },
      { weekday: 3, startClock: '11:00', endClock: '23:30' },
      { weekday: 4, startClock: '11:00', endClock: '24:00' },
      { weekday: 5, startClock: '10:00', endClock: '24:00' },
      { weekday: 6, startClock: '10:00', endClock: '21:00' }
    ]
  },
  {
    id: 'st_paperboat',
    slug: 'paper-boat',
    name: '纸船儿童书局',
    city: '杭州',
    address: '西溪路河岸 3 号',
    lat: 30.2741,
    lng: 120.1551,
    timezone: 'Asia/Shanghai',
    description: '绘本墙、亲子软垫和周末故事剧场。',
    themes: ['儿童绘本', '漫画图像小说', '艺术设计'],
    seats: { 亲子: 18, 沙发: 8, 咖啡座: 6, 无障碍: 3 },
    weeklyHours: [
      { weekday: 1, startClock: '09:30', endClock: '18:00' },
      { weekday: 2, startClock: '09:30', endClock: '18:00' },
      { weekday: 3, startClock: '09:30', endClock: '20:00' },
      { weekday: 4, startClock: '09:30', endClock: '20:00' },
      { weekday: 5, startClock: '09:00', endClock: '21:00' },
      { weekday: 6, startClock: '09:00', endClock: '18:00' }
    ]
  },
  {
    id: 'st_quietmargin',
    slug: 'quiet-margin',
    name: '白边书房',
    city: '北京',
    address: '美术馆东街甲 7 号',
    lat: 39.9355,
    lng: 116.4183,
    timezone: 'Asia/Shanghai',
    description: '社科思想、展览图录和深夜长桌自习。',
    themes: ['社科思想', '艺术设计', '文学小说'],
    seats: { 安静自习: 24, 长桌: 16, 咖啡座: 8, 无障碍: 2 },
    weeklyHours: [
      { weekday: 0, startClock: '10:00', endClock: '22:00' },
      { weekday: 1, startClock: '10:00', endClock: '22:00' },
      { weekday: 2, startClock: '10:00', endClock: '22:00' },
      { weekday: 3, startClock: '10:00', endClock: '23:59' },
      { weekday: 4, startClock: '10:00', endClock: '24:00' },
      { weekday: 5, startClock: '09:30', endClock: '24:00' },
      { weekday: 6, startClock: '09:30', endClock: '20:00' }
    ]
  },
  {
    id: 'st_redthread',
    slug: 'red-thread',
    name: '红线推理室',
    city: '成都',
    address: '玉林西路 12 号院',
    lat: 30.6301,
    lng: 104.0668,
    timezone: 'Asia/Shanghai',
    description: '推理悬疑、二手珍本与围炉读书会。',
    themes: ['推理悬疑', '二手珍本', '漫画图像小说'],
    seats: { 沙发: 9, 咖啡座: 11, 庭院: 12, 无障碍: 2 },
    weeklyHours: [
      { weekday: 1, startClock: '13:00', endClock: '22:00' },
      { weekday: 2, startClock: '13:00', endClock: '22:00' },
      { weekday: 3, startClock: '13:00', endClock: '23:00' },
      { weekday: 4, startClock: '13:00', endClock: '01:00' },
      { weekday: 5, startClock: '11:00', endClock: '01:00' },
      { weekday: 6, startClock: '11:00', endClock: '20:00' }
    ]
  },
  {
    id: 'st_nightferry',
    slug: 'night-ferry',
    name: '夜渡诗社',
    city: '广州',
    address: '沿江中路旧仓 21 号',
    lat: 23.11,
    lng: 113.264,
    timezone: 'Asia/Shanghai',
    description: '女性写作、诗歌夜会与江风沙发座。',
    themes: ['诗歌戏剧', '女性写作', '文学小说'],
    seats: { 沙发: 10, 靠窗座: 6, 咖啡座: 7, 无障碍: 1 },
    weeklyHours: [
      { weekday: 2, startClock: '14:00', endClock: '23:00' },
      { weekday: 3, startClock: '14:00', endClock: '23:00' },
      { weekday: 4, startClock: '14:00', endClock: '02:00' },
      { weekday: 5, startClock: '12:00', endClock: '02:00' },
      { weekday: 6, startClock: '12:00', endClock: '21:00' }
    ]
  },
  {
    id: 'st_fall_shelf',
    slug: 'fall-shelf-dst',
    name: '回拨书架',
    city: 'New York',
    address: '118 Bergen Street',
    lat: 40.6836,
    lng: -73.9712,
    timezone: 'America/New_York',
    description: '用于人工验收秋季 DST 重复 01:00 的实验书店。',
    themes: ['二手珍本', '文学小说'],
    seats: { 安静自习: 6, 咖啡座: 4 },
    weeklyHours: [{ weekday: 6, startClock: '01:00', endClock: '01:30' }]
  },
  {
    id: 'st_spring_shelf',
    slug: 'spring-shelf-dst',
    name: '春跳书屋',
    city: 'New York',
    address: '27 Franklin Avenue',
    lat: 40.6814,
    lng: -73.9579,
    timezone: 'America/New_York',
    description: '用于人工验收春季 DST 02:30 不存在时段的顺延规则。',
    themes: ['艺术设计', '诗歌戏剧'],
    seats: { 靠窗座: 5, 沙发: 3 },
    weeklyHours: [{ weekday: 6, startClock: '02:30', endClock: '03:30' }]
  },
  {
    id: 'st_old_lantern',
    slug: 'old-lantern',
    name: '旧灯笼书局',
    city: '苏州',
    address: '平江路支巷 6 号',
    lat: 31.3225,
    lng: 120.6285,
    timezone: 'Asia/Shanghai',
    description: '待手工更名的历史门店。',
    themes: ['二手珍本', '艺术设计'],
    seats: { 庭院: 7, 咖啡座: 5 },
    weeklyHours: [
      { weekday: 4, startClock: '12:00', endClock: '21:00' },
      { weekday: 5, startClock: '10:00', endClock: '22:00' },
      { weekday: 6, startClock: '10:00', endClock: '18:00' }
    ]
  },
  {
    id: 'st_letterdock',
    slug: 'letter-dock',
    name: '信札码头',
    city: '苏州',
    address: '干将东路河埠 9 号',
    lat: 31.3017,
    lng: 120.6381,
    timezone: 'Asia/Shanghai',
    description: '可承接合并门店的会员与活动。',
    themes: ['文学小说', '社科思想', '二手珍本'],
    seats: { 安静自习: 12, 咖啡座: 9, 庭院: 6, 无障碍: 2 },
    weeklyHours: [
      { weekday: 1, startClock: '10:00', endClock: '21:00' },
      { weekday: 2, startClock: '10:00', endClock: '21:00' },
      { weekday: 3, startClock: '10:00', endClock: '22:00' },
      { weekday: 4, startClock: '10:00', endClock: '22:00' },
      { weekday: 5, startClock: '09:30', endClock: '22:00' },
      { weekday: 6, startClock: '09:30', endClock: '18:00' }
    ]
  }
];

for (const store of stores) createStore(db, store, now);

// 临时闭店优先于常规营业。
addException(db, 'st_inkwell', 'closed', '国庆盘点临时闭店', '2026-10-05T00:00', '2026-10-05T24:00', '全天库存盘点', now);
// 常规周一不营业；临时加开不应覆盖闭店，也不应自动授权闭店活动。
addException(db, 'st_nightferry', 'closed', '台风临时闭店', '2026-10-09T18:00', '2026-10-10T02:00', '活动需逐场显式授权', now);
addException(db, 'st_paperboat', 'open', '市集加开早场', '2026-10-05T08:00', '2026-10-05T12:00', '户外绘本市集', now);

const lastSeat = createEvent(db, {
  id: 'ev_last_seat',
  sessionId: 'es_last_seat',
  storeId: 'st_inkwell',
  title: '译者的最后一盏灯：单席朗读',
  description: '只开放一个席位的深夜译本试读。',
  theme: '诗歌戏剧',
  date: '2026-10-03',
  startTime: '19:30',
  endTime: '21:00',
  capacity: 1
}, now);

const unauthorizedClosed = createEvent(db, {
  id: 'ev_unauthorized_closed',
  sessionId: 'es_unauthorized_closed',
  storeId: 'st_nightferry',
  title: '未授权的台风夜私场',
  description: '闭店期间测试：不能自动取消，也不能自动放行。',
  theme: '诗歌戏剧',
  date: '2026-10-09',
  startTime: '21:00',
  endTime: '23:00',
  capacity: 8,
  isPrivate: true
}, now);

const privateClosed = createEvent(db, {
  id: 'ev_authorized_closed',
  sessionId: 'es_authorized_closed',
  storeId: 'st_nightferry',
  title: '江堤黑胶闭店专场',
  description: '已由店主显式授权的闭店私场。',
  theme: '艺术设计',
  date: '2026-10-09',
  startTime: '23:30',
  endTime: '00:30',
  capacity: 6,
  isPrivate: true
}, now);
authorizeSession(db, 'es_authorized_closed', '店主确认台风夜仅接待预约会员，专人值守', 'seed-admin', now);

createEvent(db, {
  id: 'ev_fall_first',
  sessionId: 'es_fall_first',
  storeId: 'st_fall_shelf',
  title: '回拨前的第一本日记',
  theme: '文学小说',
  date: '2026-11-01',
  startTime: '01:00',
  endTime: '01:20',
  capacity: 4,
  disambiguation: 'first'
}, now);
createEvent(db, {
  id: 'ev_fall_second',
  sessionId: 'es_fall_second',
  storeId: 'st_fall_shelf',
  title: '回拨后的第二本日记',
  theme: '文学小说',
  date: '2026-11-01',
  startTime: '01:00',
  endTime: '01:20',
  capacity: 4,
  disambiguation: 'second'
}, now);
createEvent(db, {
  id: 'ev_spring_gap',
  sessionId: 'es_spring_gap',
  storeId: 'st_spring_shelf',
  title: '不存在的 02:30 诗会',
  theme: '诗歌戏剧',
  date: '2027-03-14',
  startTime: '02:30',
  endTime: '03:30',
  capacity: 5,
  disambiguation: 'compatible'
}, now);

// 演示更名历史；合并由边界测试显式执行，避免种子数据隐藏关键传播路径。
renameStore(db, 'st_old_lantern', '新灯笼书局', 'seed-admin', now);

console.log(JSON.stringify({
  ok: true,
  database: DB_PATH,
  stores: stores.length,
  sessions: {
    lastSeat: lastSeat.session.id,
    unauthorizedClosed: unauthorizedClosed.session.id,
    authorizedClosed: privateClosed.session.id
  }
}, null, 2));
