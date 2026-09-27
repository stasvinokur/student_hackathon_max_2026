// Calendar dates as ISO strings (YYYY-MM-DD) in UTC: arithmetic and Russian formatting. Never reads the clock.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Days since the Unix epoch, or null when the string is not a real calendar date. */
export function toEpochDay(iso: string): number | null {
  const match = ISO_DATE.exec(iso);
  if (!match) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  const date = new Date(ms);
  // Reject overflowed dates such as 2026-02-30.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

export function isIsoDate(iso: string): boolean {
  return toEpochDay(iso) !== null;
}

export function fromEpochDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return fromEpochDay(mustEpochDay(iso) + days);
}

/** b − a in whole days. */
export function diffDays(a: string, b: string): number {
  return mustEpochDay(b) - mustEpochDay(a);
}

/** 2026-10-05 → 05.10 (or 05.10.2026 with the year). */
export function formatDate(iso: string, withYear = false): string {
  const [y, m, d] = iso.split('-');
  return withYear ? `${d}.${m}.${y}` : `${d}.${m}`;
}

const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** 2026-11-24 → «24 ноября» (or «24 ноября 2026» with the year). */
export function formatDayMonth(iso: string, withYear = false): string {
  const [y, m, d] = iso.split('-');
  const dayMonth = `${Number(d)} ${MONTHS_GENITIVE[Number(m) - 1]}`;
  return withYear ? `${dayMonth} ${y}` : dayMonth;
}

/** «24 ноября» within the year of `today`, «24 ноября 2027» outside it. */
export function formatDayMonthNear(iso: string, today: string): string {
  return formatDayMonth(iso, iso.slice(0, 4) !== today.slice(0, 4));
}

/** DD.MM within the year of `today`, DD.MM.YYYY otherwise — next year's dates must not read as past ones. */
export function formatDueDate(iso: string, today: string): string {
  return formatDate(iso, iso.slice(0, 4) !== today.slice(0, 4));
}

function mustEpochDay(iso: string): number {
  const day = toEpochDay(iso);
  if (day === null) throw new RangeError(`not an ISO date: ${iso}`);
  return day;
}
