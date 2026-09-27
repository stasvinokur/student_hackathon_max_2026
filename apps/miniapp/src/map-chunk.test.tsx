import { RulesPackSchema, type Profile } from '@otkryvay/core';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiClient } from './api.js';
import { fakeApi, fakeBridge, renderApp } from './test-utils.js';

// The map chunk does not load, and importing it again fails again at once, as in Chromium: a failed dynamic import
// of an address stays failed. The route must stay usable, and «Повторить» reloads the app only when the server
// answers — offline a reload would swap the working app for an error page.

vi.mock('./screens/MapScreen.js', () => {
  throw new Error('Failed to fetch dynamically imported module');
});
// The network is down: any other chunk would fail as well.
vi.mock('./screens/map/snapshot.js', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

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

const OFFLINE = 'Нет связи с сервером. Маршрут работает — откройте карту, когда связь появится.';

/** The switch of the root screens, «Маршрут | Карта»: app sections, so a navigation with buttons. */
const section = (name: 'Маршрут' | 'Карта') => within(screen.getByRole('navigation', { name: 'Разделы' })).getByRole('button', { name });
const findSection = async (name: 'Маршрут' | 'Карта') => within(await screen.findByRole('navigation', { name: 'Разделы' })).getByRole('button', { name });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openBrokenMap() {
  vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports the error the boundary caught
  const bridge = fakeBridge();
  const api = fakeApi(pack, profile);
  renderApp({ api, bridge });
  await userEvent.click(await findSection('Карта'));
  expect(await screen.findByText('Карта не загрузилась')).toBeTruthy();
  return { api, bridge };
}

const failures = (api: ApiClient) => vi.mocked(api.sendEvent).mock.calls.filter(([type]) => type === 'map_failed');

it('keeps the route one tap away when the map chunk does not load, and reports each failed opening', async () => {
  const { api } = await openBrokenMap();
  expect(failures(api)).toEqual([['map_failed', { kind: 'chunk' }]]);

  await userEvent.click(section('Маршрут'));
  expect(await screen.findByText('Следующий шаг')).toBeTruthy();
  await userEvent.click(await findSection('Карта'));
  expect(await screen.findByText('Карта не загрузилась')).toBeTruthy();
  expect(failures(api)).toHaveLength(2);
});

it('reports a failed chunk once, though the index of the map needs the same code', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const withIndex = { features: { explain: false, locationIndex: [{ pack: 'kazan-coffee', version: '20260923T192821Z-3f9a1c2b', actions: [] }] } };
  const api = fakeApi(pack, profile, { getConfig: vi.fn(async () => withIndex), getLocationIndex: vi.fn(async (): Promise<unknown> => ({})) });
  renderApp({ api, bridge: fakeBridge() });
  await userEvent.click(await findSection('Карта'));
  expect(await screen.findByText('Карта не загрузилась')).toBeTruthy();
  await waitFor(() => expect(api.getLocationIndex).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 50)); // the index load settles
  expect(failures(api)).toEqual([['map_failed', { kind: 'chunk' }]]);
});

it('tells where the reload leads: the app starts on the route, and the map is one tap away', async () => {
  await openBrokenMap();
  expect(screen.getByText('Маршрут работает как обычно. «Повторить» перезапустит приложение — затем снова откройте «Карту».')).toBeTruthy();
});

it('reloads the app for a fresh chunk on «Повторить» when the server answers', async () => {
  const { bridge } = await openBrokenMap();
  await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await waitFor(() => expect(bridge.reload).toHaveBeenCalledTimes(1));
  expect(bridge.serverReachable).toHaveBeenCalledTimes(1);
});

it('keeps the app and waits for the connection when the server does not answer', async () => {
  const { bridge } = await openBrokenMap();
  vi.mocked(bridge.serverReachable).mockResolvedValue(false);
  await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  expect(await screen.findByText(OFFLINE)).toBeTruthy();
  expect(bridge.reload).not.toHaveBeenCalled();

  // «Повторить» checks again; once the server answers, the reload brings the map.
  await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await waitFor(() => expect(bridge.serverReachable).toHaveBeenCalledTimes(2));
  expect(bridge.reload).not.toHaveBeenCalled();
  vi.mocked(bridge.serverReachable).mockResolvedValue(true);
  await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await waitFor(() => expect(bridge.reload).toHaveBeenCalledTimes(1));
});
