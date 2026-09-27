import { describe, expect, it } from 'vitest';
import type { RouteStep } from '../rules/route.js';
import { startPhrase, stepReply } from './step-reply.js';

const step = {
  action: {
    id: 'kkt-registration', title: 'Зарегистрировать кассу', lane: 'critical', kind: 'test_data', why: 'Без кассы нельзя продавать.',
    do_now: 'Выберите кассу из реестра.', prepare: [], done_when: 'x', depends_on: [], duration_days: 5, due_days_before_opening: 1, places: [],
  },
  status: 'todo', dependsOn: [], waitingFor: [], latestStart: '2026-10-14', latestFinish: '2026-10-19',
  earliestStart: '2026-09-18', earliestFinish: '2026-09-23', floatDays: 26, overdue: false, onCriticalPath: false,
} as RouteStep;

// A step that moves the opening: no spare days, can be started today.
const overdue = { ...step, latestStart: '2026-09-18', floatDays: 0, overdue: true } as RouteStep;

describe('stepReply', () => {
  it('explains the step and links to its card', () => {
    const reply = stepReply(step, '2026-09-18');
    expect(reply.text).toContain('Шаг: Зарегистрировать кассу');
    expect(reply.text).toContain('Зачем: Без кассы нельзя продавать.');
    expect(reply.text).toContain('\nНачать до 14.10.\n');
    expect(reply.text).toContain('Тестовые данные');
    expect(reply.buttons).toEqual([[{ kind: 'open_app', text: 'Открыть карточку', startParam: 'kkt-registration' }]]);
  });

  it('asks to start today a step that moves the opening, and never says the start is past', () => {
    const text = stepReply(overdue, '2026-09-18').text;
    expect(text).toContain('\nНачните сегодня — каждый день задержки сдвигает открытие.\n');
    expect(text).not.toContain('Начать');
    expect(text).not.toContain('нужно было');
  });

  it('asks to start today a step due today that does not move the opening', () => {
    const text = stepReply({ ...step, latestStart: '2026-09-18', floatDays: 0 }, '2026-09-18').text;
    expect(text).toContain('\nНачать сегодня.\n');
    expect(text).not.toContain('задержки');
  });

  it('adds the year to a start date in the next year', () => {
    expect(stepReply({ ...step, latestStart: '2027-09-11' }, '2026-09-23').text).toContain('Начать до 11.09.2027.');
  });
});

describe('startPhrase', () => {
  it('says by when to start, for the middle of a sentence', () => {
    expect(startPhrase(step, '2026-09-18')).toBe('начать до 14.10');
    expect(startPhrase({ ...step, latestStart: '2027-01-15' }, '2026-09-18')).toBe('начать до 15.01.2027');
  });

  it('says to start today a step due today or one that moves the opening', () => {
    expect(startPhrase({ ...step, latestStart: '2026-09-18' }, '2026-09-18')).toBe('начать сегодня');
    expect(startPhrase(overdue, '2026-09-18')).toBe('начать сегодня');
    // A date already behind never reaches the user as a past one.
    expect(startPhrase({ ...step, latestStart: '2026-08-14' }, '2026-09-18')).toBe('начать сегодня');
  });
});
