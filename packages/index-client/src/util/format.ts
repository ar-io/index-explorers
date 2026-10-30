/** Formatting shared by the apps; pure functions, never throwing inside a render. */

export const num = (n: number | bigint | string): string => Number(n).toLocaleString();

/** A column named as a year: `yr`, `year`, or ending in `_yr` or `_year`, in any case. */
const YEAR_COLUMN = /(?:^|_)(?:yr|year)$/i;

/**
 * A number in a results table: with thousands separators, as num() gives,
 * except a whole number from 1 to 9999 in a column named as a year, which is
 * written as it is (2026, not 2,026). Heights keep their separators.
 */
export function cellNum(column: string, n: number | bigint | string): string {
  const v = Number(n);
  return YEAR_COLUMN.test(column) && Number.isInteger(v) && v >= 1 && v <= 9999
    ? String(v)
    : num(v);
}

export const mb = (n: number): string =>
  n >= 1e9
    ? (n / 1e9).toFixed(1) + ' GB'
    : (n / 1e6).toFixed(n < 1e7 ? 2 : n < 1e8 ? 1 : 0) + ' MB';

export function bytesText(v: unknown): string {
  const n = Number(v);
  if (!(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  if (n < 1099511627776) return `${(n / 1073741824).toFixed(2)} GB`;
  return `${(n / 1099511627776).toFixed(2)} TB`;
}

export const shortId = (v: string | null | undefined): string =>
  v && v.length > 16 ? `${v.slice(0, 6)}…${v.slice(-4)}` : (v ?? '');

/** A UTC day; `secs` is epoch seconds. */
export const fmtDay = (secs: number): string =>
  new Date(secs * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

export const fmtRange = (
  a: number | null | undefined,
  b: number | null | undefined,
): string | null =>
  a && b ? (fmtDay(a) === fmtDay(b) ? fmtDay(a) : `${fmtDay(a)} to ${fmtDay(b)}`) : null;

/** `YYYY-MM-DD HH:MMZ` from epoch milliseconds; '' for anything a Date cannot hold. */
export function fmtWhen(ms: unknown): string {
  const n = Number(ms);
  if (!ms || !Number.isFinite(n)) return '';
  const d = new Date(n);
  if (!Number.isFinite(d.getTime())) return '';
  try {
    return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  } catch {
    return '';
  }
}

const dateCache = new Map<string, string>();

/** A date as a file browser shows one: time today, weekday this week, else the day. Cached: Intl formatting is slow per call. */
export function fmtDate(ms: unknown, now: number = Date.now()): string {
  const n = Number(ms);
  if (!ms || !Number.isFinite(n)) return '';
  const key = `${Math.floor(now / 3600000)}:${n}`;
  const hit = dateCache.get(key);
  if (hit !== undefined) return hit;
  if (dateCache.size > 20000) dateCache.clear();
  const out = fmtDateRaw(n, now);
  dateCache.set(key, out);
  return out;
}

function fmtDateRaw(n: number, now: number): string {
  const d = new Date(n);
  if (!Number.isFinite(d.getTime())) return '';
  const day = 86400000;
  try {
    if (now - n < day && now >= n) return d.toISOString().slice(11, 16) + ' UTC';
    if (now - n < 7 * day && now >= n)
      return (
        d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }) +
        ' ' +
        d.toISOString().slice(11, 16)
      );
    return d.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: d.getUTCFullYear() === new Date(now).getUTCFullYear() ? undefined : 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    return '';
  }
}

/** Single-quotes a SQL string literal. */
export const sq = (s: unknown): string => `'${String(s).replace(/'/g, "''")}'`;
