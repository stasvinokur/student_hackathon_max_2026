import { explainCell, RulesPackSchema, scoreLocations, type Profile } from '@otkryvay/core';
import { tinyLocationIndex } from '@otkryvay/core/testing';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ApiClient, AppConfig } from './api.js';
import { App } from './App.js';
import { MAP_THEMES } from './screens/map/mapLayers.js';
import { WIDE_QUERY } from './screens/map/wide.js';
import { createMapView, hasWebGL, mapViews, resetMapViews } from './test-map-view.js';
import { fakeApi, fakeBridge, renderApp } from './test-utils.js';
import { ThemeProvider } from './theme.js';

// The map canvas above the lists, with a stand-in for MapLibre (jsdom has no WebGL): what the screen asks of the map,
// what a tap on the map does to the screen, and the lists that stand in for a map that cannot be shown.

vi.mock('./screens/map/mapView.js', () => import('./test-map-view.js'));

const ix = tinyLocationIndex;
const source = { url: 'https://www.nalog.gov.ru/', title: '129-ФЗ, ст. 8', checked_at: '2026-09-18' };
const pack = RulesPackSchema.parse({
  manifest: {
    id: ix.pack, version: '1.1.0', title: 'Кофейня, Казань', industry: 'coffee', checked_at: '2026-09-18', cities: ['kazan'],
    region: { code: 'kazan', name: 'Казань' },
  },
  places: [
    {
      id: 'ifns-18', name: 'Межрайонная ИФНС № 18', short_name: 'ИФНС № 18', address: 'Казань, ул. Владимира Кулагина, 1', lat: 55.74213,
      lon: 49.142156, source: { url: 'https://www.nalog.gov.ru/rn16/ifns/16_mri18/', title: 'ФНС России — МРИ № 18', checked_at: '2026-09-23' },
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
      id: 'production-control', title: 'Утвердить производственный контроль', lane: 'ops', duration_days: 5, why: 'Без программы нельзя открыться.',
      do_now: 'Закажите программу.', done_when: 'Программа утверждена.', places: ['cgie-rt'], kind: 'test_data',
    },
  ],
});
const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 1, sells_food: false, opening_date: '2026-11-01' };
const withIndex: AppConfig = { features: { explain: false, locationIndex: [{ pack: ix.pack, version: ix.version, actions: ['lease-premises'] }] } };

function mapApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return fakeApi(pack, profile, { getConfig: vi.fn(async () => withIndex), getLocationIndex: vi.fn(async (): Promise<unknown> => ix), ...overrides });
}

/** An accessible name matcher that ignores the kind of spaces (the core writes no-break spaces). */
const named = (value: string) => (name: string) => name.replace(/\s+/g, ' ') === value.replace(/\s+/g, ' ');
const sent = (api: ApiClient, type: string) => vi.mocked(api.sendEvent).mock.calls.filter(([event]) => event === type);
const section = (name: 'Маршрут' | 'Карта') => within(screen.getByRole('navigation', { name: 'Разделы' })).getByRole('button', { name });
const topRows = () => within(screen.getByRole('region', { name: 'Лучшие места' })).getAllByRole('button');
const placeRow = (name: RegExp) => within(screen.getByRole('region', { name: 'Места для шагов' })).getByRole('button', { name });
const cellCard = (cell: number, settings = {}) => screen.queryByRole('region', { name: named(explainCell(ix, scoreLocations(ix, settings), cell).title) });

/** The words of an element, one space apart, leaving out the parts under `skip`: aria-hidden ones or visually hidden ones. */
function words(element: Element, skip: string): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const found: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent!.trim();
    if (text && !node.parentElement!.closest(skip)) found.push(text);
  }
  return found.join(' ');
}

/** The map the screen shows now. */
async function currentMap() {
  await waitFor(() => expect(mapViews.length).toBeGreaterThan(0));
  return mapViews.at(-1)!;
}

/** Opens the «Карта» tab and waits for the index to be on the map. */
async function openMapTab() {
  await userEvent.click(within(await screen.findByRole('navigation', { name: 'Разделы' })).getByRole('button', { name: 'Карта' }));
  await screen.findByText(ix.title);
  const map = await currentMap();
  await waitFor(() => expect(map.handle.setIndex).toHaveBeenLastCalledWith({ ix, scores: expect.any(Array) }));
  return map;
}

/** The colour scheme of the system, which the theme of the app follows until the user picks one (theme.tsx). */
function colorScheme(initial: 'light' | 'dark') {
  let dark = initial === 'dark';
  type Listener = (event: { matches: boolean }) => void;
  const listeners = new Set<Listener>();
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return query.includes('dark') && dark;
        },
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
        removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
  return {
    set(scheme: 'light' | 'dark') {
      dark = scheme === 'dark';
      act(() => listeners.forEach((listener) => listener({ matches: dark })));
    },
  };
}

/**
 * The size of the iframe, narrow (a phone, the panel of MAX beside the chat) or wide (the panel widened to the window
 * of the web client), and the colour scheme of the system, light at first. Each change is heard only by the listeners
 * of its own query, with the answer to that query: MAX UI takes the colour scheme from the event.
 */
function viewport(initial: 'narrow' | 'wide') {
  let wide = initial === 'wide';
  let dark = false;
  const answer = (query: string) => (query === WIDE_QUERY ? wide : query.includes('dark') && dark);
  type Listener = (event: { matches: boolean }) => void;
  const listeners = new Map<string, Set<Listener>>();
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return answer(query);
        },
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_type: string, listener: Listener) => {
          const heard = listeners.get(query) ?? new Set<Listener>();
          heard.add(listener);
          listeners.set(query, heard);
        },
        removeEventListener: (_type: string, listener: Listener) => {
          listeners.get(query)?.delete(listener);
        },
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
  // The wide layout asks for :has(), which jsdom does not claim to support.
  vi.spyOn(CSS, 'supports').mockImplementation((condition: string) => condition === 'selector(:has(*))');
  /** Tells the listeners of the queries that changed, each the answer to its own query. */
  const tell = (changed: (query: string) => boolean) =>
    act(() =>
      listeners.forEach((heard, query) => {
        if (changed(query)) heard.forEach((listener) => listener({ matches: answer(query) }));
      }),
    );
  return {
    set(next: 'narrow' | 'wide') {
      wide = next === 'wide';
      tell((query) => query === WIDE_QUERY);
    },
    setScheme(next: 'light' | 'dark') {
      dark = next === 'dark';
      tell((query) => query !== WIDE_QUERY && query.includes('dark'));
    },
  };
}

/** The wrapper of the header, the map and the lists, which lays them side by side on a wide screen. */
const layout = () => document.querySelector<HTMLElement>('.map-screen');

/**
 * The selectors of the rules of MapScreen.css, read from the file itself: the tests load no CSS (css: false). By its
 * path: Vite turns new URL('…', import.meta.url) into an address of its server. The split is naive, and the file stays
 * flat for it: no @media or @supports blocks, no commas inside :is() or :not(). Anything else would cut out fragments
 * that are no selectors, and querySelector() throws on them: the tests fail loudly, not quietly.
 */
function layoutSelectors(): string[] {
  const css = readFileSync(join(import.meta.dirname, 'screens/MapScreen.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return css
    .split('}')
    .flatMap((rule) => rule.split('{')[0]!.split(','))
    .map((selector) => selector.trim())
    .filter(Boolean);
}

/** The selectors of MapScreen.css that match nothing on the page: its rules that this screen does not take. */
const unmatched = () => layoutSelectors().filter((selector) => !document.querySelector(selector));

/** The names of the parts in the order of the page, which is the order of reading and of the focus. */
function pageOrder(parts: Record<string, Element>): string[] {
  const following = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  return Object.keys(parts).sort((a, b) => (following(parts[a]!, parts[b]!) ? -1 : 1));
}

/** The header of the index, the map and «Лучшие места», in the order of the page. */
const partsInOrder = () =>
  pageOrder({
    'best places': screen.getByRole('region', { name: 'Лучшие места' }),
    map: screen.getByTestId('map-slot'),
    header: screen.getByText(ix.title).closest('header')!,
  });

/**
 * Where the top of what the selector matches (an open card, «Лучшие места») is on the screen, px from its top: jsdom
 * lays nothing out, and leaves everything else at 0. set() moves it, as a scroll of the page would.
 */
function topOf(selector: string, initial: number) {
  let top = initial;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const y = this.matches(selector) ? top : 0;
    return { top: y, bottom: y, left: 0, right: 0, width: 0, height: 0, x: 0, y, toJSON: () => ({}) };
  });
  return {
    set(next: number) {
      top = next;
    },
  };
}

beforeEach(() => resetMapViews());

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the map canvas', () => {
  it('takes the light basemap for the light scheme of MAX and the dark one for the dark scheme', async () => {
    renderApp({ api: mapApi() });
    const light = await openMapTab();
    expect(light.options.theme).toBe(MAP_THEMES.light);
    expect(light.options.theme.style).toBe('https://tiles.openfreemap.org/styles/positron');
    // WebGL was asked for before the frame was drawn: the map does not ask again.
    expect(light.options.webgl).toBe(true);
    cleanup();

    colorScheme('dark');
    renderApp({ api: mapApi() });
    const dark = await openMapTab();
    expect(dark.options.theme.style).toBe('https://tiles.openfreemap.org/styles/dark');
    // The dark map has the legend of the light one: no note on the best places.
    const slot = screen.getByTestId('map-slot');
    expect(within(slot).getByText('Индекс места')).toBeTruthy();
    expect(slot.textContent).not.toMatch(/Самые|лучшие/);
  });

  it('opens anew in the other scheme, where it was left, when the scheme changes', async () => {
    const scheme = colorScheme('light');
    renderApp({ api: mapApi() });
    const light = await openMapTab();
    act(() => light.options.onCameraChange({ center: [49.105, 55.79], zoom: 14 }));

    scheme.set('dark');
    await waitFor(() => expect(mapViews).toHaveLength(2));
    const dark = mapViews[1]!;
    expect(light.handle.destroy).toHaveBeenCalledTimes(1);
    expect(dark.options.theme).toBe(MAP_THEMES.dark);
    expect(dark.options.camera).toEqual({ center: [49.105, 55.79], zoom: 14 });
    await waitFor(() => expect(dark.handle.setIndex).toHaveBeenCalledWith({ ix, scores: scoreLocations(ix).scores }));
    expect(dark.handle.setPlaces).toHaveBeenCalled();
  });

  it('opens anew in the chosen theme, where it was left', async () => {
    renderApp({ api: mapApi() });
    const light = await openMapTab();
    expect(light.options.theme).toBe(MAP_THEMES.light);
    act(() => light.options.onCameraChange({ center: [49.105, 55.79], zoom: 14 }));

    await userEvent.click(screen.getByRole('button', { name: 'Тёмная тема' }));
    await waitFor(() => expect(mapViews).toHaveLength(2));
    const dark = mapViews[1]!;
    expect(light.handle.destroy).toHaveBeenCalledTimes(1);
    expect(dark.options.theme).toBe(MAP_THEMES.dark);
    expect(dark.options.camera).toEqual({ center: [49.105, 55.79], zoom: 14 });
    expect(screen.getByTestId('map-slot').querySelector('.map-frame--dark')).toBeTruthy();
    await waitFor(() => expect(dark.handle.setIndex).toHaveBeenCalledWith({ ix, scores: scoreLocations(ix).scores }));
    expect(dark.handle.setPlaces).toHaveBeenCalled();
  });

  it('is drawn dark from the first frame, once, when the dark theme is stored on the device', async () => {
    localStorage.setItem('theme', 'dark');
    renderApp({ api: mapApi() });
    const map = await openMapTab();
    expect(map.options.theme).toBe(MAP_THEMES.dark);
    expect(createMapView).toHaveBeenCalledTimes(1);
    expect(mapViews).toHaveLength(1);
  });

  it('keeps the chosen theme when the scheme of the system changes', async () => {
    const size = viewport('narrow');
    renderApp({ api: mapApi() });
    await openMapTab();
    await userEvent.click(screen.getByRole('button', { name: 'Тёмная тема' }));
    await waitFor(() => expect(mapViews).toHaveLength(2));

    size.setScheme('dark');
    size.setScheme('light');
    expect(mapViews).toHaveLength(2);
    expect(mapViews[1]!.options.theme).toBe(MAP_THEMES.dark);
    expect(mapViews[1]!.handle.destroy).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('keeps its height with a placeholder while MapLibre loads, and explains its colours and marks', async () => {
    renderApp({ api: mapApi() });
    const map = await openMapTab();
    const slot = screen.getByTestId('map-slot');
    expect(within(slot).getByText('Загружаем карту…')).toBeTruthy();
    expect(within(slot).getByText('Индекс места')).toBeTruthy();
    // The steps are finer at the top: where each starts.
    expect([...slot.querySelectorAll('.map-legend__tick')].map((tick) => tick.textContent)).toEqual(['0', '50', '75', '90', '97']);
    // The scale is a picture: a screen reader hears what it says instead, and those words do not show.
    const scale = slot.querySelector('.map-legend__row--scale')!;
    expect(words(scale, '[aria-hidden="true"]')).toBe('Индекс места от 0 до 100, чем выше — тем лучше место');
    expect(words(scale, '.visually-hidden')).toBe('Индекс места ниже 0 50 75 90 97 выше');
    // A cell that does not pass is not coloured, like the ground without enough buildings for the index.
    expect(within(slot).getByText('Без цвета — не проходит отбор или мало застройки')).toBeTruthy();
    expect(within(slot).getByText('Места для шагов')).toBeTruthy();
    // Nothing more: no note on the best places, no line of the data (the basemap has its attribution in the «i»).
    expect(slot.textContent).not.toMatch(/Самые|лучшие/);
    expect(slot.textContent).not.toMatch(/OpenStreetMap|ODbL/);

    act(() => map.options.onReady());
    expect(within(slot).queryByText('Загружаем карту…')).toBeNull();
    expect(within(slot).getByText('Индекс места')).toBeTruthy();
  });

  it('shows the places alone, with their part of the legend, when the pack has no index', async () => {
    renderApp({ api: fakeApi(pack, profile) });
    await userEvent.click(within(await screen.findByRole('navigation', { name: 'Разделы' })).getByRole('button', { name: 'Карта' }));
    const map = await currentMap();
    await waitFor(() => expect(map.handle.setPlaces).toHaveBeenCalled());
    expect(map.handle.setPlaces.mock.lastCall![0].map((place) => place.id)).toEqual(['ifns-18', 'cgie-rt']);
    // The map labels a place by its short name, where the pack gives one; its row keeps the full name.
    expect(map.handle.setPlaces.mock.lastCall![0].map((place) => place.shortName)).toEqual(['ИФНС № 18', null]);
    expect(placeRow(/Межрайонная ИФНС № 18/)).toBeTruthy();
    expect(map.handle.setIndex).toHaveBeenLastCalledWith(null);
    const slot = screen.getByTestId('map-slot');
    expect(within(slot).getByText('Места для шагов')).toBeTruthy();
    expect(within(slot).queryByText('Индекс места')).toBeNull();
  });

  it('recolours the grid when the settings change, and only then: opening a card or the criteria redraws nothing', async () => {
    renderApp({ api: mapApi() });
    const map = await openMapTab();
    const pushed = () => map.handle.setIndex.mock.calls.length;
    const before = pushed();

    await userEvent.click(topRows()[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Критерии' }));
    expect(pushed()).toBe(before);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Метро' }), 'Обязательно');
    expect(pushed()).toBe(before + 1);
    expect(map.handle.setIndex).toHaveBeenLastCalledWith({ ix, scores: scoreLocations(ix, { metro: 'required' }).scores });
    // The legend stays as it was: its scale does not depend on the settings, and it tells no share of the best places.
    expect(screen.getByTestId('map-slot').textContent).not.toMatch(/Самые|лучшие/);
    // One map all along.
    expect(createMapView).toHaveBeenCalledTimes(1);
  });

  it('flies to a card opened from a list and marks it, at every tap on a row', async () => {
    const api = mapApi();
    renderApp({ api });
    const map = await openMapTab();
    const top = scoreLocations(ix).top;

    await userEvent.click(topRows()[1]!);
    expect(map.handle.flyTo).toHaveBeenLastCalledWith({ kind: 'cell', cell: top[1]!.cell });
    expect(map.handle.select).toHaveBeenLastCalledWith({ kind: 'cell', cell: top[1]!.cell });

    await userEvent.click(placeRow(/Центр гигиены/));
    expect(map.handle.flyTo).toHaveBeenLastCalledWith({ kind: 'place', id: 'cgie-rt' });
    expect(map.handle.select).toHaveBeenLastCalledWith({ kind: 'place', id: 'cgie-rt' });

    // The card is open already: the map shows it again (it may have been moved away); the card is not counted again.
    await userEvent.click(placeRow(/Центр гигиены/));
    expect(map.handle.flyTo).toHaveBeenCalledTimes(3);
    expect(sent(api, 'place_opened')).toEqual([['place_opened', { place: 'cgie-rt', from: 'list' }]]);
    expect(sent(api, 'location_cell_opened')).toEqual([['location_cell_opened', { cell: top[1]!.cell, version: ix.version, from: 'list' }]]);

    await userEvent.click(within(screen.getByRole('region', { name: 'Центр гигиены и эпидемиологии' })).getByRole('button', { name: 'Закрыть' }));
    expect(map.handle.select).toHaveBeenLastCalledWith(null);
  });

  it('opens the card of a tapped cell or place without moving the page or the focus, and counts it once', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const api = mapApi();
    renderApp({ api });
    const map = await openMapTab();
    // The canvas of MapLibre is focusable: a tap focuses it.
    map.container.tabIndex = 0;
    map.container.focus();
    scrollIntoView.mockClear();

    act(() => map.options.onCellClick(3));
    const card = cellCard(3)!;
    expect(card).toBeTruthy();
    expect(document.activeElement).toBe(map.container);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(sent(api, 'location_cell_opened')).toEqual([['location_cell_opened', { cell: 3, version: ix.version, from: 'map' }]]);
    expect(map.handle.select).toHaveBeenLastCalledWith({ kind: 'cell', cell: 3 });
    // The map is where the finger is: it does not fly.
    expect(map.handle.flyTo).not.toHaveBeenCalled();

    // Tapped again, the open cell changes nothing.
    act(() => map.options.onCellClick(3));
    expect(sent(api, 'location_cell_opened')).toHaveLength(1);
    expect(document.activeElement).toBe(map.container);

    act(() => map.options.onPlaceClick('ifns-18'));
    expect(screen.getByRole('region', { name: 'Межрайонная ИФНС № 18' })).toBeTruthy();
    expect(cellCard(3)).toBeNull();
    expect(sent(api, 'place_opened')).toEqual([['place_opened', { place: 'ifns-18', from: 'map' }]]);
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Closing it gives the focus back to the map, and the page does not jump to the list.
    await userEvent.click(within(screen.getByRole('region', { name: 'Межрайонная ИФНС № 18' })).getByRole('button', { name: 'Закрыть' }));
    expect(document.activeElement).toBe(map.container);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('brings the card itself into view while the map loads: the placeholder is no sight to scroll to', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    renderApp({ api: mapApi() });
    await openMapTab();
    await userEvent.click(topRows()[1]!);
    const card = cellCard(scoreLocations(ix).top[1]!.cell)!;
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(card);
  });

  it('brings the map into view for a card opened from a list, the card focused without a second scroll', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    renderApp({ api: mapApi() });
    const map = await openMapTab();
    act(() => map.options.onReady());
    const frame = () => screen.getByTestId('map-slot').querySelector('.map-frame');
    const cell = scoreLocations(ix).top[1]!.cell;

    await userEvent.click(topRows()[1]!);
    const card = cellCard(cell)!;
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(frame());
    expect(scrollIntoView.mock.lastCall).toEqual([{ block: 'start' }]);
    expect(focus.mock.contexts.at(-1)).toBe(card);
    expect(focus.mock.lastCall).toEqual([{ preventScroll: true }]);

    // The same row again: the map comes back into view (it flies there again), the card keeps the focus.
    scrollIntoView.mockClear();
    await userEvent.click(topRows()[1]!);
    expect(scrollIntoView.mock.contexts).toEqual([frame()]);
    expect(focus.mock.contexts.at(-1)).toBe(card);
    expect(focus.mock.lastCall).toEqual([{ preventScroll: true }]);
  });

  it('keeps the top of the card in view under the map on a short screen, a phone on its side', async () => {
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    renderApp({ api: mapApi() });
    const map = await openMapTab();
    act(() => map.options.onReady());
    const cell = scoreLocations(ix).top[1]!.cell;
    // The card opens under the map, its top below the bottom of the screen after the map came into view.
    topOf('.map-card', window.innerHeight + 40);
    await userEvent.click(topRows()[1]!);
    await waitFor(() => expect(document.activeElement).toBe(cellCard(cell)));
    const [, dy] = scrollBy.mock.lastCall as unknown as [number, number];
    expect(dy).toBeGreaterThan(40);
  });

  it('opens a link of the attribution through MAX', async () => {
    const bridge = renderApp({ api: mapApi() });
    const map = await openMapTab();
    act(() => map.options.onOpenLink('https://www.openstreetmap.org/copyright'));
    expect(bridge.openLink).toHaveBeenCalledWith('https://www.openstreetmap.org/copyright');
  });
});

describe('the camera', () => {
  it('brings the map into view for «Показать на карте» while it loads, the card of the place focused under it', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const api = mapApi();
    renderApp({ api, startParam: 'register-business' });
    const show = await screen.findByRole('button', { name: 'Показать на карте' });
    // A short screen: with the map in view, the card starts below its bottom.
    topOf('.map-card', window.innerHeight + 40);
    await userEvent.click(show);
    const card = await screen.findByRole('region', { name: 'Межрайонная ИФНС № 18' });
    await waitFor(() => expect(document.activeElement).toBe(card));
    // The step asked to see the place on the map: the map opens right on it, keeping its height while it loads, and the
    // top of the card shows under it.
    const slot = screen.getByTestId('map-slot');
    expect(within(slot).getByText('Загружаем карту…')).toBeTruthy();
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(slot.querySelector('.map-frame'));
    const [, dy] = scrollBy.mock.lastCall as unknown as [number, number];
    expect(dy).toBeGreaterThan(40);
    expect(sent(api, 'place_opened')).toEqual([['place_opened', { place: 'ifns-18', from: 'list' }]]);
  });

  it('brings the map into view for «Подобрать район на карте» while it loads, there the area of the best places', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    renderApp({ api: mapApi(), startParam: 'lease-premises' });
    await userEvent.click(await screen.findByRole('button', { name: 'Подобрать район на карте' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Лучшие места' })));
    expect(within(screen.getByTestId('map-slot')).getByText('Загружаем карту…')).toBeTruthy();
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(screen.getByTestId('map-slot').querySelector('.map-frame'));
    const map = await currentMap();
    await waitFor(() => expect(map.handle.showCells).toHaveBeenCalledExactlyOnceWith(scoreLocations(ix).top.map((place) => place.cell)));
    expect(map.handle.flyTo).not.toHaveBeenCalled();
  });

  it('opens over the place a step asked to show, without a flight', async () => {
    renderApp({ api: mapApi(), startParam: 'register-business' });
    await userEvent.click(await screen.findByRole('button', { name: 'Показать на карте' }));
    const map = await currentMap();
    expect(map.options.camera).toEqual({ center: [49.142156, 55.74213], zoom: 14 });
    await waitFor(() => expect(map.handle.select).toHaveBeenLastCalledWith({ kind: 'place', id: 'ifns-18' }));
    expect(map.handle.flyTo).not.toHaveBeenCalled();
  });

  it('keeps the place a step asked to show as the camera at once, though the map is left before it is ready', async () => {
    renderApp({ api: mapApi(), startParam: 'medical-books' });
    await userEvent.click(await screen.findByRole('button', { name: 'Показать на карте' }));
    const first = await currentMap();
    expect(first.options.camera).toEqual({ center: [49.170644, 55.798172], zoom: 14 });
    // To the other step done at this place, and back: the map never told where it looks.
    const card = await screen.findByRole('region', { name: 'Центр гигиены и эпидемиологии' });
    await userEvent.click(within(card).getByRole('button', { name: /Утвердить производственный контроль/ }));
    expect(await screen.findByText('Программа утверждена.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await waitFor(() => expect(mapViews).toHaveLength(2));
    expect(mapViews[1]!.options.camera).toEqual({ center: [49.170644, 55.798172], zoom: 14 });
  });

  it('returns from a step to where the map was left, the card marked, with no flight', async () => {
    renderApp({ api: mapApi() });
    const first = await openMapTab();
    await userEvent.click(topRows()[0]!);
    const cell = scoreLocations(ix).top[0]!.cell;
    act(() => first.options.onCameraChange({ center: [49.1, 55.793], zoom: 14.5 }));

    await userEvent.click(screen.getByRole('button', { name: 'Как проверить помещение' }));
    expect(await screen.findByText('Подберите район и посмотрите помещения.')).toBeTruthy();
    expect(first.handle.destroy).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await waitFor(() => expect(mapViews).toHaveLength(2));
    const back = mapViews[1]!;
    expect(back.options.camera).toEqual({ center: [49.1, 55.793], zoom: 14.5 });
    await waitFor(() => expect(back.handle.select).toHaveBeenLastCalledWith({ kind: 'cell', cell }));
    expect(back.handle.flyTo).not.toHaveBeenCalled();
  });

  it('closes a card opened on the map without sending the page to the list, after a return from a step too', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    renderApp({ api: mapApi() });
    const map = await openMapTab();
    const cell = scoreLocations(ix).top[0]!.cell;
    act(() => map.options.onCellClick(cell));
    await userEvent.click(screen.getByRole('button', { name: 'Как проверить помещение' }));
    expect(await screen.findByText('Подберите район и посмотрите помещения.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    const card = await screen.findByRole('region', { name: named(explainCell(ix, scoreLocations(ix), cell).title) });

    scrollIntoView.mockClear();
    focus.mockClear();
    await userEvent.click(within(card).getByRole('button', { name: 'Закрыть' }));
    expect(cellCard(cell)).toBeNull();
    // The focus goes to the row of the card, but the page stays where it is.
    expect(document.activeElement).toBe(topRows()[0]);
    expect(focus.mock.contexts.at(-1)).toBe(topRows()[0]);
    expect(focus.mock.lastCall).toEqual([{ preventScroll: true }]);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('keeps the map where it was across a switch to the route and back', async () => {
    renderApp({ api: mapApi() });
    const first = await openMapTab();
    act(() => first.options.onCameraChange({ center: [49.11, 55.78], zoom: 12.25 }));
    await userEvent.click(section('Маршрут'));
    await screen.findByText('Следующий шаг');
    expect(first.handle.destroy).toHaveBeenCalledTimes(1);

    const again = await openMapTab();
    expect(again).not.toBe(first);
    expect(again.options.camera).toEqual({ center: [49.11, 55.78], zoom: 12.25 });
  });

  it('opens a new map from the tab over the whole index', async () => {
    renderApp({ api: mapApi() });
    const map = await openMapTab();
    expect(map.options.camera.zoom).toBe(10);
    expect(map.handle.flyTo).not.toHaveBeenCalled();
  });
});

describe('beside the lists, on a wide screen', () => {
  it('lays the lists beside the map on a wide screen, in the order of a phone', async () => {
    const size = viewport('wide');
    renderApp({ api: mapApi() });
    await openMapTab();
    expect(layout()!.classList.contains('map-screen--wide')).toBe(true);
    // Every rule of MapScreen.css finds its part of the tab (jsdom loads no CSS, but it matches :has()), but the pin of
    // the map under «Назад», which a screen opened from a step has instead of the section switch: a class renamed on
    // the screen or mistyped in the CSS fails here.
    expect(unmatched()).toEqual(['html:has(.back ~ .map-screen--wide > .map-slot--map)']);
    // The lists go in the left column.
    expect(screen.getByRole('region', { name: 'Лучшие места' }).closest('.map-screen__info')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Места для шагов' }).closest('.map-screen__info')).toBeTruthy();
    // Reading and the focus go as on a phone: the header, the map, then the lists.
    expect(partsInOrder()).toEqual(['header', 'map', 'best places']);
    cleanup();

    // A phone, or the narrow panel of MAX: the same parts in one column, as before.
    resetMapViews();
    size.set('narrow');
    renderApp({ api: mapApi() });
    await openMapTab();
    expect(layout()!.classList.contains('map-screen--wide')).toBe(false);
    expect(partsInOrder()).toEqual(['header', 'map', 'best places']);
  });

  it('lets the map beside the lists take the wheel and one finger, and gives them back to the page on a narrow screen', async () => {
    // One column: the page scrolls over the map, and two fingers (or the wheel with Ctrl or ⌘) move it.
    const size = viewport('narrow');
    renderApp({ api: mapApi() });
    expect((await openMapTab()).options.cooperativeGestures).toBe(true);
    cleanup();

    resetMapViews();
    size.set('wide');
    renderApp({ api: mapApi() });
    const map = await openMapTab();
    expect(map.options.cooperativeGestures).toBe(false);
    const cell = scoreLocations(ix).top[1]!.cell;
    await userEvent.click(topRows()[1]!);
    const card = cellCard(cell)!;
    await waitFor(() => expect(document.activeElement).toBe(card));

    // MAX narrows its panel under the open card, and widens it again: the same map switches its gestures.
    size.set('narrow');
    expect(map.handle.setCooperativeGestures).toHaveBeenLastCalledWith(true);
    expect(layout()!.classList.contains('map-screen--wide')).toBe(false);
    size.set('wide');
    expect(map.handle.setCooperativeGestures).toHaveBeenLastCalledWith(false);
    expect(layout()!.classList.contains('map-screen--wide')).toBe(true);
    // Not a new map (its style and tiles would load again), and the card stays open, with the focus.
    expect(createMapView).toHaveBeenCalledTimes(1);
    expect(map.handle.destroy).not.toHaveBeenCalled();
    expect(cellCard(cell)).toBe(card);
    expect(document.activeElement).toBe(card);
  });

  it('brings a card opened from a list into sight beside the map, not the map', async () => {
    viewport('wide');
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    // The lists are scrolled down to a row near their end: the card opens at the top of the left column, above the
    // screen.
    const card = topOf('.map-card', -300);
    renderApp({ api: mapApi() });
    const map = await openMapTab();
    act(() => map.options.onReady());
    const top = scoreLocations(ix).top;
    scrollIntoView.mockClear();

    await userEvent.click(topRows()[1]!);
    const opened = cellCard(top[1]!.cell)!;
    await waitFor(() => expect(document.activeElement).toBe(opened));
    // The map beside the lists is in view already: the card itself comes into view, with no second scroll.
    expect(scrollIntoView.mock.contexts).toEqual([opened]);
    expect(scrollIntoView.mock.lastCall).toEqual([{ block: 'start' }]);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(focus.mock.lastCall).toEqual([{ preventScroll: true }]);

    // A card that opens in sight: the page stays where it is, and the card takes the focus there.
    card.set(200);
    scrollIntoView.mockClear();
    await userEvent.click(topRows()[0]!);
    const next = cellCard(top[0]!.cell)!;
    await waitFor(() => expect(document.activeElement).toBe(next));
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(focus.mock.contexts.at(-1)).toBe(next);
    expect(focus.mock.lastCall).toEqual([{ preventScroll: true }]);
  });

  it('brings a card into sight beside the map when the section switch or the bottom of the screen hides it', async () => {
    viewport('wide');
    // The scroll padding the page keeps for the section switch, the top of the map pinned under it (MapScreen.css; the
    // tests load no CSS).
    document.documentElement.style.scrollPaddingTop = '82px';
    onTestFinished(() => {
      document.documentElement.style.removeProperty('scroll-padding-top');
    });
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const card = topOf('.map-card', 200);
    renderApp({ api: mapApi() });
    await openMapTab();
    // The map is still loading: its placeholder is beside the lists all the same, and the card in sight stays.
    await userEvent.click(topRows()[1]!);
    const opened = cellCard(scoreLocations(ix).top[1]!.cell)!;
    await waitFor(() => expect(document.activeElement).toBe(opened));
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Its row again, the page moved: the top of the card behind the switch, or less than a peek of it above the bottom.
    for (const hidden of [50, window.innerHeight - 40]) {
      card.set(hidden);
      scrollIntoView.mockClear();
      await userEvent.click(topRows()[1]!);
      expect(scrollIntoView.mock.contexts, `top at ${hidden}`).toEqual([opened]);
    }
    // Level with the top of the map, or a peek of it above the bottom: in sight.
    for (const shown of [82, window.innerHeight - 96]) {
      card.set(shown);
      scrollIntoView.mockClear();
      await userEvent.click(topRows()[1]!);
      expect(scrollIntoView, `top at ${shown}`).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(opened);
    }
  });

  it('shows a card opened on the map beside it when out of sight, leaving the focus on the map', async () => {
    const size = viewport('wide');
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    // The lists are scrolled down: a card opens at the top of the left column, above the screen.
    const card = topOf('.map-card', -300);
    renderApp({ api: mapApi() });
    const map = await openMapTab();
    act(() => map.options.onReady());
    // The canvas of MapLibre is focusable: a tap focuses it.
    map.container.tabIndex = 0;
    map.container.focus();
    scrollIntoView.mockClear();

    act(() => map.options.onCellClick(3));
    const opened = cellCard(3)!;
    expect(scrollIntoView.mock.contexts).toEqual([opened]);
    expect(scrollIntoView.mock.lastCall).toEqual([{ block: 'start' }]);
    expect(document.activeElement).toBe(map.container);

    // A card that opens in sight: the page stays where it is.
    card.set(200);
    scrollIntoView.mockClear();
    act(() => map.options.onPlaceClick('ifns-18'));
    const place = screen.getByRole('region', { name: 'Межрайонная ИФНС № 18' });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(map.container);

    // Closing it gives the focus back to the map, and the page stays.
    await userEvent.click(within(place).getByRole('button', { name: 'Закрыть' }));
    expect(document.activeElement).toBe(map.container);
    expect(scrollIntoView).not.toHaveBeenCalled();

    // In one column the map stays under the finger: a card opened on it moves nothing, even out of sight.
    size.set('narrow');
    card.set(window.innerHeight + 40);
    act(() => map.options.onCellClick(3));
    expect(cellCard(3)).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(map.container);
  });

  it('brings the open card back into sight beside the map at a new tap on it there, leaving the focus on the map', async () => {
    const size = viewport('wide');
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    // The card opens in sight, at the top of the left column.
    const card = topOf('.map-card', 200);
    const api = mapApi();
    renderApp({ api });
    const map = await openMapTab();
    act(() => map.options.onReady());
    // The canvas of MapLibre is focusable: a tap focuses it.
    map.container.tabIndex = 0;
    map.container.focus();
    act(() => map.options.onCellClick(3));
    const opened = cellCard(3)!;
    expect(scrollIntoView).not.toHaveBeenCalled();

    // The lists scrolled down to «Лучшие места», the card above the screen: a tap on its cell shows it again.
    card.set(-300);
    act(() => map.options.onCellClick(3));
    expect(scrollIntoView.mock.contexts).toEqual([opened]);
    expect(scrollIntoView.mock.lastCall).toEqual([{ block: 'start' }]);
    expect(document.activeElement).toBe(map.container);
    // It is not a new opening.
    expect(sent(api, 'location_cell_opened')).toHaveLength(1);

    // In one column the map stays under the finger: the tap moves nothing.
    size.set('narrow');
    scrollIntoView.mockClear();
    act(() => map.options.onCellClick(3));
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(map.container);
  });

  it('opens the place a step asked to show beside the map, without bringing the map into view', async () => {
    viewport('wide');
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    renderApp({ api: mapApi(), startParam: 'register-business' });
    const show = await screen.findByRole('button', { name: 'Показать на карте' });
    // With a large font, say, the header leaves too little of the card above the bottom of the screen to see it opened.
    topOf('.map-card', window.innerHeight - 50);
    scrollIntoView.mockClear();
    await userEvent.click(show);
    const card = await screen.findByRole('region', { name: 'Межрайонная ИФНС № 18' });
    await waitFor(() => expect(document.activeElement).toBe(card));
    // The map beside the lists is in view as it loads: the card itself comes into view, with no second scroll.
    expect(scrollIntoView.mock.contexts).toEqual([card]);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(focus.mock.lastCall).toEqual([{ preventScroll: true }]);

    // The screen opened from a step has «Назад» instead of the section switch: the map is pinned where it stands
    // under the button, 51 px from the top, and a card brought into view stops there too (MapScreen.css).
    expect(unmatched()).toEqual(['html:has(.sections-bar ~ .map-screen--wide > .map-slot--map)']);
  });

  it('focuses the best places for «Подобрать район на карте» beside the map', async () => {
    viewport('wide');
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    renderApp({ api: mapApi(), startParam: 'lease-premises' });
    const pick = await screen.findByRole('button', { name: 'Подобрать район на карте' });
    // «Лучшие места» start under the header and the criteria, in sight.
    topOf('.map-top', 300);
    scrollIntoView.mockClear();
    await userEvent.click(pick);
    const best = await screen.findByRole('region', { name: 'Лучшие места' });
    await waitFor(() => expect(document.activeElement).toBe(best));
    // Beside the map nothing moves, and the map shows their area where it is.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(focus.mock.contexts.at(-1)).toBe(best);
    expect(focus.mock.lastCall).toEqual([{ preventScroll: true }]);
    const map = await currentMap();
    await waitFor(() => expect(map.handle.showCells).toHaveBeenCalledExactlyOnceWith(scoreLocations(ix).top.map((place) => place.cell)));
  });

  it('keeps one column when a wide screen has no map', async () => {
    hasWebGL.mockReturnValue(false);
    viewport('wide');
    renderApp({ api: mapApi() });
    await userEvent.click(within(await screen.findByRole('navigation', { name: 'Разделы' })).getByRole('button', { name: 'Карта' }));
    await screen.findByText(ix.title);
    // The screen is wide, but the rules of two columns ask for a map in the slot: the lists keep the whole width.
    expect(layout()!.classList.contains('map-screen--wide')).toBe(true);
    expect(screen.getByTestId('map-slot').parentElement).toBe(layout());
    expect(document.querySelector('.map-slot--map')).toBeNull();
    expect(document.querySelector('.map-screen--wide:has(> .map-slot--map)')).toBeNull();
    expect(createMapView).not.toHaveBeenCalled();

    // A best place opens its card as in one column: the card itself comes into view.
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    await userEvent.click(topRows()[0]!);
    const card = cellCard(scoreLocations(ix).top[0]!.cell)!;
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(card);
  });

  it('gives the lists the whole width again when the map fails on a wide screen', async () => {
    viewport('wide');
    renderApp({ api: mapApi() });
    const map = await openMapTab();
    expect(document.querySelector('.map-screen--wide:has(> .map-slot--map)')).toBeTruthy();

    act(() => map.options.onUnavailable('tiles', { stage: 'tiles', basemapTiles: 0 }));
    // The screen is still wide, but with no map in the slot the rules of two columns do not apply.
    expect(layout()!.classList.contains('map-screen--wide')).toBe(true);
    expect(document.querySelector('.map-screen--wide:has(> .map-slot--map)')).toBeNull();

    // A best place opens its card as in list mode: the card itself comes into view, in sight or not.
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    await userEvent.click(topRows()[0]!);
    const card = cellCard(scoreLocations(ix).top[0]!.cell)!;
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(scrollIntoView.mock.contexts).toEqual([card]);
  });

  it('opens a map anew in the other colour scheme with the gestures of the layout', async () => {
    const size = viewport('wide');
    renderApp({ api: mapApi() });
    expect((await openMapTab()).options.cooperativeGestures).toBe(false);

    // Beside the lists the new map keeps the wheel and one finger.
    size.setScheme('dark');
    await waitFor(() => expect(mapViews).toHaveLength(2));
    const dark = mapViews[1]!;
    expect(dark.options.theme).toBe(MAP_THEMES.dark);
    expect(dark.options.cooperativeGestures).toBe(false);
    expect(layout()!.classList.contains('map-screen--wide')).toBe(true);
    await waitFor(() => expect(dark.handle.setIndex).toHaveBeenCalled());

    // Narrowed, the same map switches its gestures and keeps its scheme; the next new map takes those of one column.
    size.set('narrow');
    expect(mapViews).toHaveLength(2);
    expect(dark.handle.setCooperativeGestures).toHaveBeenLastCalledWith(true);
    size.setScheme('light');
    await waitFor(() => expect(mapViews).toHaveLength(3));
    expect(mapViews[2]!.options.theme).toBe(MAP_THEMES.light);
    expect(mapViews[2]!.options.cooperativeGestures).toBe(true);
  });
});

describe('without a map', () => {
  it('shows the lists alone when there is no WebGL, from the first frame, and reports it once in the session', async () => {
    hasWebGL.mockReturnValue(false);
    const api = mapApi();
    renderApp({ api });
    await userEvent.click(within(await screen.findByRole('navigation', { name: 'Разделы' })).getByRole('button', { name: 'Карта' }));
    await screen.findByText(ix.title);
    // Asked before anything of the map is drawn: no frame shows up only to vanish, and MapLibre is not even loaded.
    expect(screen.getByTestId('map-slot').childElementCount).toBe(0);
    expect(createMapView).not.toHaveBeenCalled();
    expect(screen.queryByText('Индекс места')).toBeNull();
    expect(screen.queryByText('Загружаем карту…')).toBeNull();
    await waitFor(() => expect(sent(api, 'map_failed')).toEqual([['map_failed', { kind: 'webgl' }]]));

    // The lists are the whole map: a best place opens its card as before, and the card itself comes into view.
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    await userEvent.click(topRows()[0]!);
    const card = cellCard(scoreLocations(ix).top[0]!.cell);
    expect(card).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(card);

    await userEvent.click(section('Маршрут'));
    await userEvent.click(await screen.findByRole('button', { name: 'Карта' }));
    await screen.findByText(ix.title);
    expect(createMapView).not.toHaveBeenCalled();
    expect(hasWebGL).toHaveBeenCalledTimes(1);
    expect(sent(api, 'map_failed')).toHaveLength(1);
  });

  it('gives way to the lists when the tiles do not come, removes the map and tells how far it got', async () => {
    const api = mapApi();
    renderApp({ api });
    const map = await openMapTab();
    act(() => map.options.onUnavailable('tiles_timeout', { stage: 'tiles', basemapTiles: 0 }));
    expect(screen.getByTestId('map-slot').childElementCount).toBe(0);
    expect(map.handle.destroy).toHaveBeenCalledTimes(1);
    // A late word from the same map changes nothing: one failure, one event.
    act(() => map.options.onUnavailable('tiles', { stage: 'tiles', basemapTiles: 0 }));
    expect(sent(api, 'map_failed')).toEqual([['map_failed', { kind: 'tiles_timeout', stage: 'tiles', basemapTiles: 0 }]]);
    expect(topRows().length).toBeGreaterThan(0);
  });

  it('tries a map that failed on the network once more, at the next opening, and no more', async () => {
    const api = mapApi();
    renderApp({ api });
    const first = await openMapTab();
    act(() => first.options.onUnavailable('tiles', { stage: 'style', basemapTiles: 0, status: 503 }));
    expect(sent(api, 'map_failed')).toEqual([['map_failed', { kind: 'tiles', stage: 'style', basemapTiles: 0, status: 503 }]]);

    await userEvent.click(section('Маршрут'));
    const second = await openMapTab();
    expect(second).not.toBe(first);
    act(() => second.options.onUnavailable('tiles_timeout', { stage: 'tiles', basemapTiles: 0 }));
    expect(sent(api, 'map_failed')).toHaveLength(2);

    await userEvent.click(section('Маршрут'));
    await userEvent.click(await screen.findByRole('button', { name: 'Карта' }));
    await screen.findByText(ix.title);
    expect(createMapView).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('map-slot').childElementCount).toBe(0);
  });

  it('tries a map that failed on the network once more as soon as the device is online', async () => {
    renderApp({ api: mapApi() });
    const first = await openMapTab();
    act(() => first.options.onUnavailable('tiles', { stage: 'style', basemapTiles: 0 }));
    expect(screen.getByTestId('map-slot').childElementCount).toBe(0);

    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(mapViews).toHaveLength(2));
    expect(screen.getByTestId('map-slot').querySelector('.map-frame')).toBeTruthy();
  });

  it('keeps its one more attempt while the device is offline, and makes it once online', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    renderApp({ api: mapApi() });
    const first = await openMapTab();
    act(() => first.options.onUnavailable('tiles', { stage: 'style', basemapTiles: 0 }));

    onLine.mockReturnValue(false);
    await userEvent.click(section('Маршрут'));
    await userEvent.click(await screen.findByRole('button', { name: 'Карта' }));
    await screen.findByText(ix.title);
    expect(createMapView).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('map-slot').childElementCount).toBe(0);

    onLine.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(mapViews).toHaveLength(2));
  });

  it('does not try again a style of the app that MapLibre rejected: the network is not to blame', async () => {
    const api = mapApi();
    renderApp({ api });
    const first = await openMapTab();
    act(() => first.options.onUnavailable('tiles', { stage: 'overlay', basemapTiles: 0 }));
    await userEvent.click(section('Маршрут'));
    await userEvent.click(await screen.findByRole('button', { name: 'Карта' }));
    await screen.findByText(ix.title);
    act(() => window.dispatchEvent(new Event('online')));
    expect(createMapView).toHaveBeenCalledTimes(1);
    expect(sent(api, 'map_failed')).toEqual([['map_failed', { kind: 'tiles', stage: 'overlay', basemapTiles: 0 }]]);
  });

  it('does not try again a MapLibre that cannot start or a chunk that did not load', async () => {
    for (const kind of ['init', 'map_chunk'] as const) {
      resetMapViews();
      createMapView.mockResolvedValueOnce(kind);
      const api = mapApi();
      renderApp({ api });
      await userEvent.click(within(await screen.findByRole('navigation', { name: 'Разделы' })).getByRole('button', { name: 'Карта' }));
      await waitFor(() => expect(sent(api, 'map_failed')).toEqual([['map_failed', { kind }]]));
      expect(screen.getByTestId('map-slot').childElementCount).toBe(0);
      // The screen itself works: no reload is offered, the route is not replaced.
      expect(await screen.findByText(ix.title)).toBeTruthy();
      expect(screen.queryByText('Карта не загрузилась')).toBeNull();

      await userEvent.click(section('Маршрут'));
      await userEvent.click(await screen.findByRole('button', { name: 'Карта' }));
      await screen.findByText(ix.title);
      act(() => window.dispatchEvent(new Event('online')));
      expect(createMapView).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });
});

describe('the life of a map', () => {
  it('removes the map when the screen goes', async () => {
    renderApp({ api: mapApi() });
    const map = await openMapTab();
    await userEvent.click(section('Маршрут'));
    expect(map.handle.destroy).toHaveBeenCalledTimes(1);
  });

  it('leaves one live map after the double mount of StrictMode', async () => {
    render(
      <StrictMode>
        <ThemeProvider>
          <App api={mapApi()} bridge={fakeBridge()} />
        </ThemeProvider>
      </StrictMode>,
    );
    await openMapTab();
    const live = mapViews.filter((map) => map.handle.destroy.mock.calls.length === 0);
    expect(live).toHaveLength(1);
    expect(mapViews.length).toBeGreaterThan(1);
    await waitFor(() => expect(live[0]!.handle.setIndex).toHaveBeenLastCalledWith({ ix, scores: scoreLocations(ix).scores }));
  });
});
