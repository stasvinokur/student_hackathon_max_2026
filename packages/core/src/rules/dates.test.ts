import { describe, expect, it } from 'vitest';
import { formatDate, formatDayMonth, formatDayMonthNear, formatDueDate } from './dates.js';

describe('date formatting', () => {
  it('formats an ISO date as DD.MM, with the year on request', () => {
    expect(formatDate('2026-10-05')).toBe('05.10');
    expect(formatDate('2026-10-05', true)).toBe('05.10.2026');
  });

  it('spells the month in the genitive, the day without a leading zero', () => {
    expect(formatDayMonth('2026-11-24')).toBe('24 ноября');
    expect(formatDayMonth('2026-10-05')).toBe('5 октября');
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    months.forEach((month, i) => {
      expect(formatDayMonth(`2026-${String(i + 1).padStart(2, '0')}-01`)).toBe(`1 ${month}`);
    });
  });

  it('adds the year on request', () => {
    expect(formatDayMonth('2026-11-24', true)).toBe('24 ноября 2026');
    expect(formatDayMonth('2026-11-24', false)).toBe('24 ноября');
  });

  it('near today adds the year only when it differs from the year of today', () => {
    expect(formatDayMonthNear('2026-11-24', '2026-09-26')).toBe('24 ноября');
    expect(formatDayMonthNear('2027-11-24', '2026-09-26')).toBe('24 ноября 2027');
    expect(formatDayMonthNear('2025-12-31', '2026-01-02')).toBe('31 декабря 2025');
  });

  it('shows the year of a due date only outside the current year', () => {
    // Next year's dates must not read as past ones.
    expect(formatDueDate('2026-10-05', '2026-09-23')).toBe('05.10');
    expect(formatDueDate('2027-09-11', '2026-09-23')).toBe('11.09.2027');
  });
});
