import { describe, expect, it } from 'vitest';
import type { Profile } from '../profile.js';
import { buildRoute, type TaskStatuses } from './route.js';
import { RulesPackSchema } from './schema.js';
import { PlaceViewSchema, RouteViewSchema, TaskDetailSchema, toRouteView, toTaskDetail, type RouteView } from './view.js';

const source = { url: 'https://www.nalog.gov.ru/', title: 'ФНС', checked_at: '2026-09-18' };
const manifest = {
  id: 'demo', version: '1.0.0', title: 'Demo', industry: 'coffee', checked_at: '2026-09-18', cities: ['kazan'],
  region: { code: 'kazan', name: 'Казань' }, disclaimer: 'Не является юридической консультацией.',
};
const pack = RulesPackSchema.parse({
  manifest,
  actions: [
    { id: 'register', title: 'Регистрация', lane: 'critical', duration_days: 5, why: 'w', do_now: 'd', done_when: 'x', source, kind: 'official_fact' },
    { id: 'kkt', title: 'Касса', lane: 'critical', duration_days: 2, depends_on: ['register'], why: 'w', do_now: 'd', prepare: ['ККТ'], done_when: 'x', source, kind: 'test_data' },
    { id: 'staff', title: 'Команда', lane: 'ops', duration_days: 7, why: 'w', do_now: 'd', done_when: 'x', kind: 'recommendation' },
  ],
});
const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'signed', employees: 2, sells_food: false, opening_date: '2026-10-31' };
const built = buildRoute(pack, profile, '2026-10-01', { register: 'done' });
if (built.status !== 'ok') throw new Error('route expected');
const route = built.route;

describe('route view', () => {
  it('matches the API schema and groups steps by lane', () => {
    const view = toRouteView(route, pack);
    expect(RouteViewSchema.parse(view)).toEqual(view);
    expect(view.pack).toMatchObject({ id: 'demo', version: '1.0.0', disclaimer: 'Не является юридической консультацией.' });
    expect(view.readiness).toMatchObject({ done: 1, total: 3 });
    expect(view.lanes.critical.map((t) => t.id)).toEqual(['register', 'kkt']);
    expect(view.lanes.ops.map((t) => t.id)).toEqual(['staff']);
    expect(view.blockers.map((t) => t.id)).toEqual(['kkt']);
    expect(view.nextStep?.id).toBeDefined();
    expect(view.projectedOpeningDate).toBeNull();
  });

  it('publishes the earliest reachable opening when the chosen date cannot be met', () => {
    // Opening in two days: registration (5 days) and the cash register (2) after it need 7.
    const late = buildRoute(pack, { ...profile, opening_date: '2026-10-03' }, '2026-10-01');
    if (late.status !== 'ok') throw new Error('route expected');
    const view = toRouteView(late.route, pack);
    expect(RouteViewSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({ openingDate: '2026-10-03', projectedOpeningDate: '2026-10-08', daysToOpening: 2 });
    expect(view.nextStep).toMatchObject({ id: 'register', latestStart: '2026-10-01', floatDays: 0, overdue: true });
    expect(RouteViewSchema.safeParse({ ...view, projectedOpeningDate: '08.10.2026' }).success).toBe(false);
  });

  it('builds a task card with provenance and prerequisites', () => {
    const detail = toTaskDetail(route, route.steps.find((s) => s.action.id === 'kkt')!, pack);
    expect(TaskDetailSchema.parse(detail)).toEqual(detail);
    expect(detail).toMatchObject({
      kind: 'test_data',
      prepare: ['ККТ'],
      dependsOn: [{ id: 'register', title: 'Регистрация' }],
      waitingFor: [],
      source: { url: 'https://www.nalog.gov.ru/', title: 'ФНС', checkedAt: '2026-09-18' },
    });
    const staff = toTaskDetail(route, route.steps.find((s) => s.action.id === 'staff')!, pack);
    expect(staff.source).toBeNull();
  });

  it('gives empty place lists for a pack without places', () => {
    expect(toRouteView(route, pack).places).toEqual([]);
    expect(toTaskDetail(route, route.steps[0]!, pack).places).toEqual([]);
  });
});

describe('places of steps', () => {
  const checked = (url: string, title: string) => ({ url, title, checked_at: '2026-09-23' });
  const lab = {
    id: 'lab', name: 'Центр гигиены и эпидемиологии', address: 'Казань, ул. Сеченова, 13а', lat: 55.798172, lon: 49.170644,
    source: checked('https://fbuz.tatarstan.ru/', 'ФБУЗ «ЦГиЭ в РТ»'),
  };
  const office = {
    id: 'office', name: 'Межрайонная ИФНС № 18', short_name: 'ИФНС № 18', address: 'Казань, ул. Владимира Кулагина, 1', lat: 55.74213,
    lon: 49.142156, osm: 'way/92939129', note: 'Регистрирующая инспекция', source: checked('https://www.nalog.gov.ru/rn16/ifns/16_mri18/', 'ФНС'),
  };
  const center = {
    id: 'center', name: 'Центр «Мой бизнес»', address: 'Казань, ул. Петербургская, 28', lat: 55.784258, lon: 49.127051,
    source: checked('https://fpprt.ru/centers/centr-moj-biznes/', 'Фонд поддержки предпринимательства РТ'),
  };
  const terrace = {
    id: 'terrace', name: 'Администрация района', address: 'Казань, ул. Баумана, 1', lat: 55.79, lon: 49.11,
    source: checked('https://kzn.ru/', 'Портал Казани'),
  };
  const step = (id: string, extra: Record<string, unknown> = {}) => ({
    id, title: `Шаг ${id}`, lane: 'ops', duration_days: 3, why: 'w', do_now: 'd', done_when: 'x', kind: 'recommendation', ...extra,
  });

  // Steps and places are listed in other orders than the route takes them: the views must follow the route.
  const placesPack = RulesPackSchema.parse({
    manifest: pack.manifest,
    places: [lab, office, center, terrace],
    actions: [
      step('staff', { depends_on: ['control'], places: ['center', 'lab'] }),
      step('control', { depends_on: ['register'], places: ['lab'] }),
      step('register', { places: ['office'] }),
      step('summer-terrace', { applies_if: { field: 'format', eq: 'cafe' }, places: ['terrace', 'lab'] }),
      step('bank'),
    ],
  });

  function routeFor(format: Profile['format'], statuses: TaskStatuses = {}) {
    const result = buildRoute(placesPack, { ...profile, format }, '2026-10-01', statuses);
    if (result.status !== 'ok') throw new Error('route expected');
    return result.route;
  }
  const toGo = routeFor('to_go');
  const detailOf = (id: string) => toTaskDetail(toGo, toGo.steps.find((s) => s.action.id === id)!, placesPack);
  const byStep = (view: RouteView) => view.places.map((p) => [p.id, p.actions.map((a) => a.id)]);

  it('gives a task card the places of its step in the order of the card', () => {
    const detail = detailOf('staff');
    expect(TaskDetailSchema.parse(detail)).toEqual(detail);
    expect(detail.places).toEqual([
      {
        id: 'center', name: 'Центр «Мой бизнес»', shortName: null, address: 'Казань, ул. Петербургская, 28', lat: 55.784258, lon: 49.127051,
        note: null, osmUrl: null,
        source: { url: 'https://fpprt.ru/centers/centr-moj-biznes/', title: 'Фонд поддержки предпринимательства РТ', checkedAt: '2026-09-23' },
      },
      {
        id: 'lab', name: 'Центр гигиены и эпидемиологии', shortName: null, address: 'Казань, ул. Сеченова, 13а', lat: 55.798172, lon: 49.170644,
        note: null, osmUrl: null,
        source: { url: 'https://fbuz.tatarstan.ru/', title: 'ФБУЗ «ЦГиЭ в РТ»', checkedAt: '2026-09-23' },
      },
    ]);
    expect(detailOf('register').places).toEqual([
      expect.objectContaining({ id: 'office', shortName: 'ИФНС № 18', note: 'Регистрирующая инспекция', osmUrl: 'https://www.openstreetmap.org/way/92939129' }),
    ]);
    expect(detailOf('bank').places).toEqual([]);
  });

  it('publishes coordinates within their ranges and the check date as a date', () => {
    const [place] = detailOf('register').places;
    expect(PlaceViewSchema.safeParse(place).success).toBe(true);
    expect(PlaceViewSchema.safeParse({ ...place, lat: 90.5 }).success).toBe(false);
    expect(PlaceViewSchema.safeParse({ ...place, lon: -180.5 }).success).toBe(false);
    expect(PlaceViewSchema.safeParse({ ...place, source: { ...place!.source, checkedAt: '23.09.2026' } }).success).toBe(false);
  });

  it('lists every place of the route once, in route order, with the steps done there', () => {
    const view = toRouteView(toGo, placesPack);
    expect(RouteViewSchema.parse(view)).toEqual(view);
    expect(toGo.steps.map((s) => s.action.id)).toEqual(['register', 'control', 'staff', 'bank']);
    expect(byStep(view)).toEqual([
      ['office', ['register']],
      ['lab', ['control', 'staff']],
      ['center', ['staff']],
    ]);
    expect(view.places[0]).toEqual({
      id: 'office', name: 'Межрайонная ИФНС № 18', shortName: 'ИФНС № 18', address: 'Казань, ул. Владимира Кулагина, 1', lat: 55.74213, lon: 49.142156,
      note: 'Регистрирующая инспекция', osmUrl: 'https://www.openstreetmap.org/way/92939129',
      source: { url: 'https://www.nalog.gov.ru/rn16/ifns/16_mri18/', title: 'ФНС', checkedAt: '2026-09-23' },
      actions: [{ id: 'register', title: 'Шаг register' }],
    });
    // A step with two places is referenced from each of them by its own object: views share nothing.
    const [atLab, atCenter] = [view.places[1]!, view.places[2]!];
    expect(atLab.actions[1]).toEqual(atCenter.actions[0]);
    expect(atLab.actions[1]).not.toBe(atCenter.actions[0]);
  });

  it('keeps the places of done steps: a done step is still part of the route', () => {
    const view = toRouteView(routeFor('to_go', { register: 'done', control: 'done' }), placesPack);
    expect(view.readiness).toMatchObject({ done: 2 });
    expect(byStep(view)).toEqual([
      ['office', ['register']],
      ['lab', ['control', 'staff']],
      ['center', ['staff']],
    ]);
  });

  it('leaves out the steps that do not apply to the profile, and places left without steps', () => {
    // A coffee-to-go has no summer terrace: its own place disappears, the shared one stays for the other steps.
    const toGoView = toRouteView(toGo, placesPack);
    expect(toGoView.places.map((p) => p.id)).not.toContain('terrace');
    expect(toGoView.places.find((p) => p.id === 'lab')?.actions.map((a) => a.id)).not.toContain('summer-terrace');
    expect(byStep(toRouteView(routeFor('cafe'), placesPack))).toEqual([
      ['office', ['register']],
      ['lab', ['control', 'staff', 'summer-terrace']],
      ['center', ['staff']],
      ['terrace', ['summer-terrace']],
    ]);
  });
});
