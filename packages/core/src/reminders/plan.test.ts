import { describe, expect, it } from 'vitest';
import type { Profile } from '../profile.js';
import { buildRoute } from '../rules/route.js';
import { RulesPackSchema } from '../rules/schema.js';
import { planReminders, reminderReply } from './plan.js';

const source = { url: 'https://www.nalog.gov.ru/', title: 'ФНС', checked_at: '2026-09-18' };
const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Шаг ${id}`, lane: 'critical', duration_days: 5, why: 'w', do_now: `Сделать ${id}`, done_when: 'x', source, kind: 'test_data', ...extra,
});
const pack = RulesPackSchema.parse({
  manifest: { id: 'demo', version: '1.0.0', title: 'Demo', industry: 'coffee', checked_at: '2026-09-18', cities: ['kazan'], region: { code: 'kazan', name: 'Казань' } },
  actions: [card('register'), card('lease', { duration_days: 20 }), card('kkt', { depends_on: ['register'] }), card('fit', { duration_days: 10, depends_on: ['lease'] })],
});
const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 0, sells_food: false, opening_date: '2026-11-20' };

function route(statuses = {}) {
  const r = buildRoute(pack, profile, '2026-09-18', statuses);
  if (r.status !== 'ok') throw new Error('route expected');
  return r.route;
}

describe('planReminders', () => {
  it('reminds about the next step soon and about blockers two days before their latest start', () => {
    // Opening 2026-11-20: lease (20 d) → fit (10 d) is the tightest chain; fit and register must start by 2026-11-10.
    const r = route();
    expect(planReminders(r)).toEqual([
      { actionId: 'lease', kind: 'next_step', due: 'soon' },
      { actionId: 'fit', kind: 'deadline', due: { date: '2026-11-08' } },
      { actionId: 'register', kind: 'deadline', due: { date: '2026-11-08' } },
    ]);
  });

  it('follows progress and plans nothing when everything is done', () => {
    expect(planReminders(route({ lease: 'done' }))[0]).toMatchObject({ actionId: 'register', kind: 'next_step' });
    expect(planReminders(route({ register: 'done', lease: 'done', kkt: 'done', fit: 'done' }))).toEqual([]);
  });

  it('skips deadline reminders whose date has passed', () => {
    // Lease done, opening in 11 days: fit (10 d) must start tomorrow, too soon to warn two days ahead; kkt can still be warned about.
    const tight = buildRoute(pack, { ...profile, opening_date: '2026-09-29' }, '2026-09-18', { lease: 'done' });
    if (tight.status !== 'ok') throw new Error('route expected');
    expect(tight.route.projectedOpeningDate).toBeNull();
    expect(planReminders(tight.route)).toEqual([
      { actionId: 'register', kind: 'next_step', due: 'soon' },
      { actionId: 'kkt', kind: 'deadline', due: { date: '2026-09-22' } },
    ]);
  });

  it('dates deadline reminders from the projected opening when the planned date cannot be met', () => {
    // Opening in a week: lease (20 d) → fit (10 d) needs 30 days, so the route counts from 2026-10-18 and lease starts today.
    const late = buildRoute(pack, { ...profile, opening_date: '2026-09-25' }, '2026-09-18');
    if (late.status !== 'ok') throw new Error('route expected');
    expect(late.route.projectedOpeningDate).toBe('2026-10-18');
    expect(planReminders(late.route)).toEqual([
      { actionId: 'lease', kind: 'next_step', due: 'soon' },
      { actionId: 'fit', kind: 'deadline', due: { date: '2026-10-06' } },
      { actionId: 'register', kind: 'deadline', due: { date: '2026-10-06' } },
    ]);
  });
});

describe('reminderReply', () => {
  it('links to the step card via a deep link', () => {
    const step = route().steps.find((s) => s.action.id === 'register')!;
    const reply = reminderReply(step, 'deadline', '2026-09-18');
    // Opening 2026-11-20: kkt (5 d) must start by 2026-11-15, so register (5 d) by 2026-11-10.
    expect(reply.text).toBe('Скоро срок по шагу, который может сорвать запуск:\n«Шаг register»\nНачать до 10.11.\n\nЧто сделать сейчас: Сделать register');
    expect(reply.buttons).toEqual([[{ kind: 'open_app', text: 'Открыть карточку', startParam: 'register' }]]);
  });

  it('asks to start today a step that moves the opening, and never says the start is past', () => {
    // Opening in a week: lease (20 d) → fit (10 d) cannot make it, so lease moves the opening.
    const late = buildRoute(pack, { ...profile, opening_date: '2026-09-25' }, '2026-09-18');
    if (late.status !== 'ok') throw new Error('route expected');
    const lease = late.route.steps.find((s) => s.action.id === 'lease')!;
    expect(lease.overdue).toBe(true);
    const text = reminderReply(lease, 'next_step', '2026-09-18').text;
    expect(text).toBe('Следующий шаг к открытию:\n«Шаг lease»\nНачните сегодня — каждый день задержки сдвигает открытие.\n\nЧто сделать сейчас: Сделать lease');
    expect(text).not.toContain('прошёл');
  });

  it('does not call the deadline of a step that moves the opening by the time it is sent «soon»', () => {
    // A deadline reminder planned for lease days ago: the user waited, and now lease moves the opening.
    const late = buildRoute(pack, { ...profile, opening_date: '2026-09-25' }, '2026-09-18');
    if (late.status !== 'ok') throw new Error('route expected');
    const lease = late.route.steps.find((s) => s.action.id === 'lease')!;
    expect(reminderReply(lease, 'deadline', '2026-09-18').text).toBe(
      'Пора начинать:\n«Шаг lease»\nНачните сегодня — каждый день задержки сдвигает открытие.\n\nЧто сделать сейчас: Сделать lease',
    );
  });

  it('asks to start today a step due today that does not move the opening', () => {
    // Opening in 30 days: lease → fit just fits, lease is due today.
    const tight = buildRoute(pack, { ...profile, opening_date: '2026-10-18' }, '2026-09-18');
    if (tight.status !== 'ok') throw new Error('route expected');
    const lease = tight.route.steps.find((s) => s.action.id === 'lease')!;
    expect(lease).toMatchObject({ latestStart: '2026-09-18', overdue: false });
    expect(reminderReply(lease, 'next_step', '2026-09-18').text).toContain('\nНачать сегодня.\n');
  });

  it('adds the year to a start date in the next year', () => {
    const step = route().steps.find((s) => s.action.id === 'register')!;
    expect(reminderReply({ ...step, latestStart: '2027-01-15' }, 'next_step', '2026-09-18').text).toContain('Начать до 15.01.2027.');
  });
});
