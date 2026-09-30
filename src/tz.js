'use strict';

// Time-zone primitives implemented with Node's ICU/Intl data.
// Every business instance is stored as an absolute UTC interval anchored to
// the store's local opening date, so an interval crossing midnight is never
// split by the browser/viewer calendar.

const partCache = new Map();
const offsetCache = new Map();
const transitionCache = new Map();

function getZone(zone) {
  if (!partCache.has(zone)) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    } catch (err) {
      const error = new Error(`Unknown IANA time zone: ${zone}`);
      error.statusCode = 400;
      throw error;
    }
    partCache.set(zone, zone);
  }
  return zone;
}

function zonedParts(utcMs, timeZone) {
  getZone(timeZone);
  // en-CA gives reliable Y-m-d H:M:S fields; numeric literals disambiguate.
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const values = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
}

function wallMs(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function offsetAt(utcMs, timeZone) {
  getZone(timeZone);
  const bucket = Math.floor(utcMs / 900000);
  const key = `${timeZone}:${bucket}`;
  if (offsetCache.has(key)) return offsetCache.get(key);
  const p = zonedParts(utcMs, timeZone);
  const asIfUtc = wallMs(p.year, p.month, p.day, p.hour, p.minute, p.second);
  const offset = asIfUtc - utcMs;
  offsetCache.set(key, offset);
  return offset;
}

function approximateNoonUtc(year, month, day, timeZone) {
  const fakeNoon = wallMs(year, month, day, 12);
  return fakeNoon - offsetAt(fakeNoon, timeZone);
}

function findTransition(a, b, timeZone) {
  const oa = offsetAt(a, timeZone);
  const ob = offsetAt(b, timeZone);
  if (oa === ob) return null;
  let lo = a;
  let hi = b;
  while (hi - lo > 60000) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(mid, timeZone) === oa) lo = mid;
    else hi = mid;
  }
  // Offsets change on a minute boundary in all real civil time zones.
  const utcMs = Math.floor(hi / 60000) * 60000;
  const before = offsetAt(utcMs - 60000, timeZone);
  const after = offsetAt(utcMs, timeZone);
  const wallBefore = utcMs + before;
  const wallAfter = utcMs + after;
  const rec = { utcMs, beforeOffset: before, afterOffset: after };
  if (after > before) {
    rec.type = 'gap';
    rec.wallStart = wallBefore;
    rec.wallEnd = wallAfter;
    rec.shiftMs = after - before;
  } else if (after < before) {
    rec.type = 'overlap';
    // Fall-back: the clock moves from e.g. 02:00 back to 01:00.
    rec.wallStart = wallAfter;
    rec.wallEnd = wallBefore;
    rec.shiftMs = before - after;
  } else {
    rec.type = 'change';
    rec.wallStart = Math.min(wallBefore, wallAfter);
    rec.wallEnd = Math.max(wallBefore, wallAfter);
    rec.shiftMs = 0;
  }
  return rec;
}

function transitionsBetween(startUtcMs, endUtcMs, timeZone) {
  getZone(timeZone);
  const key = `${timeZone}:${Math.floor(startUtcMs / 3600000)}:${Math.floor(endUtcMs / 3600000)}`;
  if (transitionCache.has(key)) return transitionCache.get(key);
  const result = [];
  const step = 15 * 60 * 1000;
  let previous = startUtcMs;
  for (let t = startUtcMs + step; t <= endUtcMs; t += step) {
    if (offsetAt(t - step, timeZone) !== offsetAt(t, timeZone)) {
      const found = findTransition(previous, t, timeZone);
      if (found) result.push(found);
    }
    previous = t;
  }
  transitionCache.set(key, result);
  return result;
}

function transitionsAroundLocalDate(year, month, day, timeZone) {
  const noon = approximateNoonUtc(year, month, day, timeZone);
  return transitionsBetween(noon - 36 * 3600000, noon + 36 * 3600000, timeZone);
}

function wallToUtcAll(year, month, day, hour, minute, timeZone) {
  getZone(timeZone);
  const target = wallMs(year, month, day, hour, minute);
  const transitions = transitionsAroundLocalDate(year, month, day, timeZone);
  for (const tr of transitions) {
    if (tr.type === 'overlap' && target >= tr.wallStart && target < tr.wallEnd) {
      // Repeated wall clock: return both absolute occurrences, earliest first.
      return [target - tr.beforeOffset, target - tr.afterOffset].sort((a, b) => a - b);
    }
    if (tr.type === 'gap' && target >= tr.wallStart && target < tr.wallEnd) {
      // Java/Python-style "fold forward": map a nonexistent wall time to the
      // first valid wall time after the gap, with its post-transition offset.
      return [tr.wallEnd - tr.afterOffset];
    }
  }
  const noon = approximateNoonUtc(year, month, day, timeZone);
  return [target - offsetAt(noon, timeZone)];
}

function wallToUtc(year, month, day, hour, minute, timeZone, occurrence = 'first') {
  const all = wallToUtcAll(year, month, day, hour, minute, timeZone);
  return occurrence === 'last' ? all[all.length - 1] : all[0];
}

function classifyWallTime(year, month, day, hour, minute, timeZone) {
  const target = wallMs(year, month, day, hour, minute);
  for (const tr of transitionsAroundLocalDate(year, month, day, timeZone)) {
    if (tr.type === 'overlap' && target >= tr.wallStart && target < tr.wallEnd) {
      return { kind: 'repeated', occurrences: wallToUtcAll(year, month, day, hour, minute, timeZone), transition: tr };
    }
    if (tr.type === 'gap' && target >= tr.wallStart && target < tr.wallEnd) {
      return { kind: 'nonexistent', transition: tr };
    }
  }
  return { kind: 'normal', occurrences: wallToUtcAll(year, month, day, hour, minute, timeZone) };
}

function localDate(utcMs, timeZone) {
  const p = zonedParts(utcMs, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) {
    const err = new Error('日期必须为 YYYY-MM-DD');
    err.statusCode = 400;
    throw err;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    const err = new Error('无效日期');
    err.statusCode = 400;
    throw err;
  }
  return { year, month, day };
}

function addLocalDays(dateText, days) {
  const d = parseLocalDate(dateText);
  const ms = Date.UTC(d.year, d.month - 1, d.day) + days * 86400000;
  const p = zonedParts(ms + 86400000, 'UTC'); // zonedParts supports UTC
  return localDate(ms, 'UTC');
}

function eachLocalDate(startText, endText) {
  const dates = [];
  let current = startText;
  let guard = 400;
  while (current <= endText && guard-- > 0) {
    dates.push(current);
    current = addLocalDays(current, 1);
  }
  return dates;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function offsetLabel(utcMs, timeZone) {
  const minutes = Math.round(offsetAt(utcMs, timeZone) / 60000);
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `GMT${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function zonedIso(utcMs, timeZone) {
  const p = zonedParts(utcMs, timeZone);
  const mins = Math.round(offsetAt(utcMs, timeZone) / 60000);
  const sign = mins >= 0 ? '+' : '-';
  const abs = Math.abs(mins);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function utcIso(utcMs) {
  return new Date(utcMs).toISOString();
}

module.exports = {
  addLocalDays,
  classifyWallTime,
  eachLocalDate,
  localDate,
  offsetAt,
  offsetLabel,
  parseLocalDate,
  transitionsBetween,
  utcIso,
  wallToUtc,
  wallToUtcAll,
  zonedIso,
  zonedParts
};
