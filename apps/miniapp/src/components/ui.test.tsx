import type { TaskSummary } from '@otkryvay/core';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusMark, taskStartText, taskStatusText } from './ui.js';

// The shared parts of the screens that tests of the whole app do not look into.

afterEach(cleanup);

const task: TaskSummary = {
  id: 'sout', title: 'Провести СОУТ', lane: 'ops', kind: 'test_data', status: 'todo', latestStart: '2026-10-05',
  floatDays: 30, overdue: false, onCriticalPath: false, waitingFor: [],
};
const waiting = [{ id: 'lease', title: 'Арендовать помещение' }];

describe('the status of a step', () => {
  // The mark shows the state by its class, mark--{state}, which styles.css draws; hidden from screen readers, as the
  // line beside it says the same in words. Both put the states in one order: done, then waiting, then overdue.
  // The route no longer builds a done or a waiting step marked overdue: those two cases only pin the order.
  it.each([
    ['done', 'a done step', { ...task, status: 'done' as const }, 'Выполнено'],
    ['done', 'a step done late', { ...task, status: 'done' as const, overdue: true }, 'Выполнено'],
    ['waiting', 'a step that waits, overdue or not', { ...task, overdue: true, waitingFor: waiting }, 'Ждёт: Арендовать помещение'],
    ['overdue', 'an overdue step', { ...task, overdue: true }, 'Просрочено — начните сегодня'],
    ['todo', 'a step to start', task, 'Начать до 5 октября'],
    ['todo', 'a step whose last day to start is today', { ...task, latestStart: '2026-09-26' }, 'Начать сегодня'],
    // The route dates no step to do before today; a date gone by would still not show.
    ['todo', 'a step whose last day to start has passed', { ...task, latestStart: '2026-09-20' }, 'Начать сегодня'],
  ])('is %s for %s', (state, _name, summary, text) => {
    const mark = render(<StatusMark task={summary} />).container.firstElementChild!;
    expect(mark.className).toBe(`mark mark--${state}`);
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(taskStatusText(summary, '2026-09-26')).toBe(text);
  });
});

describe('when to start a step', () => {
  it('is today for an overdue step or one whose last day to start is today, else the last day', () => {
    expect(taskStartText({ ...task, overdue: true }, '2026-09-26')).toBe('Начать сегодня');
    expect(taskStartText({ ...task, latestStart: '2026-09-26' }, '2026-09-26')).toBe('Начать сегодня');
    expect(taskStartText(task, '2026-09-26')).toBe('Начать до 5 октября');
  });

  it('without a today writes the year, and knows only an overdue step is to start today', () => {
    expect(taskStartText(task, null)).toBe('Начать до 5 октября 2026');
    expect(taskStartText({ ...task, overdue: true }, null)).toBe('Начать сегодня');
  });
});
