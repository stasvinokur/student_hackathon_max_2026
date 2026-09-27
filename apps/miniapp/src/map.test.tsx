import {
  criterionReach,
  describeCriterion,
  explainCell,
  IMPORTANCE,
  importanceLabel,
  indexAttribution,
  RulesPackSchema,
  scoreLocations,
  type LocationIndex,
  type LocationSettings,
  type Profile,
  type RouteView,
  type RulesPack,
  type TaskDetail,
} from '@otkryvay/core';
import { MaxUI } from '@maxhub/max-ui';
import { tinyLocationIndex } from '@otkryvay/core/testing';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient, type AppConfig } from './api.js';
import type { IndexState, MapFocus } from './screens/map/model.js';
import { parseSnapshot } from './screens/map/snapshot.js';
import { MapScreen } from './screens/MapScreen.js';
import { fakeApi, fakeBridge, renderApp } from './test-utils.js';

// The real validation, counted: the app must validate a snapshot once per answer, not on every return to the map.
vi.mock('./screens/map/snapshot.js', async (importOriginal) => {
  const { parseSnapshot } = await importOriginal<typeof import('./screens/map/snapshot.js')>();
  return { parseSnapshot: vi.fn(parseSnapshot) };
});
// The lists as they work without the map canvas (list mode: no WebGL here, reported once as map_failed { kind: 'webgl' }).
// The canvas itself is driven in map-canvas.test.tsx.
vi.mock('./screens/map/mapView.js', async () => ({ ...(await import('./test-map-view.js')), hasWebGL: () => false }));

// The «Карта» tab in list mode: the location index of the tiny test snapshot and the places of a route.

const ix = tinyLocationIndex;
/** Settings belong to the methodology (the pack and its config hash): a data refresh keeps them. */
const SETTINGS_KEY = `location:${ix.pack}:${ix.source.configSha256.slice(0, 8)}`;

const source = { url: 'https://www.nalog.gov.ru/', title: '129-ФЗ, ст. 8', checked_at: '2026-09-18' };
const pack = RulesPackSchema.parse({
  manifest: {
    id: ix.pack, version: '1.1.0', title: 'Кофейня, Казань', industry: 'coffee', checked_at: '2026-09-18', cities: ['kazan'],
    region: { code: 'kazan', name: 'Казань' },
  },
  places: [
    {
      id: 'ifns-18', name: 'Межрайонная ИФНС № 18', address: 'Казань, ул. Владимира Кулагина, 1', lat: 55.74213, lon: 49.142156,
      osm: 'way/92939129', note: 'Регистрирующая инспекция.',
      source: { url: 'https://www.nalog.gov.ru/rn16/ifns/16_mri18/', title: 'ФНС России — МРИ № 18', checked_at: '2026-09-23' },
    },
    {
      id: 'cgie-rt', name: 'Центр гигиены и эпидемиологии', address: 'Казань, ул. Сеченова, 13а', lat: 55.798172, lon: 49.170644,
      source: { url: 'https://fbuz.tatarstan.ru/', title: 'ФБУЗ «ЦГиЭ в РТ»', checked_at: '2026-09-22' },
    },
  ],
  actions: [
    {
      id: 'register-business', title: 'Зарегистрировать ИП', lane: 'critical', duration_days: 7, why: 'Без регистрации нельзя работать.',
      do_now: 'Подайте заявление.', done_when: 'Есть лист записи.', places: ['ifns-18'], source, kind: 'official_fact',
    },
    {
      id: 'lease-premises', title: 'Арендовать помещение', lane: 'critical', duration_days: 14, why: 'Без помещения нечего открывать.',
      do_now: 'Подберите район и посмотрите помещения.', done_when: 'Договор подписан.', kind: 'recommendation',
    },
    {
      id: 'medical-books', title: 'Оформить медкнижки', lane: 'ops', duration_days: 5, why: 'Без медкнижек нельзя работать с едой.',
      do_now: 'Запишитесь на осмотр.', done_when: 'Медкнижки у всех.', places: ['cgie-rt'], kind: 'test_data',
    },
    {
      id: 'production-control', title: 'Утвердить производственный контроль', lane: 'ops', duration_days: 5, why: 'w', do_now: 'd',
      done_when: 'x', places: ['cgie-rt'], kind: 'test_data',
    },
  ],
});
const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 1, sells_food: false, opening_date: '2026-11-01' };

const withoutPlaces: RulesPack = { ...pack, places: [], actions: pack.actions.map((action) => ({ ...action, places: [] })) };
const withoutLease: RulesPack = { ...pack, actions: pack.actions.filter((action) => action.id !== 'lease-premises') };

const withIndex: AppConfig = { features: { explain: false, locationIndex: [{ pack: ix.pack, version: ix.version, actions: ['lease-premises'] }] } };

function mapApi(overrides: Partial<ApiClient> = {}, rules: RulesPack = pack): ApiClient {
  return fakeApi(rules, profile, {
    getConfig: vi.fn(async () => withIndex),
    getLocationIndex: vi.fn(async (): Promise<unknown> => ix),
    ...overrides,
  });
}

/** Testing Library collapses whitespace before it compares text, the core's no-break spaces included. */
const text = (value: string) => value.replace(/\s+/g, ' ').trim();
/** An accessible name matcher that ignores the kind of spaces. */
const named = (value: string) => (name: string) => text(name) === text(value);

/** Applies the config the app asked for: a check that something is absent must not pass before it is applied. */
async function configApplied(api: ApiClient) {
  await act(async () => {
    await Promise.resolve(vi.mocked(api.getConfig).mock.results[0]!.value).catch(() => {});
  });
}

async function openMapTab() {
  await userEvent.click(await findSection('Карта'));
  await screen.findByText(ix.title);
}

async function openCriteria() {
  await userEvent.click(screen.getByRole('button', { name: 'Критерии' }));
}

async function choose(criterion: string, level: string) {
  await userEvent.selectOptions(screen.getByRole('combobox', { name: criterion }), level);
}

function topRows() {
  return within(screen.getByRole('region', { name: 'Лучшие места' })).getAllByRole('button');
}

/** The list «Лучшие места» shows the top of the core, in its order. */
function expectTop(settings?: LocationSettings) {
  const top = scoreLocations(ix, settings).top;
  const rows = topRows();
  expect(rows).toHaveLength(top.length);
  top.forEach((place, i) => {
    const row = rows[i]!;
    expect(row.textContent, `row ${i}`).toContain(place.title);
    for (const fact of place.highlights) expect(row.textContent, `row ${i}`).toContain(fact);
    expect(within(row).getByText(String(place.score)), `row ${i}`).toBeTruthy();
    expect(within(row).getByText(String(place.rank)), `row ${i}`).toBeTruthy();
  });
}

/** The live region of «Критерии»: it reads out how many places pass them, and shows their warnings. */
function criteriaStatus() {
  return within(screen.getByRole('button', { name: 'Критерии' }).closest('section')!).getByRole('status');
}

/** «Подходит N из M» is read out, not shown: it is in the status of «Критерии» alone, visually hidden. */
function expectPassing(count: string, message = count) {
  const found = screen.getAllByText(count);
  expect(found, message).toHaveLength(1);
  expect(found[0]!.closest('[role="status"]'), message).toBe(criteriaStatus());
  expect(found[0]!.closest('.visually-hidden'), message).not.toBeNull();
}

function sent(api: ApiClient, type: string) {
  return vi.mocked(api.sendEvent).mock.calls.filter(([event]) => event === type);
}

/** Failures of the index; list mode reports its missing WebGL once as well, which these tests are not about. */
function indexFailures(api: ApiClient) {
  return sent(api, 'map_failed').filter(([, props]) => props?.kind !== 'webgl');
}

/** The switch of the root screens, «Маршрут | Карта»: app sections, so a navigation with buttons. */
const sections = () => screen.queryByRole('navigation', { name: 'Разделы' });
const section = (name: 'Маршрут' | 'Карта') => within(screen.getByRole('navigation', { name: 'Разделы' })).getByRole('button', { name });
const findSection = async (name: 'Маршрут' | 'Карта') => within(await screen.findByRole('navigation', { name: 'Разделы' })).getByRole('button', { name });

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
});

describe('«Маршрут | Карта» sections', () => {
  it('stay hidden without a location index and places: the app looks as before', async () => {
    const api = fakeApi(withoutPlaces, profile, { getConfig: vi.fn(async () => ({ features: { explain: false, locationIndex: [] } })) });
    renderApp({ api });
    await screen.findByText('Следующий шаг');
    await configApplied(api);
    expect(sections()).toBeNull();
  });

  it('ignore a location index of another pack and a config that fails', async () => {
    const other: AppConfig = { features: { explain: false, locationIndex: [{ pack: 'moscow-coffee', version: ix.version, actions: [] }] } };
    let api = fakeApi(withoutPlaces, profile, { getConfig: vi.fn(async () => other) });
    renderApp({ api });
    await screen.findByText('Следующий шаг');
    await configApplied(api);
    expect(sections()).toBeNull();
    cleanup();

    api = fakeApi(withoutPlaces, profile, { getConfig: vi.fn(async () => Promise.reject(new Error('down'))) });
    renderApp({ api });
    await screen.findByText('Следующий шаг');
    await configApplied(api);
    expect(sections()).toBeNull();
  });

  it('read the config defensively: a malformed entry or list is no index', async () => {
    const entry = { pack: ix.pack, version: ix.version, actions: ['lease-premises'] };
    const junk = { features: { explain: false, locationIndex: [null, { pack: ix.pack }, { ...entry, actions: 'lease-premises' }] } };
    let api = mapApi({ getConfig: vi.fn(async () => junk as unknown as AppConfig) }, withoutPlaces);
    renderApp({ api });
    await screen.findByText('Следующий шаг');
    await configApplied(api);
    expect(sections()).toBeNull();
    cleanup();

    const mixed = { features: { explain: false, locationIndex: [null, 'kazan-coffee', entry] } };
    renderApp({ api: mapApi({ getConfig: vi.fn(async () => mixed as unknown as AppConfig) }, withoutPlaces) });
    await openMapTab();
    cleanup();

    const notAList = { features: { explain: false, locationIndex: entry } };
    api = mapApi({ getConfig: vi.fn(async () => notAList as unknown as AppConfig) }, withoutPlaces);
    renderApp({ api });
    await screen.findByText('Следующий шаг');
    await configApplied(api);
    expect(sections()).toBeNull();
  });

  it('stay on the map when its places are gone after a route update, so the route is one tap away', async () => {
    const api = fakeApi(pack, profile);
    const { getRoute } = api;
    let calls = 0;
    api.getRoute = vi.fn(async () => {
      const route = await getRoute();
      return ++calls === 1 ? route : { ...route, places: [] };
    });
    renderApp({ api });
    await userEvent.click(await findSection('Карта'));
    await userEvent.click(within(await screen.findByRole('region', { name: 'Места для шагов' })).getByRole('button', { name: /Межрайонная ИФНС/ }));
    const card = screen.getByRole('region', { name: 'Межрайонная ИФНС № 18' });
    await userEvent.click(within(card).getByRole('button', { name: /Зарегистрировать ИП/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Выполнено' }));
    await waitFor(() => expect(api.getRoute).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findByText('Карта пока пуста')).toBeTruthy();
    await userEvent.click(section('Маршрут'));
    expect(await screen.findByText('Следующий шаг')).toBeTruthy();
  });

  it('appear with a location index of the route pack', async () => {
    const api = mapApi({}, withoutPlaces);
    renderApp({ api });
    const nav = await screen.findByRole('navigation', { name: 'Разделы' });
    expect(within(nav).getAllByRole('button').map((button) => [button.textContent, button.getAttribute('aria-current')])).toEqual([
      ['Маршрут', 'page'],
      ['Карта', null],
    ]);
    expect(screen.getByText('Следующий шаг')).toBeTruthy();
    // The snapshot is loaded when the map is shown, not with the route.
    expect(api.getLocationIndex).not.toHaveBeenCalled();

    await openMapTab();
    expect(api.getLocationIndex).toHaveBeenCalledExactlyOnceWith(ix.pack);
    expect(screen.queryByRole('region', { name: 'Места для шагов' })).toBeNull();
  });

  it('appear with the places of the route alone: then the map lists the places', async () => {
    const api = fakeApi(pack, profile);
    renderApp({ api });
    await userEvent.click(await findSection('Карта'));

    const places = await screen.findByRole('region', { name: 'Места для шагов' });
    expect(within(places).getByText('Межрайонная ИФНС № 18')).toBeTruthy();
    expect(screen.getByText('Места для шагов маршрута')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Критерии' })).toBeNull();
    expect(screen.queryByText(ix.title)).toBeNull();
    expect(api.getLocationIndex).not.toHaveBeenCalled();
  });

  it('switch by replacing the root: no back button on either tab, each starts at the top', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const api = mapApi();
    const bridge = renderApp({ api });
    await findSection('Карта');
    // The route keeps its scroll for «Назад» from a step…
    Object.defineProperty(window, 'scrollY', { value: 500, configurable: true });
    await userEvent.click(screen.getAllByText('Зарегистрировать ИП')[0]!);
    await screen.findByText('Без регистрации нельзя работать.');
    bridge.back!();
    await screen.findByText('Следующий шаг');
    expect(scrollTo).toHaveBeenLastCalledWith(0, 500);

    // …but a tab is a new root and opens at the top.
    await openMapTab();
    expect(section('Карта').getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull();
    expect(bridge.back).toBeNull();
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    expect(sent(api, 'map_opened')).toEqual([['map_opened', { source: 'tab' }]]);

    await userEvent.click(section('Маршрут'));
    expect(await screen.findByText('Следующий шаг')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull();
    expect(bridge.back).toBeNull();
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);

    // The route works as before: a step opens as an inner screen and «Назад» returns to the route.
    await userEvent.click(screen.getAllByText('Зарегистрировать ИП')[0]!);
    expect(await screen.findByText('Без регистрации нельзя работать.')).toBeTruthy();
    expect(sections()).toBeNull();
    bridge.back!();
    expect(await screen.findByText('Следующий шаг')).toBeTruthy();
    expect(section('Маршрут').getAttribute('aria-current')).toBe('page');
  });

  it('keep the map as it was across a switch to the route and back: the card and the open criteria', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    await openCriteria();
    await userEvent.click(topRows()[1]!);
    const result = scoreLocations(ix);
    const title = explainCell(ix, result, result.top[1]!.cell).title;
    expect(screen.getByRole('region', { name: named(title) })).toBeTruthy();

    await userEvent.click(section('Маршрут'));
    await screen.findByText('Следующий шаг');
    await userEvent.click(section('Карта'));
    expect(await screen.findByRole('region', { name: named(title) })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Критерии' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('keep the focus on the section switch after a switch: the new screen brings its own', async () => {
    renderApp({ api: mapApi() });
    await userEvent.click(await findSection('Карта'));
    expect(await screen.findByText(ix.title)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(section('Карта')));
  });

  it('switch the theme from their bar, outside the navigation', async () => {
    const api = mapApi();
    const bridge = renderApp({ api });
    const nav = await screen.findByRole('navigation', { name: 'Разделы' });
    const toggle = screen.getByRole('button', { name: 'Тёмная тема' });
    // Beside the sections, not one of them: the navigation holds the two sections alone.
    expect(nav.contains(toggle)).toBe(false);
    expect(toggle.closest('.sections-bar')).toBe(nav.closest('.sections-bar'));
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual(['Маршрут', 'Карта']);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(document.documentElement.dataset.theme).toBe('light');
    // The icon shows the theme on screen, the sun (its disc) in the light one, and is no part of the name.
    expect(toggle.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(toggle.querySelector('circle')).toBeTruthy();

    vi.mocked(bridge.haptic).mockClear();
    const events = vi.mocked(api.sendEvent).mock.calls.length;
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // The moon, a crescent with no disc.
    expect(toggle.querySelector('circle')).toBeNull();
    expect(toggle.querySelector('svg path')).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(bridge.haptic).toHaveBeenCalledExactlyOnceWith('tap');
    // A setting of the device, not a step of the scenario: no analytics.
    expect(vi.mocked(api.sendEvent).mock.calls).toHaveLength(events);
    // The focus stays on the switch: the screen is not replaced.
    expect(document.activeElement).toBe(toggle);

    // The map tab has the same switch, in the same state.
    await openMapTab();
    const again = screen.getByRole('button', { name: 'Тёмная тема' });
    expect(again.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(again);
    expect(again.getAttribute('aria-pressed')).toBe('false');
    expect(again.querySelector('circle')).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });
});

describe('location index', () => {
  it('keeps the places while the snapshot loads and says the index is on its way', async () => {
    renderApp({ api: mapApi({ getLocationIndex: vi.fn(() => new Promise<unknown>(() => {})) }) });
    await userEvent.click(await findSection('Карта'));
    // The places come from the route: the map screen shows them at once, not the loader of its chunk. The index
    // keeps a place above them, so they do not jump away under a finger when it arrives.
    const places = await screen.findByRole('region', { name: 'Места для шагов' });
    const loader = screen.getByText('Загружаем индекс мест…');
    expect(loader.compareDocumentPosition(places) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The skeleton takes the shape of what comes: the title of the index, then the criteria, no line between them.
    const skeleton = loader.closest('.index-skeleton')!;
    expect([...skeleton.children].slice(0, 2).map((part) => part.className)).toEqual(['index-skeleton__title', 'index-skeleton__block']);
    // The tab has its heading while it waits: the title of the index is the place of it.
    expect(screen.getByRole('heading', { level: 1, name: 'Индекс мест' }).closest('.index-skeleton')).toBe(skeleton);
    expect(screen.queryByText('Индекс мест сейчас недоступен — попробуйте позже.')).toBeNull();
    expect(screen.queryByText('Места для шагов маршрута')).toBeNull();
  });

  it('validates a snapshot once, however often the map is shown', async () => {
    vi.mocked(parseSnapshot).mockClear();
    renderApp({ api: mapApi() });
    await openMapTab();
    for (let i = 0; i < 2; i++) {
      await userEvent.click(section('Маршрут'));
      await userEvent.click(await findSection('Карта'));
      await screen.findByText(ix.title);
    }
    expect(parseSnapshot).toHaveBeenCalledTimes(1);
  });

  it('introduces the index by its title alone: no data label, disclaimer, footer or attribution', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    expect(screen.getByText(ix.title).closest('header')!.textContent).toBe(ix.title);
    expect(screen.queryByText(/Индекс от 0 до 100/)).toBeNull();
    expect(screen.queryByText(/Подготовленные данные/)).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    // The core still has them; the screen does not show them. The basemap keeps its own attribution, in the «i».
    expect(document.body.textContent).not.toContain(ix.disclaimer);
    expect(document.body.textContent).not.toContain(indexAttribution(ix));
    expect(screen.getByTestId('map-slot')).toBeTruthy();
  });

  it('reads out how many places pass the criteria without showing it, and lists the best ones as the core ranks them', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    expectPassing('Подходит 8 из 8');
    // No warning: the status holds the count alone.
    expect(criteriaStatus().textContent).toBe('Подходит 8 из 8');
    expectTop();
  });

  it('heads the best places with their title alone', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    const region = screen.getByRole('region', { name: 'Лучшие места' });
    const header = document.getElementById(region.getAttribute('aria-labelledby')!)!;
    expect(header.textContent).toBe('Лучшие места');
    // No caption beside it: the header of the list holds the title and nothing else.
    expect(header.parentElement!.textContent).toBe('Лучшие места');
    expect(screen.queryByText(/Соседние квадраты|общем рейтинге/)).toBeNull();
  });

  it('titles the tab with the index and heads its lists, as the other screens are titled', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    expect(screen.getByRole('heading', { level: 1, name: ix.title })).toBeTruthy();
    // Each list is a region under its heading.
    for (const name of ['Лучшие места', 'Места для шагов']) {
      const heading = screen.getByRole('heading', { level: 2, name });
      expect(heading.closest('section'), name).toBe(screen.getByRole('region', { name }));
    }
  });

  it('shows on «Критерии» how many criteria count, out of the name of the button', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    // Every criterion of the snapshot counts by default.
    const toggle = screen.getByRole('button', { name: 'Критерии', description: `${ix.criteria.length} включено` });
    expect(toggle.textContent).toContain(`${ix.criteria.length} включено`);

    await openCriteria();
    await choose('Метро', importanceLabel('demand', 'off'));
    expect(screen.getByRole('button', { name: 'Критерии', description: `${ix.criteria.length - 1} включено` })).toBe(toggle);
  });

  it("shows every criterion on one row: title, reach and level; the description is the select's accessible description", async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    const toggle = screen.getByRole('button', { name: 'Критерии' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();

    await openCriteria();
    expect(screen.getByRole('button', { name: 'Критерии' }).getAttribute('aria-expanded')).toBe('true');
    for (const criterion of ix.criteria) {
      // Named by the title alone: the reach stands next to the label, not in it.
      const select = screen.getByRole('combobox', { name: criterion.title }) as HTMLSelectElement;
      expect(select.value, criterion.id).toBe(criterion.defaultImportance);
      expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(
        IMPORTANCE.map((level) => importanceLabel(criterion.role, level)),
      );
      const row = select.closest<HTMLElement>('.criterion')!;
      expect(within(row).getByText(criterion.title).tagName, criterion.id).toBe('LABEL');
      const reach = within(row).getByText(text(criterionReach(criterion)));
      expect(reach.closest('label, [hidden]'), criterion.id).toBeNull();

      // The long description is read out with the select, and only with it: the element it comes from is hidden, so
      // a screen reader moving on from the select does not read it a second time, and nobody sees it.
      const description = describeCriterion(criterion);
      expect(screen.getByRole('combobox', { name: criterion.title, description: named(description) }), criterion.id).toBe(select);
      const about = document.getElementById(select.getAttribute('aria-describedby')!)!;
      expect(about.hidden, criterion.id).toBe(true);
      for (const shown of screen.getAllByText(text(description))) expect(shown.closest('[hidden]'), criterion.id).toBe(about);
    }
  });

  it('says once which levels filter places out, inside the list', async () => {
    const hint = '«Обязательно» и «Исключать» отсеивают неподходящие места.';
    renderApp({ api: mapApi() });
    await openMapTab();
    const list = document.getElementById(screen.getByRole('button', { name: 'Критерии' }).getAttribute('aria-controls')!)!;
    // Collapsed, the hint is hidden with the list.
    expect(screen.getByText(hint).closest('[hidden]')).toBe(list);

    await openCriteria();
    const shown = screen.getAllByText(hint);
    expect(shown).toHaveLength(1);
    expect(list.contains(shown[0]!)).toBe(true);
    expect(shown[0]!.closest('[hidden]')).toBeNull();
    // At the top of the list, before the first criterion.
    expect(shown[0]!.compareDocumentPosition(list.querySelector('.criterion')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names only «Обязательно» in the hint when the pack has no penalties', async () => {
    const demandOnly = structuredClone(ix) as LocationIndex;
    demandOnly.criteria = demandOnly.criteria.filter((criterion) => criterion.role === 'demand');
    for (const criterion of ix.criteria) {
      if (criterion.role !== 'penalty') continue;
      delete demandOnly.cells.level[criterion.id];
      delete demandOnly.cells.fact[criterion.id];
    }
    renderApp({ api: mapApi({ getLocationIndex: vi.fn(async (): Promise<unknown> => demandOnly) }) });
    await openMapTab();
    await openCriteria();
    expect(screen.getAllByRole('combobox')).toHaveLength(demandOnly.criteria.length);
    expect(screen.getByText('«Обязательно» отсеивает неподходящие места.')).toBeTruthy();
  });

  it('rescores the places when the importance of a criterion changes', async () => {
    const settings = { metro: 'off' } as const;
    expect(scoreLocations(ix, settings).top.map((place) => place.cell)).not.toEqual(scoreLocations(ix).top.map((place) => place.cell));
    renderApp({ api: mapApi() });
    await openMapTab();
    await openCriteria();

    await choose('Метро', 'Не учитывать');
    expectTop(settings);
  });

  it('drops the places that fail a required criterion', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    await openCriteria();
    await choose('Метро', 'Обязательно');
    expectPassing('Подходит 4 из 8');
    expectTop({ metro: 'required' });
  });

  it('asks for a demand criterion when all of them are off', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    await openCriteria();
    await choose('Метро', 'Не учитывать');
    await choose('Офисы и бизнес-центры', 'Не учитывать');
    expect(screen.getByText('Включите хотя бы один критерий спроса — без него индекс не считается')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Лучшие места' })).toBeNull();
  });

  it('asks to relax the criteria when no place passes them', async () => {
    const noMetro = structuredClone(ix) as LocationIndex;
    noMetro.cells.level.metro = noMetro.cells.level.metro!.map(() => 0);
    renderApp({ api: mapApi({ getLocationIndex: vi.fn(async (): Promise<unknown> => noMetro) }) });
    await openMapTab();
    await openCriteria();
    await choose('Метро', 'Обязательно');
    expectPassing('Подходит 0 из 8');
    // The warning is shown, and read out with the count: it is in the same status.
    const warning = screen.getByText('Ни одно место не проходит отбор. Ослабьте условия «Обязательно» или «Исключать»');
    expect(warning.closest('[role="status"]')).toBe(criteriaStatus());
    expect(warning.closest('.visually-hidden')).toBeNull();
  });

  it('restores the defaults with «Сбросить»', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    await openCriteria();
    await choose('Метро', 'Обязательно');
    expect(localStorage.getItem(SETTINGS_KEY)).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Сбросить' }));
    expect((screen.getByRole('combobox', { name: 'Метро' }) as HTMLSelectElement).value).toBe('high');
    expectPassing('Подходит 8 из 8');
    expectTop();
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
    // «Сбросить» turns itself off: the focus goes to the section rather than nowhere.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Критерии' }));
  });
});

describe('cell card', () => {
  it('explains a place with the facts of the core and sends location_cell_opened', async () => {
    const api = mapApi();
    renderApp({ api });
    await openMapTab();
    const result = scoreLocations(ix);
    const explanation = explainCell(ix, result, result.top[0]!.cell);

    await userEvent.click(topRows()[0]!);
    const card = screen.getByRole('region', { name: named(explanation.title) });
    expect(within(card).getByText(text(explanation.summary))).toBeTruthy();
    for (const factor of explanation.factors) expect(within(card).getByText(text(factor.fact)), factor.id).toBeTruthy();
    expect(within(card).getByText(text(explanation.competition!.text))).toBeTruthy();
    // The card ends with its facts: no line of the source, no label of the data.
    expect(card.textContent).not.toContain(explanation.source);
    expect(within(card).queryByText(/Подготовленные данные/)).toBeNull();
    expect(sent(api, 'location_cell_opened')).toEqual([['location_cell_opened', { cell: explanation.cell, version: ix.version, from: 'list' }]]);
  });

  it('counts a card once: a tap on the place already open only brings its card back into view', async () => {
    const api = mapApi();
    renderApp({ api });
    await openMapTab();
    await userEvent.click(topRows()[0]!);
    const result = scoreLocations(ix);
    const card = screen.getByRole('region', { name: named(explainCell(ix, result, result.top[0]!.cell).title) });
    await waitFor(() => expect(document.activeElement).toBe(card));

    await userEvent.click(topRows()[0]!);
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(sent(api, 'location_cell_opened')).toHaveLength(1);
  });

  it('takes the focus when it opens and gives it back when it closes', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    renderApp({ api: mapApi() });
    await openMapTab();
    const row = topRows()[1]!;
    await userEvent.click(row);
    const result = scoreLocations(ix);
    const card = screen.getByRole('region', { name: named(explainCell(ix, result, result.top[1]!.cell).title) });
    await waitFor(() => expect(document.activeElement).toBe(card));
    // A card may be taller than the screen: its top comes into view (below the section switch), not its middle. With
    // the map on screen the map comes into view instead, with the card under it (map-canvas.test.tsx).
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(card);
    expect(scrollIntoView.mock.lastCall).toEqual([{ block: 'start' }]);

    // Tapped again, the open card only comes back into view by the focus, as it always did.
    scrollIntoView.mockClear();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    await userEvent.click(topRows()[1]!);
    expect(focus.mock.contexts.at(-1)).toBe(card);
    expect(focus.mock.lastCall).toEqual([]);
    expect(scrollIntoView).not.toHaveBeenCalled();

    await userEvent.click(within(card).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('region', { name: named(explainCell(ix, result, result.top[1]!.cell).title) })).toBeNull();
    expect(document.activeElement).toBe(topRows()[1]);
  });

  it('scales the bars to the most a criterion can add, prints a minus as a minus and says what the numbers are', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    const result = scoreLocations(ix);
    const explanation = explainCell(ix, result, result.top[2]!.cell);
    await userEvent.click(topRows()[2]!);
    const card = screen.getByRole('region', { name: named(explanation.title) });
    const factor = (id: string) => within(card).getByText(text(explanation.factors.find((f) => f.id === id)!.fact)).closest('li')!;

    // Metro and offices are «Высокая» (weight 3 of 6): one criterion adds at most 100 · 3 / 6 = 50 points.
    expect(explanation.factors.find((f) => f.id === 'office')!.points).toBe(10);
    expect(within(factor('office')).getByText('+10')).toBeTruthy();
    expect((factor('office').querySelector('.factor__fill') as HTMLElement).style.width).toBe('20%');
    expect(within(factor('industrial')).getByText(`${String.fromCodePoint(0x2212)}3`)).toBeTruthy();
    expect((factor('industrial').querySelector('.factor__fill') as HTMLElement).style.width).toBe('7%');
    expect(within(card).getByText('Числа — вклад критерия в оценку места, а не доля индекса 0–100.')).toBeTruthy();
    // The card is a part of the tab under its heading, the criteria a part of the card.
    expect(within(card).getByRole('heading', { level: 2, name: named(explanation.title) })).toBeTruthy();
    expect(within(card).getByRole('heading', { level: 3, name: 'Что влияет на индекс' })).toBeTruthy();
  });

  it('marks the criteria that are off', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    await openCriteria();
    await choose('Офисы и бизнес-центры', 'Не учитывать');
    const result = scoreLocations(ix, { office: 'off' });
    const explanation = explainCell(ix, result, result.top[0]!.cell);
    await userEvent.click(topRows()[0]!);

    const card = screen.getByRole('region', { name: named(explanation.title) });
    const office = explanation.factors.find((factor) => factor.id === 'office')!;
    const row = within(card).getByText(text(office.fact)).closest('li')!;
    expect(within(row).getByText('не учитывается')).toBeTruthy();
    const metro = within(card).getByText(text(explanation.factors.find((factor) => factor.id === 'metro')!.fact)).closest('li')!;
    expect(within(metro).queryByText('не учитывается')).toBeNull();
  });

  it('opens the step linked to the index: «Как проверить помещение»', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    await userEvent.click(topRows()[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Как проверить помещение' }));
    expect(await screen.findByText('Подберите район и посмотрите помещения.')).toBeTruthy();
  });

  it('has no «Как проверить помещение» when the linked step is not in the route', async () => {
    renderApp({ api: mapApi({}, withoutLease) });
    await openMapTab();
    await userEvent.click(topRows()[0]!);
    const result = scoreLocations(ix);
    const card = screen.getByRole('region', { name: named(explainCell(ix, result, result.top[0]!.cell).title) });
    expect(within(card).getByText(text(explainCell(ix, result, result.top[0]!.cell).summary))).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Как проверить помещение' })).toBeNull();
  });
});

describe('accessibility', () => {
  it('keeps every button to phrasing content: list rows are buttons by role, not <button> around blocks', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    await userEvent.click(topRows()[0]!);
    await userEvent.click(within(screen.getByRole('region', { name: 'Места для шагов' })).getAllByRole('button')[0]!);
    expect(document.querySelectorAll('button div, button p, button ul, button section')).toHaveLength(0);
  });

  it('opens a card from the keyboard, with Enter and with Space', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    const result = scoreLocations(ix);
    topRows()[0]!.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('region', { name: named(explainCell(ix, result, result.top[0]!.cell).title) })).toBeTruthy();
    topRows()[1]!.focus();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('region', { name: named(explainCell(ix, result, result.top[1]!.cell).title) })).toBeTruthy();
  });
});

describe('places of the route steps', () => {
  it('lists the places with their addresses and steps', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    const list = screen.getByRole('region', { name: 'Места для шагов' });
    const ifns = within(list).getByRole('button', { name: /Межрайонная ИФНС № 18/ });
    expect(within(ifns).getByText('Казань, ул. Владимира Кулагина, 1')).toBeTruthy();
    expect(within(ifns).getByText('Шаг: Зарегистрировать ИП')).toBeTruthy();
    const cgie = within(list).getByRole('button', { name: /Центр гигиены и эпидемиологии/ });
    expect(within(cgie).getByText(/^Шаги: /).textContent).toMatch(/Оформить медкнижки/);
    expect(within(cgie).getByText(/^Шаги: /).textContent).toMatch(/Утвердить производственный контроль/);
  });

  it('opens a place card with its source, steps and map links, without the check date, and sends place_opened', async () => {
    const api = mapApi();
    const bridge = renderApp({ api });
    await openMapTab();
    await userEvent.click(within(screen.getByRole('region', { name: 'Места для шагов' })).getByRole('button', { name: /Центр гигиены/ }));

    const card = screen.getByRole('region', { name: 'Центр гигиены и эпидемиологии' });
    expect(within(card).getByRole('heading', { level: 2, name: 'Центр гигиены и эпидемиологии' })).toBeTruthy();
    expect(within(card).getByText('Казань, ул. Сеченова, 13а')).toBeTruthy();
    expect(within(card).queryByText(/проверено/i)).toBeNull();
    expect(sent(api, 'place_opened')).toEqual([['place_opened', { place: 'cgie-rt', from: 'list' }]]);

    await userEvent.click(within(card).getByRole('button', { name: 'Источник: ФБУЗ «ЦГиЭ в РТ»' }));
    expect(bridge.openLink).toHaveBeenCalledWith('https://fbuz.tatarstan.ru/');
    // No OpenStreetMap object in the pack: the maps take the coordinates alone.
    await userEvent.click(within(card).getByRole('button', { name: 'Открыть в 2ГИС' }));
    expect(bridge.openLink).toHaveBeenLastCalledWith('https://2gis.ru/geo/49.170644,55.798172?m=49.170644,55.798172/18');
    await userEvent.click(within(card).getByRole('button', { name: 'Открыть в Яндекс Картах' }));
    expect(bridge.openLink).toHaveBeenLastCalledWith('https://yandex.ru/maps/?pt=49.170644,55.798172&z=17&l=map');

    await userEvent.click(within(card).getByRole('button', { name: /Оформить медкнижки/ }));
    expect(await screen.findByText('Запишитесь на осмотр.')).toBeTruthy();
  });

  it('shows the note and opens the place in 2GIS and in Yandex Maps, not in OpenStreetMap', async () => {
    const api = mapApi();
    const bridge = renderApp({ api });
    await openMapTab();
    await userEvent.click(within(screen.getByRole('region', { name: 'Места для шагов' })).getByRole('button', { name: /Межрайонная ИФНС/ }));

    const card = screen.getByRole('region', { name: 'Межрайонная ИФНС № 18' });
    expect(within(card).getByText('Регистрирующая инспекция.')).toBeTruthy();
    expect(within(card).getAllByRole('button', { name: /Открыть шаг/ })).toHaveLength(1);
    // Under the source, in this order; the OpenStreetMap object of the pack is not linked.
    const links = within(card).getAllByRole('button', { name: /^Источник: |^Открыть в / });
    expect(links.map((link) => link.textContent)).toEqual(['Источник: ФНС России — МРИ № 18', 'Открыть в 2ГИС', 'Открыть в Яндекс Картах']);
    expect(within(card).queryByRole('button', { name: /OpenStreetMap/ })).toBeNull();

    // The pin at the point, longitude first; opening a map is no event.
    const events = vi.mocked(api.sendEvent).mock.calls.length;
    await userEvent.click(within(card).getByRole('button', { name: 'Открыть в 2ГИС' }));
    expect(bridge.openLink).toHaveBeenLastCalledWith('https://2gis.ru/geo/49.142156,55.74213?m=49.142156,55.74213/18');
    await userEvent.click(within(card).getByRole('button', { name: 'Открыть в Яндекс Картах' }));
    expect(bridge.openLink).toHaveBeenLastCalledWith('https://yandex.ru/maps/?pt=49.142156,55.74213&z=17&l=map');
    expect(bridge.openLink).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.sendEvent).mock.calls).toHaveLength(events);

    await userEvent.click(within(card).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('region', { name: 'Межрайонная ИФНС № 18' })).toBeNull();
  });
});

describe('task card and the map', () => {
  it('shows where a step is done and opens that place on the map; «Назад» returns to the card', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const api = mapApi();
    const bridge = renderApp({ api, startParam: 'register-business' });
    expect(await screen.findByText('Где')).toBeTruthy();
    expect(screen.getByText('Межрайонная ИФНС № 18')).toBeTruthy();
    expect(screen.getByText('Казань, ул. Владимира Кулагина, 1')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Показать на карте' }));
    const card = await screen.findByRole('region', { name: 'Межрайонная ИФНС № 18' });
    expect(within(card).getByText('Регистрирующая инспекция.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(card));
    // No map: the card itself comes into view.
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(card);
    expect(sections()).toBeNull();
    expect(sent(api, 'map_opened')).toEqual([['map_opened', { source: 'task' }]]);
    expect(sent(api, 'place_opened')).toEqual([['place_opened', { place: 'ifns-18', from: 'list' }]]);

    // Nothing on this screen opened the card: closing it puts the focus on the row of the place.
    await userEvent.click(within(card).getByRole('button', { name: 'Закрыть' }));
    expect(document.activeElement).toBe(within(screen.getByRole('region', { name: 'Места для шагов' })).getByRole('button', { name: /Межрайонная ИФНС № 18/ }));
    await userEvent.click(within(screen.getByRole('region', { name: 'Места для шагов' })).getByRole('button', { name: /Межрайонная ИФНС № 18/ }));

    expect(bridge.back).toBeTypeOf('function');
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findByText('Без регистрации нельзя работать.')).toBeTruthy();
  });

  it('offers «Подобрать район на карте» on the steps linked to the index: the map opens on the best places', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const api = mapApi();
    renderApp({ api, startParam: 'lease-premises' });
    await userEvent.click(await screen.findByRole('button', { name: 'Подобрать район на карте' }));

    expect(await screen.findByText(ix.title)).toBeTruthy();
    // Under «Назад» the index titles the screen, as on the tab.
    expect(screen.getByRole('heading', { level: 1, name: ix.title })).toBeTruthy();
    // Ten open criteria would push the places below the fold: they stay one tap away, the best places come into view.
    expect(screen.getByRole('button', { name: 'Критерии' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('combobox')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Лучшие места' })));
    // No map: the best places themselves come into view.
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(screen.getByRole('region', { name: 'Лучшие места' }));
    expectTop();
    expect(sent(api, 'map_opened')).toEqual([['map_opened', { source: 'task' }]]);

    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findByText('Подберите район и посмотрите помещения.')).toBeTruthy();
  });

  it('goes back instead of opening again the step the map was opened from', async () => {
    renderApp({ api: mapApi(), startParam: 'lease-premises' });
    await userEvent.click(await screen.findByRole('button', { name: 'Подобрать район на карте' }));
    await screen.findByText(ix.title);
    await userEvent.click(topRows()[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Как проверить помещение' }));
    expect(await screen.findByText('Подберите район и посмотрите помещения.')).toBeTruthy();
    // It is the card the map came from: «Назад» leads on to the route, not back to the map.
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findByText('Следующий шаг')).toBeTruthy();
  });

  it('goes back to the step a place was shown from, rather than opening it again', async () => {
    renderApp({ api: mapApi(), startParam: 'register-business' });
    await userEvent.click(await screen.findByRole('button', { name: 'Показать на карте' }));
    const card = await screen.findByRole('region', { name: 'Межрайонная ИФНС № 18' });
    await userEvent.click(within(card).getByRole('button', { name: /Зарегистрировать ИП/ }));
    expect(await screen.findByText('Без регистрации нельзя работать.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findByText('Следующий шаг')).toBeTruthy();
  });

  it('reports a place opened from a step only when the route has it: a place the map cannot show is not opened', async () => {
    const api = mapApi();
    const { getRoute } = api;
    api.getRoute = vi.fn(async () => ({ ...(await getRoute()), places: [] }));
    renderApp({ api, startParam: 'register-business' });
    await userEvent.click(await screen.findByRole('button', { name: 'Показать на карте' }));
    await screen.findByText(ix.title);
    expect(sent(api, 'map_opened')).toEqual([['map_opened', { source: 'task' }]]);
    expect(sent(api, 'place_opened')).toEqual([]);
  });

  it('leads a step that is gone to the route, even when the map opened it: «К маршруту» says where it goes', async () => {
    const api = mapApi();
    const { getTask } = api;
    api.getTask = vi.fn(async (id: string) => (id === 'medical-books' ? Promise.reject(new ApiError(404, 'task_not_found', 'Нет такого шага')) : getTask(id)));
    renderApp({ api });
    await openMapTab();
    await userEvent.click(within(screen.getByRole('region', { name: 'Места для шагов' })).getByRole('button', { name: /Центр гигиены/ }));
    await userEvent.click(within(screen.getByRole('region', { name: 'Центр гигиены и эпидемиологии' })).getByRole('button', { name: /Оформить медкнижки/ }));
    expect(await screen.findByText('Такого шага нет')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'К маршруту' }));
    expect(await screen.findByText('Следующий шаг')).toBeTruthy();
    expect(section('Маршрут').getAttribute('aria-current')).toBe('page');
  });

  it('offers «Показать на карте» only when the route has loaded: the map needs it', async () => {
    const api = mapApi({ getRoute: vi.fn(async () => Promise.reject(new ApiError(0, 'network', 'Нет связи с сервером.'))) });
    renderApp({ api, startParam: 'register-business' });
    expect(await screen.findByText('Где')).toBeTruthy();
    expect(screen.getByText('Межрайонная ИФНС № 18')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Показать на карте' })).toBeNull();
  });

  it('offers no «Подобрать район на карте» on other steps', async () => {
    const api = mapApi();
    renderApp({ api, startParam: 'register-business' });
    await screen.findByText('Где');
    await configApplied(api);
    // The route is there too: «Показать на карте» needs it.
    expect(screen.getByRole('button', { name: 'Показать на карте' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Подобрать район на карте' })).toBeNull();
  });
});

describe('criteria settings', () => {
  it('fixture: the top list with a required metro differs from the default one, so it tells the settings apart', () => {
    expect(scoreLocations(ix, { metro: 'required' }).top.map((place) => place.cell)).not.toEqual(scoreLocations(ix).top.map((place) => place.cell));
  });

  it('are kept per snapshot and restored at the next opening', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    await openCriteria();
    await choose('Метро', 'Обязательно');
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toEqual({ metro: 'required' });
    cleanup();

    renderApp({ api: mapApi() });
    await openMapTab();
    expectPassing('Подходит 4 из 8');
    expectTop({ metro: 'required' });
    await openCriteria();
    expect((screen.getByRole('combobox', { name: 'Метро' }) as HTMLSelectElement).value).toBe('required');
  });

  it('survive a data refresh with the same methodology: the key is the config hash, not the version', async () => {
    renderApp({ api: mapApi() });
    await openMapTab();
    await openCriteria();
    await choose('Метро', 'Обязательно');
    cleanup();

    const refreshed = structuredClone(ix) as LocationIndex;
    refreshed.source.osmBase = '2026-10-01T10:00:00Z';
    refreshed.version = `20261001T100000Z-${ix.source.configSha256.slice(0, 8)}`;
    renderApp({ api: mapApi({ getLocationIndex: vi.fn(async (): Promise<unknown> => refreshed) }) });
    await openMapTab();
    expectPassing('Подходит 4 из 8');
    expectTop({ metro: 'required' });
    await openCriteria();
    expect((screen.getByRole('combobox', { name: 'Метро' }) as HTMLSelectElement).value).toBe('required');
  });

  it('fall back to the defaults when the stored value is unreadable', async () => {
    for (const stored of ['{not json', '["required"]', JSON.stringify({ metro: 'sometimes', office: 3 })]) {
      localStorage.setItem(SETTINGS_KEY, stored);
      renderApp({ api: mapApi() });
      await openMapTab();
      expectPassing('Подходит 8 из 8', stored);
      expectTop();
      cleanup();
    }
  });

  function denyStorage() {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(denied);
  }

  it('work when local storage fails', async () => {
    denyStorage();
    renderApp({ api: mapApi() });
    await openMapTab();
    await openCriteria();
    await choose('Метро', 'Обязательно');
    expectPassing('Подходит 4 из 8');
    expectTop({ metro: 'required' });
    await userEvent.click(screen.getByRole('button', { name: 'Сбросить' }));
    expectPassing('Подходит 8 из 8');
    expectTop();
  });

  it('outlive a step opened from the map when local storage fails', async () => {
    denyStorage();
    renderApp({ api: mapApi() });
    await openMapTab();
    await openCriteria();
    await choose('Метро', 'Обязательно');
    await userEvent.click(topRows()[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Как проверить помещение' }));
    await screen.findByText('Подберите район и посмотрите помещения.');

    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await waitFor(() => expectPassing('Подходит 4 из 8'));
    expectTop({ metro: 'required' });
    expect((screen.getByRole('combobox', { name: 'Метро' }) as HTMLSelectElement).value).toBe('required');
  });
});

describe('when the location index fails', () => {
  it('keeps the places and offers to retry after a network error', async () => {
    const getLocationIndex = vi
      .fn(async (): Promise<unknown> => ix)
      .mockRejectedValueOnce(new ApiError(0, 'network', 'Нет связи с сервером. Проверьте интернет.'));
    const api = mapApi({ getLocationIndex });
    renderApp({ api });
    await userEvent.click(await findSection('Карта'));

    expect(await screen.findByText(/Нет связи с сервером/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Места для шагов' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText(ix.title)).toBeTruthy();
    expect(getLocationIndex).toHaveBeenCalledTimes(2);
    expect(indexFailures(api)).toEqual([['map_failed', { kind: 'network' }]]);
  });

  it('tries the index again when the map is opened again, and keeps a loaded one', async () => {
    const getLocationIndex = vi
      .fn(async (): Promise<unknown> => ix)
      .mockRejectedValueOnce(new ApiError(0, 'network', 'Нет связи с сервером. Проверьте интернет.'));
    renderApp({ api: mapApi({ getLocationIndex }) });
    await userEvent.click(await findSection('Карта'));
    expect(await screen.findByText(/Нет связи с сервером/)).toBeTruthy();

    await userEvent.click(section('Маршрут'));
    await userEvent.click(await findSection('Карта'));
    expect(await screen.findByText(ix.title)).toBeTruthy();
    await userEvent.click(section('Маршрут'));
    await userEvent.click(await findSection('Карта'));
    expect(await screen.findByText(ix.title)).toBeTruthy();
    expect(getLocationIndex).toHaveBeenCalledTimes(2);
  });

  it('ends a load the server does not finish in the error state, and tries again at the next opening', async () => {
    const timeout = new ApiError(0, 'timeout', 'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.');
    const getLocationIndex = vi.fn(async (): Promise<unknown> => ix).mockRejectedValueOnce(timeout);
    const api = mapApi({ getLocationIndex });
    renderApp({ api });
    await userEvent.click(await findSection('Карта'));
    expect(await screen.findByText('Не удалось загрузить индекс мест. Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();

    await userEvent.click(section('Маршрут'));
    await userEvent.click(await findSection('Карта'));
    expect(await screen.findByText(ix.title)).toBeTruthy();
    expect(getLocationIndex).toHaveBeenCalledTimes(2);
    expect(indexFailures(api)).toEqual([['map_failed', { kind: 'timeout' }]]);
  });

  it('explains a failure that is not an API error', async () => {
    const getLocationIndex = vi.fn(async (): Promise<unknown> => ix).mockRejectedValueOnce('socket hang up');
    renderApp({ api: mapApi({ getLocationIndex }) });
    await userEvent.click(await findSection('Карта'));
    // Not an answer of the API, so no message written for users: the notice gives its own advice.
    expect(await screen.findByText('Не удалось загрузить индекс мест. Проверьте интернет и попробуйте ещё раз.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();
  });

  it('calls the index unavailable when the server has none for the pack', async () => {
    const api = mapApi({
      getLocationIndex: vi.fn(async (): Promise<unknown> => {
        throw new ApiError(404, 'location_index_not_found', 'Для этого пакета нет индекса мест.');
      }),
    });
    renderApp({ api });
    await userEvent.click(await findSection('Карта'));
    expect(await screen.findByText('Индекс мест сейчас недоступен — попробуйте позже.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Места для шагов' })).toBeTruthy();
    // The places title the tab.
    expect(screen.getByRole('heading', { level: 1, name: 'Места для шагов маршрута' })).toBeTruthy();
    // No index for the pack is an answer, not a failure.
    expect(indexFailures(api)).toEqual([]);
  });

  it('keeps a heading on the tab when the index fails and the route has no places', async () => {
    const getLocationIndex = vi.fn(async (): Promise<unknown> => {
      throw new ApiError(0, 'network', 'Нет связи с сервером. Проверьте интернет.');
    });
    renderApp({ api: mapApi({ getLocationIndex }, withoutPlaces) });
    await userEvent.click(await findSection('Карта'));
    expect(await screen.findByText(/Не удалось загрузить индекс мест/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Индекс мест' })).toBeTruthy();
  });

  it('calls an invalid snapshot unavailable', async () => {
    for (const payload of [{ ...ix, format: 'otkryvay.location-index/0' }, null, 'not a snapshot']) {
      const api = mapApi({ getLocationIndex: vi.fn(async (): Promise<unknown> => payload) });
      renderApp({ api });
      await userEvent.click(await findSection('Карта'));
      expect(await screen.findByText('Индекс мест сейчас недоступен — попробуйте позже.'), String(payload)).toBeTruthy();
      expect(screen.getByRole('region', { name: 'Места для шагов' })).toBeTruthy();
      expect(indexFailures(api)).toEqual([['map_failed', { kind: 'invalid_snapshot' }]]);
      cleanup();
    }
  });
});

describe('when the map itself fails', () => {
  it('gives way to the route after one remount, and never reloads the app', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports the error the boundary caught
    const api = fakeApi(pack, profile);
    const { getRoute } = api;
    // A place without its steps: the list cannot be drawn, and nothing but the map may break.
    api.getRoute = vi.fn(async () => {
      const route = await getRoute();
      return { ...route, places: route.places.map((place) => ({ ...place, actions: undefined as never })) };
    });
    const bridge = renderApp({ api });
    await userEvent.click(await findSection('Карта'));
    expect(await screen.findByText('Карта не открылась')).toBeTruthy();
    expect(screen.getByText('Маршрут работает как обычно — карту можно открыть позже.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'К маршруту' }));
    expect(await screen.findByText('Следующий шаг')).toBeTruthy();
    expect(bridge.reload).not.toHaveBeenCalled();
  });
});

describe('an API older than the map', () => {
  it('works without places in the route and the task card', async () => {
    const api = fakeApi(pack, profile);
    const { getRoute, getTask } = api;
    api.getRoute = vi.fn(async () => {
      const { places: _, ...route } = await getRoute();
      return route as RouteView;
    });
    api.getTask = vi.fn(async (id: string) => {
      const { places: _, ...task } = await getTask(id);
      return task as TaskDetail;
    });
    renderApp({ api });
    await screen.findByText('Следующий шаг');
    expect(sections()).toBeNull();

    await userEvent.click(screen.getAllByText('Зарегистрировать ИП')[0]!);
    expect(await screen.findByText('Без регистрации нельзя работать.')).toBeTruthy();
    expect(screen.queryByText('Где')).toBeNull();
  });
});

describe('back from a step opened on the map', () => {
  it('returns to the same map: the chosen place, the settings, the open criteria and the scroll', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const api = mapApi();
    renderApp({ api });
    await openMapTab();
    await openCriteria();
    await choose('Метро', 'Не учитывать');
    const result = scoreLocations(ix, { metro: 'off' });
    const title = explainCell(ix, result, result.top[0]!.cell).title;
    await userEvent.click(topRows()[0]!);
    Object.defineProperty(window, 'scrollY', { value: 700, configurable: true });

    await userEvent.click(screen.getByRole('button', { name: 'Как проверить помещение' }));
    expect(await screen.findByText('Подберите район и посмотрите помещения.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));

    const restored = await screen.findByRole('region', { name: named(title) });
    expect((screen.getByRole('combobox', { name: 'Метро' }) as HTMLSelectElement).value).toBe('off');
    expectTop({ metro: 'off' });
    expect(scrollTo).toHaveBeenLastCalledWith(0, 700);
    const mapTab = section('Карта');
    expect(mapTab.getAttribute('aria-current')).toBe('page');
    // Only a tab switch moves the focus to the tabs: focusing them here would scroll the page back to the top.
    expect(document.activeElement).not.toBe(mapTab);
    expect(sent(api, 'map_opened')).toHaveLength(1);
    expect(sent(api, 'location_cell_opened')).toHaveLength(1);

    // The card came back with the screen, so no tap opened it here: closing it puts the focus on its row.
    await userEvent.click(within(restored).getByRole('button', { name: 'Закрыть' }));
    expect(document.activeElement).toBe(topRows()[0]);
  });
});

describe('MapScreen focus', () => {
  async function renderMap(focus: MapFocus, index: IndexState = { status: 'ready', ix }) {
    const api = fakeApi(pack, profile);
    const route = await api.getRoute();
    const map = (load: IndexState) => (
      <MaxUI>
        <MapScreen
          route={route}
          index={load}
          onRetryIndex={() => {}}
          focus={focus}
          savedUi={undefined}
          onUiChange={() => {}}
          savedCamera={undefined}
          onCameraChange={() => {}}
          settingsMemory={new Map()}
          canvasMemory={{ webgl: false, failed: 'webgl', retryable: false, retried: false }}
          api={api}
          bridge={fakeBridge()}
          tabs={undefined}
          onBack={undefined}
          onOpenTask={() => {}}
        />
      </MaxUI>
    );
    const { rerender } = render(map(index));
    return { api, update: (load: IndexState) => rerender(map(load)) };
  }

  it('opens the card of a cell', async () => {
    await renderMap({ kind: 'cell', cell: 3 });
    const explanation = explainCell(ix, scoreLocations(ix), 3);
    const card = await screen.findByRole('region', { name: named(explanation.title) });
    expect(within(card).getByText(text(explanation.summary))).toBeTruthy();
  });

  it('ignores a cell the snapshot does not have', async () => {
    await renderMap({ kind: 'cell', cell: ix.cells.row.length });
    await screen.findByText(ix.title);
    expect(screen.queryByRole('button', { name: 'Закрыть' })).toBeNull();
    expectTop();
  });

  it('opens the place a step asked for before the index arrives, and keeps the focus on its card', async () => {
    const { update } = await renderMap({ kind: 'place', id: 'ifns-18' }, { status: 'loading' });
    const card = screen.getByRole('region', { name: 'Межрайонная ИФНС № 18' });
    expect(screen.getByText('Загружаем индекс мест…')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(card));

    update({ status: 'ready', ix });
    expect(await screen.findByText(ix.title)).toBeTruthy();
    // The same card, still focused: the index takes its places around it, and the map slot stays mounted too.
    expect(screen.getByRole('region', { name: 'Межрайонная ИФНС № 18' })).toBe(card);
    expect(document.activeElement).toBe(card);
  });

  it('keeps the map slot mounted when the index arrives', async () => {
    const { update } = await renderMap({ kind: 'index' }, { status: 'loading' });
    const slot = screen.getByTestId('map-slot');
    update({ status: 'ready', ix });
    await screen.findByText(ix.title);
    expect(screen.getByTestId('map-slot')).toBe(slot);
  });
});
