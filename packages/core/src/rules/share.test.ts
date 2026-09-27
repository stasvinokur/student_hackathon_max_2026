import { describe, expect, it } from 'vitest';
import { shareText } from './share.js';
import type { RouteView } from './view.js';

const task = (id: string, title: string) => ({
  id, title, lane: 'critical' as const, kind: 'test_data' as const, status: 'todo' as const, latestStart: '2026-10-01',
  floatDays: 1, overdue: false, onCriticalPath: true, waitingFor: [],
});

const view = {
  pack: { id: 'demo', version: '1.0.0', title: 'Demo', checkedAt: '2026-09-18', disclaimer: null },
  openingDate: '2026-11-17',
  projectedOpeningDate: null,
  today: '2026-09-18',
  daysToOpening: 60,
  readiness: { done: 8, total: 13, percent: 61, criticalDone: 5, criticalTotal: 7 },
  nextStep: null,
  blockers: [task('kkt', 'Касса'), task('rpn', 'Уведомление')],
  lanes: { critical: [], ops: [], support: [] },
  places: [],
} satisfies RouteView;

describe('shareText', () => {
  it('summarises progress and blockers with a link to the bot', () => {
    expect(shareText(view, 'https://max.ru/t750_hakaton_max_bot')).toBe(
      [
        'Готовность к открытию: 61%',
        'Закрыто 8 из 13 шагов, обязательных — 5 из 7.',
        'Осталось 2 критических блокера: Касса; Уведомление.',
        'До открытия 60 дней.',
        '',
        'Маршрут открытия — в «Открывай»: https://max.ru/t750_hakaton_max_bot',
      ].join('\n'),
    );
  });

  it('handles no blockers, a past opening date and no link', () => {
    const text = shareText({ ...view, blockers: [], daysToOpening: -3 });
    expect(text).toContain('Критичных блокеров не осталось.');
    expect(text).not.toContain('До открытия');
    expect(text).not.toContain('Прогноз');
    expect(text).not.toContain('max.ru');
  });

  it('gives the forecast after the days to opening when the planned date cannot be met', () => {
    const late = { ...view, openingDate: '2026-10-26', projectedOpeningDate: '2026-12-08', today: '2026-09-26', daysToOpening: 30 };
    expect(shareText(late).split('\n').slice(-2)).toEqual(['До открытия 30 дней.', 'Прогноз открытия — 8 декабря (план — 26 октября).']);
  });

  it('gives the forecast with the year outside the current one, and after a past opening date too', () => {
    const late = { ...view, openingDate: '2026-09-01', projectedOpeningDate: '2027-01-15', today: '2026-09-26', daysToOpening: -25 };
    const text = shareText(late);
    expect(text).not.toContain('До открытия');
    expect(text.split('\n').at(-1)).toBe('Прогноз открытия — 15 января 2027 (план — 1 сентября).');
  });
});
