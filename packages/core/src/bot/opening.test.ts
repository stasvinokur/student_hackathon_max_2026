import { describe, expect, it } from 'vitest';
import type { Profile } from '../profile.js';
import { buildRoute, type Route, type TaskStatuses } from '../rules/route.js';
import { RulesPackSchema } from '../rules/schema.js';
import { keepOpeningReplies, rescheduleOfferReply, rescheduleReplies } from './opening.js';

const source = { url: 'https://www.nalog.gov.ru/', title: 'ФНС', checked_at: '2026-09-18' };
const action = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, lane: 'critical', duration_days: 1, why: 'w', do_now: 'd', done_when: 'x', source, kind: 'test_data', ...extra,
});

// register (7 days) → lease (30) → fit-out (30, done 3 days before opening) → fire safety (5, done 1 day before):
// 73 days from today, 2026-09-26, is 2026-12-08.
const pack = RulesPackSchema.parse({
  manifest: { id: 'demo', version: '1.0.0', title: 'Demo', industry: 'coffee', checked_at: '2026-09-18', cities: ['kazan'], region: { code: 'kazan', name: 'Казань' } },
  actions: [
    action('register-business', 'Зарегистрировать бизнес', { duration_days: 7 }),
    action('lease-premises', 'Арендовать помещение', { duration_days: 30, depends_on: ['register-business'] }),
    action('fit-out', 'Оборудовать помещение', { duration_days: 30, due_days_before_opening: 3, depends_on: ['lease-premises'] }),
    action('fire-safety', 'Пожарная безопасность', { lane: 'ops', duration_days: 5, due_days_before_opening: 1, depends_on: ['fit-out'] }),
  ],
});
const TODAY = '2026-09-26';
const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 0, sells_food: false, opening_date: '2026-10-26' };
const ALL_DONE: TaskStatuses = { 'register-business': 'done', 'lease-premises': 'done', 'fit-out': 'done', 'fire-safety': 'done' };

function routeFor(openingDate: string, today = TODAY, statuses: TaskStatuses = {}): Route {
  const result = buildRoute(pack, { ...profile, opening_date: openingDate }, today, statuses);
  if (result.status !== 'ok') throw new Error('route expected');
  return result.route;
}

const OPEN_ROUTE = [[{ kind: 'open_app', text: 'Открыть маршрут' }]];
const NO_ROUTE = { text: 'Маршрута пока нет — пройдите вопросы заново.', buttons: [[{ kind: 'callback', text: 'Пройти заново', payload: 'ob:restart' }]] };

describe('rescheduleOfferReply', () => {
  it('offers nothing when the opening date can be met', () => {
    expect(rescheduleOfferReply(routeFor('2026-12-08'))).toBeNull();
  });

  it('offers to move the opening to the reachable date or keep it', () => {
    expect(rescheduleOfferReply(routeFor('2026-10-26'))).toEqual({
      text: 'Перенести дату открытия на 8 декабря? Отметки выполненных шагов сохранятся.',
      buttons: [
        [{ kind: 'callback', text: 'Перенести на 8 декабря', payload: 'route:reschedule:2026-10-26:2026-12-08' }],
        [{ kind: 'callback', text: 'Оставить 26 октября', payload: 'route:keep:2026-10-26' }],
      ],
    });
  });

  it('does not offer to keep an opening date that has passed', () => {
    expect(rescheduleOfferReply(routeFor('2026-09-20'))).toEqual({
      text: 'Перенести дату открытия на 8 декабря? Отметки выполненных шагов сохранятся.',
      buttons: [[{ kind: 'callback', text: 'Перенести на 8 декабря', payload: 'route:reschedule:2026-09-20:2026-12-08' }]],
    });
    // An opening today has not passed yet, as in lateOpeningText.
    expect(rescheduleOfferReply(routeFor(TODAY))?.buttons[1]).toEqual([{ kind: 'callback', text: 'Оставить 26 сентября', payload: 'route:keep:2026-09-26' }]);
  });

  it('adds the year to a date outside the current one', () => {
    // 73 days from 2026-10-20 is 2027-01-01.
    const route = routeFor('2026-12-20', '2026-10-20');
    expect(route.projectedOpeningDate).toBe('2027-01-01');
    expect(rescheduleOfferReply(route)).toEqual({
      text: 'Перенести дату открытия на 1 января 2027? Отметки выполненных шагов сохранятся.',
      buttons: [
        [{ kind: 'callback', text: 'Перенести на 1 января 2027', payload: 'route:reschedule:2026-12-20:2027-01-01' }],
        [{ kind: 'callback', text: 'Оставить 20 декабря', payload: 'route:keep:2026-12-20' }],
      ],
    });
  });
});

describe('rescheduleReplies', () => {
  it('confirms the move, keeps the marks and names the next step', () => {
    expect(rescheduleReplies({ status: 'moved', requested: '2026-12-08', route: routeFor('2026-12-08') })).toEqual([
      {
        text:
          'Готово: открытие — 8 декабря, до него 73 дня. Отметки выполненных шагов сохранены.\n' +
          'Следующий шаг: Зарегистрировать бизнес — начать сегодня.',
        buttons: OPEN_ROUTE,
      },
    ]);
  });

  it('gives the start date of the next step when it has spare days, with the year when needed', () => {
    // Opening 2027-01-20: fire safety by 2027-01-14, fit-out by 2026-12-15, lease by 2026-11-15, register by 2026-11-08.
    const [reply] = rescheduleReplies({ status: 'moved', requested: '2027-01-20', route: routeFor('2027-01-20') });
    expect(reply!.text).toBe(
      'Готово: открытие — 20 января 2027, до него 116 дней. Отметки выполненных шагов сохранены.\n' +
        'Следующий шаг: Зарегистрировать бизнес — начать до 08.11.',
    );
  });

  it('names the new opening in the right form of «день» and leaves out the next step once all is done', () => {
    const moved = (openingDate: string) => rescheduleReplies({ status: 'moved', requested: openingDate, route: routeFor(openingDate, TODAY, ALL_DONE) });
    expect(moved('2026-09-27')).toEqual([
      { text: 'Готово: открытие — 27 сентября, до него 1 день. Отметки выполненных шагов сохранены.', buttons: OPEN_ROUTE },
    ]);
    expect(moved('2026-09-29')[0]!.text).toBe('Готово: открытие — 29 сентября, до него 3 дня. Отметки выполненных шагов сохранены.');
    expect(moved('2026-10-01')[0]!.text).toBe('Готово: открытие — 1 октября, до него 5 дней. Отметки выполненных шагов сохранены.');
  });

  it('says when the offered date could no longer be met and the opening went further', () => {
    // The offer was made a week ago: the move went to 2026-12-15, 73 days from 2026-10-03.
    expect(rescheduleReplies({ status: 'moved', requested: '2026-12-08', route: routeFor('2026-12-15', '2026-10-03') })).toEqual([
      {
        text:
          '8 декабря уже не успеть — перенесли открытие на 15 декабря, до него 73 дня. Отметки выполненных шагов сохранены.\n' +
          'Следующий шаг: Зарегистрировать бизнес — начать сегодня.',
        buttons: OPEN_ROUTE,
      },
    ]);
  });

  it('changes nothing on a second press', () => {
    expect(rescheduleReplies({ status: 'unchanged', route: routeFor('2026-12-08') })).toEqual([{ text: 'Дата открытия уже 8 декабря.', buttons: OPEN_ROUTE }]);
  });

  it('says why and offers a fresh move when the date has slipped since the first press', () => {
    expect(rescheduleReplies({ status: 'unchanged', route: routeFor('2026-12-08', '2026-10-03') })).toEqual([
      { text: 'Дата открытия уже 8 декабря. К 8 декабря не успеть — если начать сегодня, откроетесь 15 декабря.', buttons: OPEN_ROUTE },
      {
        text: 'Перенести дату открытия на 15 декабря? Отметки выполненных шагов сохранятся.',
        buttons: [
          [{ kind: 'callback', text: 'Перенести на 15 декабря', payload: 'route:reschedule:2026-12-08:2026-12-15' }],
          [{ kind: 'callback', text: 'Оставить 8 декабря', payload: 'route:keep:2026-12-08' }],
        ],
      },
    ]);
  });

  it('offers to move alone when the date the button moved to has passed since', () => {
    // 73 days from 2026-12-10 is 2027-02-21.
    expect(rescheduleReplies({ status: 'unchanged', route: routeFor('2026-12-08', '2026-12-10') })).toEqual([
      { text: 'Дата открытия уже 8 декабря. Если начать сегодня, откроетесь 21 февраля 2027.', buttons: OPEN_ROUTE },
      {
        text: 'Перенести дату открытия на 21 февраля 2027? Отметки выполненных шагов сохранятся.',
        buttons: [[{ kind: 'callback', text: 'Перенести на 21 февраля 2027', payload: 'route:reschedule:2026-12-08:2027-02-21' }]],
      },
    ]);
  });

  it('refuses a stale button and names the date in the route', () => {
    expect(rescheduleReplies({ status: 'stale', route: routeFor('2026-11-15') })).toEqual([
      { text: 'Эта кнопка устарела: в маршруте уже другая дата открытия — 15 ноября.', buttons: OPEN_ROUTE },
    ]);
  });

  it('refuses to move to a date that has come', () => {
    expect(rescheduleReplies({ status: 'expired', requested: '2026-12-08', route: routeFor('2026-10-26', '2026-12-10', ALL_DONE) })).toEqual([
      { text: '8 декабря уже наступило — дату открытия не меняем.', buttons: OPEN_ROUTE },
    ]);
  });

  it('offers to go through the questions again when there is no route', () => {
    expect(rescheduleReplies({ status: 'no_route' })).toEqual([NO_ROUTE]);
  });

  it('gives every reply buttons of its own', () => {
    const route = routeFor('2026-11-15');
    rescheduleReplies({ status: 'stale', route })[0]!.buttons[0]!.pop();
    rescheduleReplies({ status: 'no_route' })[0]!.buttons.push([]);
    expect(rescheduleReplies({ status: 'stale', route })[0]!.buttons).toEqual(OPEN_ROUTE);
    expect(rescheduleReplies({ status: 'no_route' })).toEqual([NO_ROUTE]);
  });
});

describe('keepOpeningReplies', () => {
  it('keeps a date that cannot be met and names the earliest opening the steps are dated for', () => {
    expect(keepOpeningReplies({ status: 'kept', route: routeFor('2026-10-26') })).toEqual([
      { text: 'Оставили 26 октября. Сроки шагов посчитаны так, чтобы открыться как можно раньше — 8 декабря.', buttons: OPEN_ROUTE },
    ]);
  });

  it('keeps a date that can be met', () => {
    expect(keepOpeningReplies({ status: 'kept', route: routeFor('2026-12-08') })).toEqual([
      { text: 'Оставили 8 декабря — к этой дате можно успеть.', buttons: OPEN_ROUTE },
    ]);
  });

  it('refuses a stale button and names the date in the route', () => {
    expect(keepOpeningReplies({ status: 'stale', route: routeFor('2026-11-15') })).toEqual([
      { text: 'Эта кнопка устарела: в маршруте уже другая дата открытия — 15 ноября.', buttons: OPEN_ROUTE },
    ]);
  });

  it('says the kept date has passed and offers again to move it, the one way on', () => {
    // The offer was pressed a day after the opening date: 73 days from 2026-10-27 is 2027-01-08.
    expect(keepOpeningReplies({ status: 'passed', route: routeFor('2026-10-26', '2026-10-27') })).toEqual([
      { text: 'Дата открытия 26 октября прошла. Если начать сегодня, откроетесь 8 января 2027.', buttons: OPEN_ROUTE },
      {
        text: 'Перенести дату открытия на 8 января 2027? Отметки выполненных шагов сохранятся.',
        buttons: [[{ kind: 'callback', text: 'Перенести на 8 января 2027', payload: 'route:reschedule:2026-10-26:2027-01-08' }]],
      },
    ]);
  });

  it('says the kept date has passed and offers nothing once every required step is done', () => {
    expect(keepOpeningReplies({ status: 'passed', route: routeFor('2026-10-26', '2026-10-27', ALL_DONE) })).toEqual([
      { text: 'Дата открытия 26 октября прошла.', buttons: OPEN_ROUTE },
    ]);
  });

  it('offers to go through the questions again when there is no route', () => {
    expect(keepOpeningReplies({ status: 'no_route' })).toEqual([NO_ROUTE]);
  });
});
