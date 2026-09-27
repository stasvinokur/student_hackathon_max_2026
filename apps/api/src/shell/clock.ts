export interface Clock {
  now(): Date;
  /** Calendar date (YYYY-MM-DD) in the product's time zone. */
  today(): string;
}

/** Kazan lives in Moscow time (UTC+3, no DST). */
export const PRODUCT_TIME_ZONE = 'Europe/Moscow';

const dateInZone = new Intl.DateTimeFormat('en-CA', { timeZone: PRODUCT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

export const systemClock: Clock = {
  now: () => new Date(),
  today: () => dateInZone.format(new Date()),
};

/** Fixed clock for tests. */
export function fixedClock(iso: string): Clock {
  const now = new Date(iso);
  return { now: () => now, today: () => dateInZone.format(now) };
}

/** 10:00 Moscow time on a calendar date — when dated reminders are delivered (Moscow is UTC+3, no DST). */
export function moscowMorning(date: string): Date {
  return new Date(`${date}T07:00:00Z`);
}
