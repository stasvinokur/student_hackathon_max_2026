import { describe, expect, it } from 'vitest';
import type { Profile } from '../profile.js';
import { decideKeep, decideReschedule, lateOpeningText, openingDelayDays } from './opening.js';
import { RulesPackSchema } from './schema.js';

const source = { url: 'https://www.nalog.gov.ru/', title: 'ФНС', checked_at: '2026-09-18' };
const action = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Шаг ${id}`, lane: 'critical', duration_days: 1, why: 'w', do_now: 'd', done_when: 'x', source, kind: 'test_data', ...extra,
});

// register (7 days) → lease (30) → fit-out (30, done 3 days before opening) → fire safety (5, done 1 day before):
// 73 days from today, 2026-09-26, is 2026-12-08.
const pack = RulesPackSchema.parse({
  manifest: { id: 'demo', version: '1.0.0', title: 'Demo', industry: 'coffee', checked_at: '2026-09-18', cities: ['kazan'], region: { code: 'kazan', name: 'Казань' } },
  actions: [
    action('register-business', { duration_days: 7 }),
    action('lease-premises', { duration_days: 30, depends_on: ['register-business'] }),
    action('fit-out', { duration_days: 30, due_days_before_opening: 3, depends_on: ['lease-premises'] }),
    action('fire-safety', { lane: 'ops', duration_days: 5, due_days_before_opening: 1, depends_on: ['fit-out'] }),
  ],
});
const today = '2026-09-26';
const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 0, sells_food: false, opening_date: '2026-10-26' };

describe('lateOpeningText', () => {
  it('says nothing when the opening date can be met', () => {
    expect(lateOpeningText({ openingDate: '2026-12-15', projectedOpeningDate: null, today })).toBeNull();
  });

  it('names the date that cannot be met and the one that can', () => {
    expect(lateOpeningText({ openingDate: '2026-10-26', projectedOpeningDate: '2026-12-08', today })).toBe(
      'К 26 октября не успеть — если начать сегодня, откроетесь 8 декабря',
    );
  });

  it('counts an opening today as not yet passed', () => {
    expect(lateOpeningText({ openingDate: today, projectedOpeningDate: '2026-10-05', today })).toBe(
      'К 26 сентября не успеть — если начать сегодня, откроетесь 5 октября',
    );
  });

  it('gives the reachable date alone once the opening date has passed', () => {
    expect(lateOpeningText({ openingDate: '2026-09-01', projectedOpeningDate: '2026-12-08', today })).toBe('Если начать сегодня, откроетесь 8 декабря');
  });

  it('adds the year to a date outside the current one', () => {
    expect(lateOpeningText({ openingDate: '2026-12-20', projectedOpeningDate: '2027-01-15', today })).toBe(
      'К 20 декабря не успеть — если начать сегодня, откроетесь 15 января 2027',
    );
  });
});

describe('openingDelayDays', () => {
  it('counts the days the reachable opening is later than the planned one', () => {
    expect(openingDelayDays({ openingDate: '2026-10-26', projectedOpeningDate: '2026-12-08' })).toBe(43);
    expect(openingDelayDays({ openingDate: '2026-12-31', projectedOpeningDate: '2027-01-01' })).toBe(1);
  });

  it('is 0 when the planned opening can be met', () => {
    expect(openingDelayDays({ openingDate: '2026-12-15', projectedOpeningDate: null })).toBe(0);
  });
});

describe('decideReschedule', () => {
  it('changes nothing when the date has already been moved there', () => {
    expect(decideReschedule(pack, { ...profile, opening_date: '2026-12-08' }, today, {}, { from: '2026-10-26', to: '2026-12-08' })).toEqual({
      status: 'unchanged',
    });
  });

  it('refuses a move offered for a date that is no longer the stored one', () => {
    expect(decideReschedule(pack, { ...profile, opening_date: '2026-11-15' }, today, {}, { from: '2026-10-26', to: '2026-12-08' })).toEqual({
      status: 'stale',
    });
  });

  it('moves to the offered date when it can be met', () => {
    expect(decideReschedule(pack, profile, today, {}, { from: '2026-10-26', to: '2026-12-08' })).toEqual({ status: 'move', openingDate: '2026-12-08' });
    expect(decideReschedule(pack, profile, today, {}, { from: '2026-10-26', to: '2027-01-20' })).toEqual({ status: 'move', openingDate: '2027-01-20' });
  });

  it('moves to the earliest reachable date when the offered one cannot be met either', () => {
    // The offer was made a week ago: another week of the chain is gone.
    expect(decideReschedule(pack, profile, '2026-10-03', {}, { from: '2026-10-26', to: '2026-12-08' })).toEqual({
      status: 'move',
      openingDate: '2026-12-15',
    });
  });

  it('counts done steps', () => {
    expect(decideReschedule(pack, profile, today, { 'register-business': 'done' }, { from: '2026-10-26', to: '2026-11-15' })).toEqual({
      status: 'move',
      openingDate: '2026-12-01',
    });
  });

  it('moves to the earliest reachable date when the offered one has passed while steps are left', () => {
    // 73 days of the chain from 2026-12-10.
    expect(decideReschedule(pack, profile, '2026-12-10', {}, { from: '2026-10-26', to: '2026-12-08' })).toEqual({
      status: 'move',
      openingDate: '2027-02-21',
    });
  });

  it('lets the offer expire when the date it would move to is today or has passed', () => {
    const allDone = { 'register-business': 'done', 'lease-premises': 'done', 'fit-out': 'done', 'fire-safety': 'done' } as const;
    const move = { from: '2026-10-26', to: '2026-12-08' };
    // Everything is done, so nothing projects a later date: the offered one stands, and it is no longer ahead.
    expect(decideReschedule(pack, profile, '2026-12-10', allDone, move)).toEqual({ status: 'expired' });
    expect(decideReschedule(pack, profile, '2026-12-08', allDone, move)).toEqual({ status: 'expired' });
    expect(decideReschedule(pack, profile, '2026-12-07', allDone, move)).toEqual({ status: 'move', openingDate: '2026-12-08' });
  });

  it('refuses a move to a date the route cannot be built for', () => {
    expect(decideReschedule(pack, profile, today, {}, { from: '2026-10-26', to: '2026-02-30' })).toEqual({ status: 'stale' });
    expect(decideReschedule(pack, { ...profile, city: 'moscow' }, today, {}, { from: '2026-10-26', to: '2026-12-08' })).toEqual({ status: 'stale' });
  });
});

describe('decideKeep', () => {
  it('keeps a date that cannot be met and counts the days the reachable one is later', () => {
    // 2026-10-26 → 2026-12-08.
    expect(decideKeep({ openingDate: '2026-10-26', projectedOpeningDate: '2026-12-08', today }, '2026-10-26')).toEqual({ status: 'kept', delayDays: 43 });
  });

  it('keeps a date that can be met with no delay', () => {
    expect(decideKeep({ openingDate: '2026-12-08', projectedOpeningDate: null, today }, '2026-12-08')).toEqual({ status: 'kept', delayDays: 0 });
  });

  it('refuses a button made for a date that is no longer the stored one', () => {
    expect(decideKeep({ openingDate: '2026-11-15', projectedOpeningDate: null, today }, '2026-10-26')).toEqual({ status: 'stale' });
    expect(decideKeep({ openingDate: '2026-09-01', projectedOpeningDate: '2026-12-08', today }, '2026-10-26')).toEqual({ status: 'stale' });
  });

  it('has nothing to keep once the date has passed', () => {
    expect(decideKeep({ openingDate: '2026-09-25', projectedOpeningDate: '2026-12-08', today }, '2026-09-25')).toEqual({ status: 'passed' });
    expect(decideKeep({ openingDate: '2026-09-25', projectedOpeningDate: null, today }, '2026-09-25')).toEqual({ status: 'passed' });
  });

  it('counts an opening today as not yet passed', () => {
    expect(decideKeep({ openingDate: today, projectedOpeningDate: '2026-12-08', today }, today)).toEqual({ status: 'kept', delayDays: 73 });
    expect(decideKeep({ openingDate: today, projectedOpeningDate: null, today }, today)).toEqual({ status: 'kept', delayDays: 0 });
  });
});
