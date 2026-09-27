import { describe, expect, it } from 'vitest';
import type { Profile } from '../profile.js';
import { addDays, diffDays, isIsoDate } from './dates.js';
import { buildRoute, nextBestStep, readiness, stepsUnblockedBy, topBlockers, type Route, type TaskStatuses } from './route.js';
import { RulesPackSchema, type RulesPack } from './schema.js';
import { toRouteView } from './view.js';

const source = { url: 'https://www.nalog.gov.ru/', title: 'ФНС', checked_at: '2026-09-18' };

function action(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Действие ${id}`, lane: 'critical', duration_days: 1, why: 'w', do_now: 'd', done_when: 'x', source, kind: 'test_data', ...extra };
}

function makePack(actions: unknown[]): RulesPack {
  return RulesPackSchema.parse({
    manifest: {
      id: 'demo',
      version: '1.2.0',
      title: 'Demo',
      region: { code: 'kazan', name: 'Казань' },
      industry: 'coffee',
      checked_at: '2026-09-18',
      cities: ['kazan'],
    },
    actions,
  });
}

const profile: Profile = {
  format: 'to_go',
  city: 'kazan',
  legal_status: 'none',
  premises: 'searching',
  employees: 0,
  sells_food: false,
  opening_date: '2026-10-20',
};

function route(pack: RulesPack, p: Profile = profile, today = '2026-10-01', statuses: TaskStatuses = {}): Route {
  const result = buildRoute(pack, p, today, statuses);
  if (result.status !== 'ok') throw new Error(`expected a route, got ${result.reason}`);
  return result.route;
}

const ids = (steps: { action: { id: string } }[]) => steps.map((s) => s.action.id);

describe('dates', () => {
  it('does calendar arithmetic and rejects impossible dates', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(diffDays('2026-10-01', '2026-10-20')).toBe(19);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('20.10.2026')).toBe(false);
  });
});

describe('buildRoute', () => {
  it('keeps only applicable actions, in dependency order, dropping edges to non-applicable ones', () => {
    const pack = makePack([
      action('open-point', { depends_on: ['register', 'hire-staff'] }),
      action('hire-staff', { applies_if: { field: 'employees', gt: 0 } }),
      action('register', { applies_if: { field: 'legal_status', eq: 'none' } }),
      action('seating-permit', { applies_if: { field: 'format', eq: 'cafe' } }),
    ]);
    const r = route(pack);

    expect(ids(r.steps)).toEqual(['register', 'open-point']);
    expect(r.steps[1]?.dependsOn).toEqual(['register']);
  });

  it('computes latest start, float and the critical path from the opening date', () => {
    // A (2 days, due 5 days before opening) → B (3 days). Opening 2026-10-20, today 2026-10-01.
    const r = route(makePack([action('a', { duration_days: 2, due_days_before_opening: 5 }), action('b', { duration_days: 3, depends_on: ['a'] })]));
    const [a, b] = r.steps;

    expect(r.daysToOpening).toBe(19);
    expect(a).toMatchObject({ latestFinish: '2026-10-15', latestStart: '2026-10-13', earliestStart: '2026-10-01', earliestFinish: '2026-10-03', floatDays: 12 });
    expect(b).toMatchObject({ latestFinish: '2026-10-20', latestStart: '2026-10-17', earliestStart: '2026-10-03', earliestFinish: '2026-10-06', floatDays: 14 });
    expect(a?.onCriticalPath).toBe(true);
    expect(b?.onCriticalPath).toBe(false);
    expect(r.steps.some((s) => s.overdue)).toBe(false);
    expect(r.projectedOpeningDate).toBeNull();
  });

  it('pulls prerequisites earlier to fit the latest start of their dependents', () => {
    const r = route(makePack([action('lease', { duration_days: 10 }), action('renovate', { duration_days: 7, depends_on: ['lease'] })]));
    expect(r.steps[0]).toMatchObject({ latestFinish: '2026-10-13', latestStart: '2026-10-03', floatDays: 2 });
  });

  it('counts from the earliest reachable opening when the opening date is in the past', () => {
    const r = route(makePack([action('a', { duration_days: 2 })]), { ...profile, opening_date: '2026-09-25' }, '2026-10-01');
    expect(r.daysToOpening).toBe(-6);
    expect(r.projectedOpeningDate).toBe('2026-10-03');
    expect(r.steps[0]).toMatchObject({ latestStart: '2026-10-01', latestFinish: '2026-10-03', overdue: true, floatDays: 0, onCriticalPath: true });
  });

  it('handles an opening today: zero-duration steps are on time, a longer one moves the opening and is overdue', () => {
    const r = route(makePack([action('sign', { duration_days: 0 }), action('train', { duration_days: 1 })]), { ...profile, opening_date: '2026-10-01' });
    expect(r.daysToOpening).toBe(0);
    expect(r.projectedOpeningDate).toBe('2026-10-02');
    expect(r.steps.map((s) => [s.action.id, s.overdue, s.floatDays, s.latestStart])).toEqual([
      ['sign', false, 1, '2026-10-02'],
      ['train', true, 0, '2026-10-01'],
    ]);
  });

  describe('an opening date that cannot be met', () => {
    // The reported case: a coffee-to-go opening in a month, not registered, premises not found. The chain
    // register (7 days) → lease (30) → fit-out (30, done 3 days before opening) → fire safety (5, done 1 day before)
    // takes 73 days, 43 more than there are.
    const chain = makePack([
      action('register-business', { duration_days: 7 }),
      action('lease-premises', { duration_days: 30, depends_on: ['register-business'] }),
      action('fit-out', { duration_days: 30, due_days_before_opening: 3, depends_on: ['lease-premises'] }),
      action('fire-safety', { lane: 'ops', duration_days: 5, due_days_before_opening: 1, depends_on: ['fit-out'] }),
    ]);
    const inAMonth: Profile = { ...profile, opening_date: '2026-10-26' };
    const chainRoute = (p: Profile = inAMonth, statuses: TaskStatuses = {}) => route(chain, p, '2026-09-26', statuses);
    const step = (r: Route, id: string) => r.steps.find((s) => s.action.id === id)!;

    it('projects the earliest opening and dates every step from it: the longest chain starts today', () => {
      const r = chainRoute();
      expect(r.projectedOpeningDate).toBe('2026-12-08');
      expect(r.daysToOpening).toBe(30);
      expect(step(r, 'register-business')).toMatchObject({ latestStart: '2026-09-26', floatDays: 0, overdue: true, onCriticalPath: true });
      expect(step(r, 'lease-premises')).toMatchObject({
        latestStart: '2026-10-03',
        floatDays: 0,
        overdue: false,
        onCriticalPath: true,
        waitingFor: ['register-business'],
      });
      expect(step(r, 'fire-safety')).toMatchObject({ latestStart: '2026-12-02', latestFinish: '2026-12-07', overdue: false });
    });

    it('gives the same schedule when rebuilt at the projected date, which is then met', () => {
      const late = chainRoute();
      const atProjected = chainRoute({ ...inAMonth, opening_date: late.projectedOpeningDate! });
      expect(atProjected.projectedOpeningDate).toBeNull();
      const schedule = (r: Route) => r.steps.map((s) => [s.action.id, s.latestStart, s.latestFinish, s.floatDays, s.onCriticalPath]);
      expect(schedule(atProjected)).toEqual(schedule(late));
      // At the projected date nothing is late any more.
      expect(atProjected.steps.some((s) => s.overdue)).toBe(false);
    });

    it('counts done steps as finished today: the projection moves earlier', () => {
      const r = chainRoute(inAMonth, { 'register-business': 'done' });
      expect(r.projectedOpeningDate).toBe('2026-12-01');
      expect(step(r, 'lease-premises')).toMatchObject({ latestStart: '2026-09-26', floatDays: 0, overdue: true, waitingFor: [] });
      expect(step(r, 'register-business')).toMatchObject({ overdue: false, onCriticalPath: false });
    });

    it('projects nothing once every step is done', () => {
      const done: TaskStatuses = { 'register-business': 'done', 'lease-premises': 'done', 'fit-out': 'done', 'fire-safety': 'done' };
      const r = chainRoute(inAMonth, done);
      expect(r.projectedOpeningDate).toBeNull();
      expect(r.steps.some((s) => s.overdue || s.onCriticalPath)).toBe(false);
    });
  });

  describe('a support step whose own date has passed', () => {
    // «consult» should be done 30 days before opening, which is 12 days ago: an optional step, it moves nothing.
    const pack = makePack([
      action('register', { duration_days: 5 }),
      action('consult', { lane: 'support', duration_days: 1, due_days_before_opening: 30, kind: 'recommendation', source: undefined }),
    ]);
    const consult = (r: Route) => r.steps.find((s) => s.action.id === 'consult')!;

    it('is pulled to today, not overdue and off the critical path, and does not move the opening', () => {
      const r = route(pack);
      expect(r.projectedOpeningDate).toBeNull();
      expect(consult(r)).toMatchObject({ latestStart: '2026-10-01', latestFinish: '2026-10-02', floatDays: 0, overdue: false, onCriticalPath: false });
      expect(r.steps[0]).toMatchObject({ latestStart: '2026-10-15', floatDays: 14, onCriticalPath: true });
    });

    it('is pulled to today as well when a required step moves the opening', () => {
      const r = route(pack, { ...profile, opening_date: '2026-10-03' });
      expect(r.projectedOpeningDate).toBe('2026-10-06');
      expect(consult(r)).toMatchObject({ latestStart: '2026-10-01', floatDays: 0, overdue: false, onCriticalPath: false });
      expect(r.steps[0]).toMatchObject({ latestStart: '2026-10-01', floatDays: 0, overdue: true, onCriticalPath: true });
    });

    it('is on the critical path when only support steps are left', () => {
      const r = route(pack, profile, '2026-10-01', { register: 'done' });
      expect(consult(r)).toMatchObject({ floatDays: 0, overdue: false, onCriticalPath: true });
    });
  });

  describe('a support step after a required one', () => {
    // «bank» (optional, 1 day, done 20 days before opening) waits for «reg» (5 days). Opening 2026-10-06, today 2026-09-26:
    // «reg» has 5 spare days, «bank» cannot make its own date whatever happens.
    const bank = action('bank', {
      lane: 'support',
      duration_days: 1,
      due_days_before_opening: 20,
      depends_on: ['reg'],
      kind: 'recommendation',
      source: undefined,
    });
    const required = [action('reg', { duration_days: 5 }), action('kkt', { duration_days: 2, depends_on: ['reg'] })];
    const step = (r: Route, id: string) => r.steps.find((s) => s.action.id === id)!;

    it('does not hold its prerequisite back: no projection, the prerequisite keeps its own date', () => {
      const r = route(makePack([action('reg', { duration_days: 5 }), bank]), { ...profile, opening_date: '2026-10-06' }, '2026-09-26');
      expect(r.projectedOpeningDate).toBeNull();
      expect(step(r, 'reg')).toMatchObject({ latestStart: '2026-10-01', latestFinish: '2026-10-06', floatDays: 5, overdue: false, onCriticalPath: true });
      // Pulled to the day «reg» can be finished at the earliest: before the latest finish of «reg», done as soon as it can be.
      expect(step(r, 'bank')).toMatchObject({
        latestStart: '2026-10-01',
        earliestStart: '2026-10-01',
        floatDays: 0,
        overdue: false,
        onCriticalPath: false,
        waitingFor: ['reg'],
      });
    });

    it('leaves the dates of the required steps as they are without it', () => {
      for (const opening of ['2026-09-01', '2026-09-28', '2026-10-06', '2026-11-20']) {
        const p = { ...profile, opening_date: opening };
        const withBank = route(makePack([...required, bank]), p, '2026-09-26');
        const without = route(makePack(required), p, '2026-09-26');
        const schedule = (r: Route) =>
          r.steps
            .filter((s) => s.action.lane !== 'support')
            .map((s) => [s.action.id, s.latestStart, s.latestFinish, s.floatDays, s.overdue, s.onCriticalPath]);
        expect(withBank.projectedOpeningDate, opening).toBe(without.projectedOpeningDate);
        expect(schedule(withBank), opening).toEqual(schedule(without));
        expect(step(withBank, 'bank').latestStart >= withBank.today, opening).toBe(true);
      }
    });
  });

  it('never dates a step to do before today', () => {
    const pack = makePack([
      action('a', { duration_days: 20 }),
      action('b', { duration_days: 3, due_days_before_opening: 10, depends_on: ['a'] }),
      action('c', { lane: 'ops', duration_days: 40 }),
      action('d', { lane: 'support', duration_days: 2, due_days_before_opening: 60, kind: 'recommendation', source: undefined }),
    ]);
    for (const opening of ['2026-08-01', '2026-10-01', '2026-10-15', '2026-11-30', '2027-03-01']) {
      const r = route(pack, { ...profile, opening_date: opening });
      for (const s of r.steps) {
        expect(s.latestStart >= r.today, `${opening} ${s.action.id}`).toBe(true);
        expect(s.floatDays, `${opening} ${s.action.id}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('lets a step marked done ahead of its prerequisite hold nothing back', () => {
    // «dd» (5 days, done 20 days before opening) waits for «pp» (10 days). Opening 2026-10-21, today 2026-09-26.
    const pack = makePack([action('pp', { duration_days: 10 }), action('dd', { duration_days: 5, due_days_before_opening: 20, depends_on: ['pp'] })]);
    const p = { ...profile, opening_date: '2026-10-21' };
    expect(route(pack, p, '2026-09-26').projectedOpeningDate).toBe('2026-10-31');
    // A step may be marked done before the one it waits for: then only the opening date bounds «pp».
    const r = route(pack, p, '2026-09-26', { dd: 'done' });
    expect(r.projectedOpeningDate).toBeNull();
    expect(r.steps[0]).toMatchObject({ latestStart: '2026-10-11', latestFinish: '2026-10-21', floatDays: 15, overdue: false, onCriticalPath: true });
  });

  it('treats done prerequisites as finished today', () => {
    const pack = makePack([action('a', { duration_days: 5 }), action('b', { duration_days: 1, depends_on: ['a'] })]);
    const r = route(pack, profile, '2026-10-01', { a: 'done' });
    expect(r.steps[0]).toMatchObject({ status: 'done', overdue: false, onCriticalPath: false });
    expect(r.steps[1]).toMatchObject({ earliestStart: '2026-10-01', waitingFor: [], onCriticalPath: true });
  });

  it('counts a prerequisite listed twice once instead of failing (a pack that skipped validation)', () => {
    const pack = makePack([action('register'), action('kkt', { depends_on: ['register', 'register'] })]);
    expect(() => buildRoute(pack, profile, '2026-10-01')).not.toThrow();
    const r = route(pack);
    expect(ids(r.steps)).toEqual(['register', 'kkt']);
    expect(r.steps[1]).toMatchObject({ dependsOn: ['register'], waitingFor: ['register'] });
  });

  it('is deterministic', () => {
    const pack = makePack([action('a'), action('b', { depends_on: ['a'] })]);
    expect(buildRoute(pack, profile, '2026-10-01')).toEqual(buildRoute(pack, profile, '2026-10-01'));
  });

  it('asks for clarification instead of guessing', () => {
    const pack = makePack([action('a', { applies_if: { field: 'format', eq: 'cafe' } })]);
    expect(buildRoute(pack, { ...profile, city: 'moscow' }, '2026-10-01')).toMatchObject({ status: 'needs_clarification', reason: 'unsupported_city' });
    expect(buildRoute(pack, { ...profile, opening_date: '2026-02-30' }, '2026-10-01')).toMatchObject({ status: 'needs_clarification', reason: 'invalid_opening_date' });
    expect(buildRoute(pack, profile, '2026-10-01')).toMatchObject({ status: 'needs_clarification', reason: 'no_applicable_actions' });
  });
});

describe('topBlockers', () => {
  const pack = makePack([
    action('relaxed', { duration_days: 1 }),
    action('tight', { duration_days: 15 }),
    action('late', { duration_days: 25 }),
    action('medium', { duration_days: 10 }),
    action('not-critical', { lane: 'ops', duration_days: 30 }),
  ]);

  it('returns overdue steps first, then the smallest float, only from the critical lane', () => {
    expect(ids(topBlockers(route(pack)))).toEqual(['late', 'tight', 'medium']);
  });

  it('skips done steps and respects the limit', () => {
    expect(ids(topBlockers(route(pack, profile, '2026-10-01', { late: 'done' }), 2))).toEqual(['tight', 'medium']);
  });
});

describe('nextBestStep', () => {
  const pack = makePack([
    action('register', { duration_days: 5 }),
    action('kkt', { duration_days: 2, depends_on: ['register'] }),
    action('account', { lane: 'support', duration_days: 1, kind: 'recommendation', source: undefined }),
  ]);

  it('picks the most urgent step whose prerequisites are done', () => {
    expect(nextBestStep(route(pack))?.action.id).toBe('register');
    expect(nextBestStep(route(pack, profile, '2026-10-01', { register: 'done' }))?.action.id).toBe('kkt');
  });

  it('never suggests a step that still waits for prerequisites', () => {
    const r = route(pack, profile, '2026-10-01', { account: 'done' });
    expect(r.steps.find((s) => s.action.id === 'kkt')?.waitingFor).toEqual(['register']);
    expect(nextBestStep(r)?.action.id).toBe('register');
  });

  it('returns null when everything is done', () => {
    expect(nextBestStep(route(pack, profile, '2026-10-01', { register: 'done', kkt: 'done', account: 'done' }))).toBeNull();
  });

  describe('against a support step that is due today', () => {
    // «consult» comes first in the pack and is due 30 days before opening: it is pulled to today with no spare days.
    const tie = makePack([
      action('consult', { lane: 'support', duration_days: 1, due_days_before_opening: 30, kind: 'recommendation', source: undefined }),
      action('register', { duration_days: 5 }),
    ]);

    // An overdue step is an available required step with no spare days while the opening date is lost, and every such
    // step is overdue: on a built route the order of required before optional, then by spare days, puts overdue steps
    // first already. «Overdue first» cannot be told apart here and stays in nextBestStep as a safeguard.
    it('puts an overdue required step before an optional one due today', () => {
      const r = route(tie, { ...profile, opening_date: '2026-10-03' });
      expect(r.steps.map((s) => [s.action.id, s.floatDays, s.overdue])).toEqual([
        ['consult', 0, false],
        ['register', 0, true],
      ]);
      expect(nextBestStep(r)?.action.id).toBe('register');
    });

    it('puts a required step with the same spare days before the optional one', () => {
      const r = route(tie, { ...profile, opening_date: '2026-10-06' });
      expect(r.steps.map((s) => [s.action.id, s.floatDays, s.overdue, s.latestStart])).toEqual([
        ['consult', 0, false, '2026-10-01'],
        ['register', 0, false, '2026-10-01'],
      ]);
      expect(nextBestStep(r)?.action.id).toBe('register');
    });

    it('puts a required step before an optional one whatever their spare days', () => {
      const r = route(tie, { ...profile, opening_date: '2026-10-11' });
      expect(r.projectedOpeningDate).toBeNull();
      expect(r.steps.map((s) => [s.action.id, s.floatDays])).toEqual([
        ['consult', 0],
        ['register', 5],
      ]);
      expect(nextBestStep(r)?.action.id).toBe('register');
    });

    it('gives the optional step once no required step can be started', () => {
      expect(nextBestStep(route(tie, { ...profile, opening_date: '2026-10-11' }, '2026-10-01', { register: 'done' }))?.action.id).toBe('consult');
    });
  });
});

describe('stepsUnblockedBy', () => {
  // «equip», «haccp» and «sign» wait for «lease» alone, «kkt» for «inn» too.
  const pack = makePack([
    action('lease'),
    action('inn'),
    action('equip', { depends_on: ['lease'] }),
    action('haccp', { depends_on: ['lease'] }),
    action('kkt', { depends_on: ['lease', 'inn'] }),
    action('sign', { depends_on: ['lease'] }),
  ]);
  const view = (statuses: TaskStatuses) => toRouteView(route(pack, profile, '2026-10-01', statuses), pack);
  const unblocked = (statuses: TaskStatuses, id: string) => stepsUnblockedBy(view(statuses), id).map((t) => t.id);

  it('gives the steps not done that wait for this one alone', () => {
    // «kkt» waits for «inn» too; «sign» is done already.
    expect(unblocked({ sign: 'done' }, 'lease')).toEqual(['equip', 'haccp']);
  });

  it('takes in a step once its other prerequisites are done', () => {
    expect(unblocked({ inn: 'done' }, 'lease')).toEqual(['equip', 'haccp', 'kkt', 'sign']);
  });

  it('gives none for a step no step waits for alone, or for one done already', () => {
    expect(unblocked({}, 'inn')).toEqual([]);
    expect(unblocked({ lease: 'done' }, 'lease')).toEqual([]);
  });
});

describe('readiness', () => {
  it('counts done steps overall and in the critical lane', () => {
    const pack = makePack([action('a'), action('b'), action('c', { lane: 'support', kind: 'recommendation', source: undefined })]);
    expect(readiness(route(pack, profile, '2026-10-01', { a: 'done', c: 'done', unknown: 'done' }))).toEqual({
      done: 2,
      total: 3,
      percent: 66,
      criticalDone: 1,
      criticalTotal: 2,
    });
  });
});
