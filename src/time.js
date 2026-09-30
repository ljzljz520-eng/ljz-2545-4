// 不引入第三方时区库：用宿主 Intl 元数据构造偏移表。
// 关键原则：门店当地挂钟时间必须先消歧，再换算成 UTC 实例；浏览器日期不参与截断。

const offsetCache = new Map();
const tableCache = new Map();

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function partsFor(timeZone, whenMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    era: 'narrow'
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(whenMs)).map(p => [p.type, p.value]));
  return parts;
}

export function utcOffsetMs(timeZone, whenMs) {
  let cache = offsetCache.get(timeZone);
  if (!cache) {
    cache = new Map();
    offsetCache.set(timeZone, cache);
  }
  const bucket = Math.floor(whenMs / HOUR);
  const hit = cache.get(bucket);
  if (hit !== undefined) return hit;

  const p = partsFor(timeZone, whenMs);
  const year = Number(p.year) + (p.era === 'B' ? -1 : 0);
  const asUtc = Date.UTC(year, Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second));
  const offset = asUtc - whenMs;
  cache.set(bucket, offset);
  return offset;
}

function transitionAt(timeZone, beforeMs, afterMs) {
  // 将偏移变化点缩到一分钟。绝大多数民用 DST 变化发生在整分钟。
  let lo = beforeMs;
  let hi = afterMs;
  const leftOffset = utcOffsetMs(timeZone, lo);
  while (hi - lo > MINUTE) {
    const mid = Math.floor((lo + hi) / 2 / MINUTE) * MINUTE;
    if (utcOffsetMs(timeZone, mid) === leftOffset) lo = mid;
    else hi = mid;
  }
  return hi;
}

function getOffsetTable(timeZone, startMs, endMs) {
  const existing = tableCache.get(timeZone);
  const wantedStart = startMs - 2 * DAY;
  const wantedEnd = endMs + 2 * DAY;
  if (existing && existing.start <= wantedStart && existing.end >= wantedEnd) return existing;

  let scanStart = existing ? existing.start : wantedStart - 366 * DAY;
  let scanEnd = existing ? existing.end : wantedEnd + 366 * DAY;
  scanStart = Math.min(scanStart, wantedStart - 2 * DAY);
  scanEnd = Math.max(scanEnd, wantedEnd + 2 * DAY);

  const transitions = existing ? [...existing.transitions] : [];
  let cursor = scanStart;
  let previousOffset = utcOffsetMs(timeZone, cursor);
  let segmentStart = cursor;

  while (cursor <= scanEnd) {
    cursor += 6 * HOUR;
    const offset = utcOffsetMs(timeZone, cursor);
    if (offset !== previousOffset) {
      const at = transitionAt(timeZone, cursor - 6 * HOUR, cursor);
      if (!transitions.some(t => t.at === at)) {
        transitions.push({ at, from: previousOffset, to: offset });
      }
      previousOffset = offset;
      segmentStart = at;
    }
  }
  transitions.sort((a, b) => a.at - b.at);
  const table = { start: scanStart, end: scanEnd, transitions };
  tableCache.set(timeZone, table);
  return table;
}

export function offsetAt(timeZone, whenMs) {
  getOffsetTable(timeZone, whenMs, whenMs);
  const table = tableCache.get(timeZone);
  let offset = utcOffsetMs(timeZone, table.start);
  for (const t of table.transitions) {
    if (whenMs >= t.at) offset = t.to;
    else break;
  }
  return offset;
}

function localDateUtc(y, month, d, hour = 0, minute = 0) {
  return Date.UTC(y, month - 1, d, hour, minute, 0);
}

function uniqueOffsetsAround(timeZone, nominalUtc) {
  const table = getOffsetTable(timeZone, nominalUtc - 2 * DAY, nominalUtc + 2 * DAY);
  const offsets = new Set();
  offsets.add(utcOffsetMs(timeZone, nominalUtc - DAY));
  offsets.add(utcOffsetMs(timeZone, nominalUtc));
  offsets.add(utcOffsetMs(timeZone, nominalUtc + DAY));
  for (const t of table.transitions) {
    if (Math.abs(t.at - nominalUtc) <= DAY) {
      offsets.add(t.from);
      offsets.add(t.to);
    }
  }
  return [...offsets].sort((a, b) => b - a);
}

export function wallMatches(timeZone, date) {
  const nominal = localDateUtc(date.year, date.month, date.day, date.hour, date.minute);
  return uniqueOffsetsAround(timeZone, nominal)
    .map(offset => {
      const when = nominal - offset;
      return {
        when,
        offset,
        valid: offsetAt(timeZone, when) === offset
      };
    })
    .filter(x => x.valid)
    .sort((a, b) => a.when - b.when);
}

// disambiguation:
//   first/second：秋季回拨时选择第 1 或第 2 个同名时段
//   compatible：重复时取较早实例；春季跳字时顺延到跳字后
export function wallToUtcMs(timeZone, date, option = {}) {
  const disambiguation = option.disambiguation || 'compatible';
  const matches = wallMatches(timeZone, date);
  if (matches.length > 0) {
    let index = 0;
    if (option.choice === 'second' || disambiguation === 'second') index = Math.min(1, matches.length - 1);
    else if (option.choice === 'first' || disambiguation === 'first') index = 0;
    else if (disambiguation === 'later') index = matches.length - 1;
    const m = matches[index];
    return {
      value: m.when,
      offsetMinutes: m.offset / MINUTE,
      repeated: matches.length > 1,
      gap: false,
      choice: index === 0 ? 'first' : 'second'
    };
  }

  const nominal = localDateUtc(date.year, date.month, date.day, date.hour, date.minute);
  const table = getOffsetTable(timeZone, nominal - DAY, nominal + DAY);
  const near = table.transitions
    .filter(t => t.at > nominal - DAY && t.at < nominal + DAY)
    .sort((a, b) => Math.abs(a.at - nominal) - Math.abs(b.at - nominal))[0];

  if (!near) {
    const offset = offsetAt(timeZone, nominal);
    return { value: nominal - offset, offsetMinutes: offset / MINUTE, repeated: false, gap: false, choice: 'single' };
  }

  // 春季不存在的挂钟时间：旧偏移下的时刻正好位于跳字之后，即“顺延”。
  const shifted = nominal - near.from;
  return {
    value: shifted,
    offsetMinutes: near.to / MINUTE,
    repeated: false,
    gap: true,
    choice: disambiguation === 'earlier' ? 'earlier-nonexistent' : 'later-shift'
  };
}

export function parseLocalDateTime(input) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ]((\d{2}):(\d{2}))/.exec(String(input || ''));
  if (!m) throw new Error('本地时间格式必须为 YYYY-MM-DDTHH:mm');
  const hour = Number(m[5]);
  const minute = Number(m[6]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) {
    throw new Error('非法本地时间');
  }
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: hour === 24 ? 0 : hour,
    minute
  };
}

export function parseClock(input) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(input || ''));
  if (!m) throw new Error(`非法时分：${input}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) throw new Error(`非法时分：${input}`);
  return { hour: hour === 24 ? 0 : hour, minute };
}

export function addLocalDays(date, days) {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function toIsoUtc(ms) {
  return new Date(ms).toISOString();
}

export function formatWall(timeZone, whenMs) {
  const p = partsFor(timeZone, whenMs);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function wallDateAt(timeZone, whenMs) {
  const p = partsFor(timeZone, whenMs);
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}
