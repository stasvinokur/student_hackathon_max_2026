import { RulesPackSchema, type Profile } from '@otkryvay/core';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiClient } from './api.js';
import type { MapScreenProps } from './screens/MapScreen.js';
import { fakeApi, fakeBridge, renderApp } from './test-utils.js';

// The map chunk loads, but the screen throws while it renders. One remount covers a passing glitch; a map that
// fails again gives way to a calm message and the route — never a reload, which would not change the code.

// jsdom has no WebGL: a stand-in map canvas.
vi.mock('./screens/map/mapView.js', () => import('./test-map-view.js'));

const crash = vi.hoisted(() => ({ on: false }));
vi.mock('./screens/MapScreen.js', async (importOriginal) => {
  const { MapScreen } = await importOriginal<typeof import('./screens/MapScreen.js')>();
  return {
    MapScreen: (props: MapScreenProps) => {
      if (crash.on) throw new Error('the map could not render');
      return <MapScreen {...props} />;
    },
  };
});

/**
 * The map throws until React hands the error to the boundary, which React reports with console.error just before
 * componentDidCatch. That ends the first mount however many renders React retried on its own, so the next render is
 * the remount.
 */
function crashFirstMount() {
  crash.on = true;
  vi.spyOn(console, 'error').mockImplementation(() => {
    crash.on = false;
  });
}

function crashEveryMount() {
  crash.on = true;
  vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports the errors the boundary caught
}

const pack = RulesPackSchema.parse({
  manifest: {
    id: 'kazan-coffee', version: '1.1.0', title: 'Кофейня, Казань', industry: 'coffee', checked_at: '2026-09-18', cities: ['kazan'],
    region: { code: 'kazan', name: 'Казань' },
  },
  places: [
    {
      id: 'ifns-18', name: 'Межрайонная ИФНС № 18', address: 'Казань, ул. Владимира Кулагина, 1', lat: 55.74213, lon: 49.142156,
      source: { url: 'https://www.nalog.gov.ru/rn16/ifns/16_mri18/', title: 'ФНС России — МРИ № 18', checked_at: '2026-09-23' },
    },
  ],
  actions: [
    {
      id: 'register-business', title: 'Зарегистрировать ИП', lane: 'critical', duration_days: 7, why: 'Без регистрации нельзя работать.',
      do_now: 'Подайте заявление.', done_when: 'Есть лист записи.', places: ['ifns-18'], kind: 'official_fact',
    },
  ],
});
const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 1, sells_food: false, opening_date: '2026-11-01' };

/** The switch of the root screens, «Маршрут | Карта»: app sections, so a navigation with buttons. */
const section = (name: 'Маршрут' | 'Карта') => within(screen.getByRole('navigation', { name: 'Разделы' })).getByRole('button', { name });
const findSection = async (name: 'Маршрут' | 'Карта') => within(await screen.findByRole('navigation', { name: 'Разделы' })).getByRole('button', { name });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  crash.on = false;
});

const failures = (api: ApiClient) => vi.mocked(api.sendEvent).mock.calls.filter(([type]) => type === 'map_failed');

it('remounts the map once after a render error: a passing glitch does not show, but is reported', async () => {
  const bridge = fakeBridge();
  const api = fakeApi(pack, profile);
  renderApp({ api, bridge });
  await screen.findByText('Следующий шаг');
  crashFirstMount();

  await userEvent.click(section('Карта'));
  expect(await screen.findByRole('region', { name: 'Места для шагов' })).toBeTruthy();
  expect(crash.on).toBe(false);
  expect(screen.queryByText('Карта не открылась')).toBeNull();
  expect(failures(api)).toEqual([['map_failed', { kind: 'render' }]]);
});

it('leaves a map that fails again for the route: a calm message, «К маршруту», no reload', async () => {
  const bridge = fakeBridge();
  const api = fakeApi(pack, profile);
  renderApp({ api, bridge });
  await screen.findByText('Следующий шаг');
  crashEveryMount();

  await userEvent.click(section('Карта'));
  expect(await screen.findByText('Карта не открылась')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
  // One failure, one event: the remount that failed too is part of it.
  expect(failures(api)).toEqual([['map_failed', { kind: 'render' }]]);

  await userEvent.click(screen.getByRole('button', { name: 'К маршруту' }));
  expect(await screen.findByText('Следующий шаг')).toBeTruthy();
  expect(bridge.reload).not.toHaveBeenCalled();
  expect(bridge.serverReachable).not.toHaveBeenCalled();

  // A new opening starts afresh: one more remount, which succeeds now.
  crashFirstMount();
  await userEvent.click(section('Карта'));
  expect(await screen.findByRole('region', { name: 'Места для шагов' })).toBeTruthy();
});

it('opens a fresh map after giving up on it: the state it broke on is not brought back', async () => {
  const api = fakeApi(pack, profile);
  renderApp({ api, bridge: fakeBridge() });
  await userEvent.click(await findSection('Карта'));
  const places = await screen.findByRole('region', { name: 'Места для шагов' });
  await userEvent.click(within(places).getByRole('button', { name: /Межрайонная ИФНС/ }));
  expect(screen.getByRole('region', { name: 'Межрайонная ИФНС № 18' })).toBeTruthy();

  // The map breaks at its next opening, and the app gives up on it.
  await userEvent.click(section('Маршрут'));
  crashEveryMount();
  await userEvent.click(section('Карта'));
  expect(await screen.findByText('Карта не открылась')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'К маршруту' }));

  // Working again, it starts fresh: not with the card it was showing when it broke.
  crash.on = false;
  await userEvent.click(section('Карта'));
  expect(await screen.findByRole('region', { name: 'Места для шагов' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Межрайонная ИФНС № 18' })).toBeNull();
});

