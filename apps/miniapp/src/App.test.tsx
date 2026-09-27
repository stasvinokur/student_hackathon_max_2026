import { buildRoute, RulesPackSchema, toRouteView, type Profile, type RouteView, type TaskSummary } from '@otkryvay/core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from './api.js';
import { readLaunchContext, type ShareOutcome } from './bridge.js';
import { taskStatusText } from './components/ui.js';
import { ReadinessScreen } from './screens/ReadinessScreen.js';
import { RouteScreen } from './screens/RouteScreen.js';
import { stepsOpenedText } from './screens/TaskScreen.js';
import { fakeApi as fakeApiFor, fakeBridge, renderApp } from './test-utils.js';
import { ThemeProvider } from './theme.js';

// ---------- a small route computed by the real core engine ----------
const source = { url: 'https://www.nalog.gov.ru/', title: '129-ФЗ, ст. 8', checked_at: '2026-09-18' };
const manifest = {
  id: 'demo', version: '1.0.0', title: 'Кофейня, Казань', industry: 'coffee', checked_at: '2026-09-18', cities: ['kazan'],
  region: { code: 'kazan', name: 'Казань' }, disclaimer: 'Не юридическая консультация.',
};
const pack = RulesPackSchema.parse({
  manifest,
  actions: [
    { id: 'register', title: 'Зарегистрировать ИП', lane: 'critical', duration_days: 7, why: 'Без регистрации нельзя работать.', do_now: 'Подайте заявление.', prepare: ['Паспорт'], done_when: 'Есть лист записи.', source, kind: 'test_data' },
    { id: 'kkt', title: 'Зарегистрировать кассу', lane: 'critical', duration_days: 5, depends_on: ['register'], why: 'w', do_now: 'd', prepare: ['ККТ'], done_when: 'x', source, kind: 'official_fact' },
    { id: 'bank', title: 'Открыть счёт', lane: 'support', duration_days: 2, why: 'w', do_now: 'd', prepare: ['Паспорт'], done_when: 'x', kind: 'recommendation' },
  ],
});
const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'signed', employees: 0, sells_food: false, opening_date: '2026-11-01' };

const fakeApi = (overrides: Partial<ApiClient> = {}) => fakeApiFor(pack, profile, overrides);

/** Waits until the app has the route, by which a step card dates itself and counts the steps it opens. */
async function routeLoaded(api: ApiClient) {
  await waitFor(() => expect(api.getRoute).toHaveBeenCalled());
  await act(async () => {
    await vi.mocked(api.getRoute).mock.results[0]!.value;
  });
}

afterEach(cleanup);

describe('mini-app', () => {
  it('explains how to open the app outside MAX', () => {
    renderApp({ api: null });
    expect(screen.getByText('Откройте в MAX')).toBeTruthy();
    expect(screen.getByText(/^Маршрут открывается из чата с ботом «Открывай» в MAX/)).toBeTruthy();
  });

  it('shows loading, then the personal route map', async () => {
    const api = fakeApi();
    renderApp({ api });
    expect(screen.getByText('Строим ваш маршрут…')).toBeTruthy();

    // The days to the opening: a small line and a big number, one heading.
    expect(await screen.findByRole('heading', { level: 1, name: 'До открытия 44 дня' })).toBeTruthy();
    expect(screen.getByText('1 ноября · Кофейня, Казань')).toBeTruthy();
    // The progress bar says how many steps are done, as the number beside it shows.
    expect(screen.getByRole('progressbar', { name: 'Готовность' }).getAttribute('aria-valuetext')).toBe('0 из 3');
    expect(screen.getByText('0 из 3')).toBeTruthy();
    expect(screen.getByText('Следующий шаг')).toBeTruthy();
    expect(screen.getByText('Могут сорвать запуск')).toBeTruthy();
    expect(screen.getByText('Обязательно до открытия')).toBeTruthy();
    expect(screen.getByText('Можно улучшить')).toBeTruthy();
    // Each list of steps goes under a heading of its own, to be found by headings; a lane counts its done steps.
    expect(screen.getByRole('heading', { level: 2, name: 'Могут сорвать запуск' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Обязательно до открытия: выполнено 0 из 2' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Можно улучшить: выполнено 0 из 1' })).toBeTruthy();
    expect(screen.getAllByText(/Ждёт: Зарегистрировать ИП/).length).toBeGreaterThan(0);
    expect(api.sendEvent).toHaveBeenCalledWith('miniapp_opened', { deepLink: false });
  });

  it('counts a step marked done on the route, on the whole and in its lane', async () => {
    const api = fakeApi();
    renderApp({ api, startParam: 'register' });
    await routeLoaded(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Выполнено' }));
    await screen.findByText('Отмечено. Открылся 1 шаг.');
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Обязательно до открытия: выполнено 1 из 2' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Можно улучшить: выполнено 0 из 1' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Готовность' }).getAttribute('aria-valuetext')).toBe('1 из 3');
  });

  it('opens the next step from its card', async () => {
    renderApp({ api: fakeApi() });
    const next = (await screen.findByText('Следующий шаг')).closest('section')!;
    expect(within(next).getByText('Зарегистрировать ИП')).toBeTruthy();
    expect(within(next).getByText('Начать до 20 октября')).toBeTruthy();

    // The button tells which step it opens.
    await userEvent.click(within(next).getByRole('button', { name: 'Открыть шаг', description: 'Зарегистрировать ИП' }));
    expect(await screen.findByText('Без регистрации нельзя работать.')).toBeTruthy();
  });

  it('ends the route with the pack disclaimer alone: no rules version or check date', async () => {
    renderApp({ api: fakeApi() });
    await screen.findByRole('heading', { level: 1, name: 'До открытия 44 дня' });
    // The whole line is the disclaimer of the pack.
    expect(screen.getByText('Не юридическая консультация.')).toBeTruthy();
    expect(screen.queryByText(/Пакет правил/)).toBeNull();
    expect(screen.queryByText(/проверен \d/)).toBeNull();
  });

  it('shows the empty state before onboarding is finished', async () => {
    renderApp({ api: fakeApi({ getRoute: vi.fn(async () => { throw new ApiError(404, 'route_not_found', 'нет'); }) }) });
    expect(await screen.findByText('Маршрута пока нет')).toBeTruthy();
    expect(screen.getByText(/маршрут появится здесь автоматически\.$/)).toBeTruthy();
  });

  it('shows an error with retry and recovers', async () => {
    const api = fakeApi();
    const ok = api.getRoute;
    api.getRoute = vi.fn().mockRejectedValueOnce(new ApiError(0, 'network', 'Нет связи с сервером.')).mockImplementation(ok);
    renderApp({ api });

    expect(await screen.findByText('Нет связи с сервером.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'До открытия 44 дня' })).toBeTruthy();
  });

  it('opens a task card with its source and data kind, without the check date; back returns to the map', async () => {
    const api = fakeApi();
    const bridge = renderApp({ api }) as ReturnType<typeof fakeBridge>;
    await userEvent.click((await screen.findAllByText('Зарегистрировать кассу'))[0]!);

    expect(await screen.findByText('Официальный источник')).toBeTruthy();
    // The icon beside the source adds nothing to its name.
    expect(screen.getByRole('button', { name: '129-ФЗ, ст. 8' })).toBeTruthy();
    expect(screen.queryByText(/Проверено/i)).toBeNull();
    const needed = screen.getByRole('heading', { level: 2, name: 'Сначала нужно' }).closest('section')!;
    // The status of a step it waits for is a line of its own under the step, never a tail that wraps alone.
    const step = within(needed).getByRole('button', { name: 'Зарегистрировать ИП' });
    const status = within(step.closest('li')!).getByText('Ещё не выполнено');
    expect(step.nextElementSibling).toBe(status);
    expect(status.closest('button')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '129-ФЗ, ст. 8' }));
    expect(bridge.openLink).toHaveBeenCalledWith('https://www.nalog.gov.ru/');

    // Platform back button is active on the inner screen and returns to the map.
    expect(bridge.back).toBeTypeOf('function');
    bridge.back!();
    expect(await screen.findByText('Следующий шаг')).toBeTruthy();
    await waitFor(() => expect(bridge.back).toBeNull());
  });

  it('opens a new screen at the top and returns to the same place on the map', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    try {
      renderApp({ api: fakeApi() });
      await screen.findByText('Следующий шаг');
      Object.defineProperty(window, 'scrollY', { value: 640, configurable: true }); // the map is scrolled down

      await userEvent.click(screen.getByRole('button', { name: /Готовность к открытию/ }));
      await screen.findByText('Осталось обязательного');
      expect(scrollTo).toHaveBeenLastCalledWith(0, 0);

      await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
      await screen.findByText('Следующий шаг');
      expect(scrollTo).toHaveBeenLastCalledWith(0, 640);
    } finally {
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
      scrollTo.mockRestore();
    }
  });

  it('opens the map at the top after leaving a card opened by a deep link', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    try {
      renderApp({ api: fakeApi(), startParam: 'kkt' });
      await screen.findByText('Сначала нужно');
      Object.defineProperty(window, 'scrollY', { value: 900, configurable: true }); // the card is scrolled down

      await userEvent.click(screen.getByRole('button', { name: 'Зарегистрировать ИП' })); // its prerequisite
      await screen.findByText('Без регистрации нельзя работать.');
      await userEvent.click(screen.getByRole('button', { name: 'Назад' })); // back to the deep-linked card
      await screen.findByText('Сначала нужно');
      await userEvent.click(screen.getByRole('button', { name: 'Назад' })); // the map replaces it as the root
      await screen.findByText('Следующий шаг');
      expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    } finally {
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
      scrollTo.mockRestore();
    }
  });

  it('marks a task done at once (optimistic) and refreshes the map', async () => {
    let resolve!: () => void;
    const api = fakeApi();
    const save = api.setTaskStatus;
    api.setTaskStatus = vi.fn((id, status) => new Promise((r) => (resolve = () => r(save(id, status)))) as never);
    renderApp({ api, startParam: 'register' });
    await routeLoaded(api);
    const button = await screen.findByRole('button', { name: 'Выполнено' });
    // The live region is there before anything happens: a region added with its text may go unannounced.
    const live = screen.getByRole('status');
    expect(live.textContent).toBe('');

    await userEvent.click(button);
    // The card updated before the server answered: the status tag and the line under the title.
    expect(screen.getByText('Выполнено')).toBeTruthy();
    expect(screen.getByText('Выполнено · обычно 7 дней')).toBeTruthy();
    // While it saves the button keeps the focus and its name, and a second press sends nothing.
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole('button', { name: 'Вернуть в работу' })).toBe(button);
    await userEvent.click(button);
    expect(api.setTaskStatus).toHaveBeenCalledTimes(1);
    resolve();
    // «Зарегистрировать кассу» waited for this step alone: it opens now.
    await waitFor(() => expect(live.textContent).toBe('Отмечено. Открылся 1 шаг.'));
    expect(button.getAttribute('aria-busy')).toBeNull();
    await waitFor(() => expect(api.getRoute).toHaveBeenCalledTimes(2));

    await userEvent.click(button);
    resolve();
    await waitFor(() => expect(live.textContent).toBe('Шаг возвращён в работу.'));
    expect(screen.getByText('Начать до 20 октября · обычно 7 дней')).toBeTruthy();
  });

  it('keeps the height of its bottom panel for the scroll padding of the page, and clears it on leaving', async () => {
    const root = document.documentElement;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: () => void) {}
        observe() {
          this.callback();
        }
        disconnect() {}
      },
    );
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(142);
    try {
      renderApp({ api: fakeApi(), startParam: 'register' });
      await screen.findByRole('button', { name: 'Выполнено' });
      expect(root.style.getPropertyValue('--step-action-h')).toBe('142px');
      await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
      await screen.findByText('Следующий шаг');
      expect(root.style.getPropertyValue('--step-action-h')).toBe('');
    } finally {
      height.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('heads a step card with its status and kind, when to start it and how long it takes; its dates have no section', async () => {
    const api = fakeApi();
    renderApp({ api, startParam: 'kkt' });
    await routeLoaded(api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Зарегистрировать кассу' })).toBeTruthy();
    expect(screen.getByText('Ждёт другой шаг')).toBeTruthy();
    expect(screen.getByText('Официальный источник')).toBeTruthy();
    // The route knows today: a date of this year goes without the year.
    expect(screen.getByText('Начать до 27 октября · обычно 5 дней')).toBeTruthy();
    // The head of a card is no banner of the page.
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByText('Сроки')).toBeNull();
    expect(screen.queryByText(/закончить до/i)).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Выполнено, когда' })).toBeTruthy();
    expect(screen.queryByText('Что считается выполненным')).toBeNull();
  });

  it('writes the year of the start date and counts no opened steps until the route has loaded', async () => {
    renderApp({ api: fakeApi({ getRoute: vi.fn(() => new Promise<never>(() => {})) }), startParam: 'register' });
    expect(await screen.findByText('Начать до 20 октября 2026 · обычно 7 дней')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Выполнено' }));
    expect(await screen.findByText('Отмечено как выполненное.')).toBeTruthy();
  });

  it('tags an overdue step overdue and says to start it today, the tags read after its title', async () => {
    const api = fakeApiFor(pack, { ...profile, opening_date: '2026-09-25' });
    renderApp({ api, startParam: 'register' });
    await routeLoaded(api);
    const title = await screen.findByRole('heading', { level: 1, name: 'Зарегистрировать ИП' });
    // The opening cannot be met: the step is dated from the reachable one, and its last day to start is today.
    expect(screen.getByText('Начать сегодня · обычно 7 дней')).toBeTruthy();
    expect(screen.queryByText(/Начать до/)).toBeNull();
    // Shown above the title, the tags follow it in the page: moving by headings skips none of them.
    for (const tag of ['Просрочено', 'Тестовые данные']) {
      expect(title.compareDocumentPosition(screen.getByText(tag)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('says to start today a step whose last day to start is today, nothing overdue while the opening can be met', async () => {
    // Opening on 30 September takes the 12 days of the two required steps from today on, not a day more.
    const api = fakeApiFor(pack, { ...profile, opening_date: '2026-09-30' });
    renderApp({ api });
    const next = (await screen.findByText('Следующий шаг')).closest('section')!;
    expect(within(next).getByText('Начать сегодня')).toBeTruthy();
    expect(screen.queryByText(/Просрочено|не успеть|откроетесь/)).toBeNull();

    await userEvent.click(within(next).getByRole('button', { name: 'Открыть шаг' }));
    expect(await screen.findByText('Начать сегодня · обычно 7 дней')).toBeTruthy();
    expect(screen.queryByText('Просрочено')).toBeNull();
  });

  describe('an opening that cannot be met', () => {
    it('keeps the chosen date in the hero, says under it when the opening can be reached, and tells to start today', async () => {
      renderApp({ api: fakeApiFor(pack, { ...profile, opening_date: '2026-09-25' }) });
      expect(await screen.findByRole('heading', { level: 1, name: 'До открытия 7 дней' })).toBeTruthy();
      const meta = screen.getByText('25 сентября · Кофейня, Казань');
      const warning = screen.getByText('К 25 сентября не успеть — если начать сегодня, откроетесь 30 сентября.');
      // Right under the date it speaks of, a part of the page: nothing announces it on its own.
      expect(meta.nextElementSibling).toBe(warning);
      expect(warning.closest('[role="alert"], [role="status"]')).toBeNull();
      // The step that holds the opening back, on the card of the next step, in «Могут сорвать запуск» and in its lane.
      const next = screen.getByText('Следующий шаг').closest('section')!;
      const blockers = screen.getByRole('heading', { level: 2, name: 'Могут сорвать запуск' }).closest('section')!;
      const lane = screen.getByRole('heading', { level: 2, name: /^Обязательно до открытия/ }).closest('section')!;
      for (const place of [next, blockers, lane]) expect(within(place).getByText('Просрочено — начните сегодня')).toBeTruthy();
    });

    it('names only the reachable date once the chosen one has passed', async () => {
      renderApp({ api: fakeApiFor(pack, { ...profile, opening_date: '2026-09-10' }) });
      expect(await screen.findByRole('heading', { level: 1, name: 'Дата открытия прошла 8 дней назад' })).toBeTruthy();
      expect(screen.getByText('10 сентября · Кофейня, Казань').nextElementSibling).toBe(screen.getByText('Если начать сегодня, откроетесь 30 сентября.'));
    });

    it('is not warned of when it can be met', async () => {
      renderApp({ api: fakeApi() });
      await screen.findByRole('heading', { level: 1, name: 'До открытия 44 дня' });
      expect(screen.queryByText(/не успеть|откроетесь/)).toBeNull();
      expect(screen.getByText('1 ноября · Кофейня, Казань').nextElementSibling!.className).toBe('route-hero__progress');
    });
  });

  describe('counts the steps a done step opens', () => {
    // «lease» opens «equip» and «haccp»; «kkt» waits for «inn» too, «sign» is done already.
    const card = { lane: 'support', duration_days: 1, why: 'w', do_now: 'd', prepare: ['Паспорт'], done_when: 'x', kind: 'recommendation' };
    const leasePack = RulesPackSchema.parse({
      manifest,
      actions: [
        { ...card, id: 'lease', title: 'Арендовать помещение', lane: 'critical', duration_days: 7 },
        { ...card, id: 'inn', title: 'Получить ИНН' },
        { ...card, id: 'equip', title: 'Оборудовать помещение', lane: 'critical', depends_on: ['lease'] },
        { ...card, id: 'haccp', title: 'Утвердить программу контроля', lane: 'ops', depends_on: ['lease'] },
        { ...card, id: 'kkt', title: 'Зарегистрировать кассу', depends_on: ['lease', 'inn'] },
        { ...card, id: 'sign', title: 'Заказать вывеску', depends_on: ['lease'] },
      ],
    });
    const leaseApi = async () => {
      const api = fakeApiFor(leasePack, profile);
      await api.setTaskStatus('sign', 'done');
      return api;
    };

    it('those that waited for it alone and are not done', async () => {
      const api = await leaseApi();
      renderApp({ api, startParam: 'lease' });
      await routeLoaded(api);
      await userEvent.click(await screen.findByRole('button', { name: 'Выполнено' }));
      expect(await screen.findByText('Отмечено. Открылись 2 шага.')).toBeTruthy();
    });

    it('none when the steps after it wait for others too', async () => {
      const api = await leaseApi();
      renderApp({ api, startParam: 'inn' });
      await routeLoaded(api);
      await userEvent.click(await screen.findByRole('button', { name: 'Выполнено' }));
      expect(await screen.findByText('Отмечено как выполненное.')).toBeTruthy();
    });

    it.each([
      [1, 'Открылся 1 шаг.'],
      [2, 'Открылись 2 шага.'],
      [5, 'Открылись 5 шагов.'],
      [11, 'Открылись 11 шагов.'],
      [21, 'Открылся 21 шаг.'],
    ])('in words: %i', (count, text) => {
      expect(stepsOpenedText(count)).toBe(text);
    });
  });

  it('rolls back and explains when saving fails', async () => {
    const api = fakeApi({ setTaskStatus: vi.fn(async () => { throw new ApiError(500, 'internal_error', 'Ошибка сервера (500).'); }) });
    const bridge = renderApp({ api, startParam: 'register' });

    await userEvent.click(await screen.findByRole('button', { name: 'Выполнено' }));
    expect(await screen.findByText(/Не сохранилось: Ошибка сервера \(500\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Выполнено' })).toBeTruthy();
    expect(bridge.haptic).toHaveBeenCalledWith('error');
  });

  it('checks the status when the server took too long to confirm it: saved', async () => {
    const api = fakeApi();
    const save = api.setTaskStatus;
    // The server saves, but its answer never comes.
    api.setTaskStatus = vi.fn(async (id: string, status: 'todo' | 'done') => {
      await save(id, status);
      throw new ApiError(0, 'timeout', 'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.');
    });
    renderApp({ api, startParam: 'register' });
    await routeLoaded(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Выполнено' }));

    // Saved after all, it opened the steps that waited for it, as a quick answer would say.
    expect(await screen.findByText('Сервер долго не отвечал — проверили: статус сохранён. Открылся 1 шаг.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Вернуть в работу' })).toBeTruthy();
    await waitFor(() => expect(api.getRoute).toHaveBeenCalledTimes(2)); // the route shows the saved step
  });

  it('checks the status when the server took too long to confirm it: not saved', async () => {
    const api = fakeApi({
      setTaskStatus: vi.fn(async () => {
        throw new ApiError(0, 'timeout', 'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.');
      }),
    });
    renderApp({ api, startParam: 'register' });
    await userEvent.click(await screen.findByRole('button', { name: 'Выполнено' }));

    expect(await screen.findByText('Сервер долго не отвечал — проверили: статус не сохранился, попробуйте ещё раз.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Выполнено' })).toBeTruthy();
  });

  it('does not claim either way when the status cannot be checked, and keeps the same action at hand', async () => {
    const timeout = () => new ApiError(0, 'timeout', 'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.');
    const api = fakeApi({ setTaskStatus: vi.fn(async () => Promise.reject(timeout())) });
    const { getTask } = api;
    let reads = 0;
    api.getTask = vi.fn(async (id: string) => (++reads === 1 ? getTask(id) : Promise.reject(timeout())));
    renderApp({ api, startParam: 'register' });
    await userEvent.click(await screen.findByRole('button', { name: 'Выполнено' }));

    // The change may have reached the server: the card says it could not check, not that nothing was saved.
    expect(
      await screen.findByText('Нет ответа от сервера — не удалось проверить, сохранился ли статус. Проверьте интернет и откройте карточку снова.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Не сохранилось/)).toBeNull();
    // Setting a status is idempotent: pressing «Выполнено» again is safe.
    const again = screen.getByRole('button', { name: 'Выполнено' }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    await userEvent.click(again);
    expect(api.setTaskStatus).toHaveBeenLastCalledWith('register', 'done');
  });

  it('says the step is gone when checking the status finds no such step', async () => {
    const api = fakeApi({
      setTaskStatus: vi.fn(async () => Promise.reject(new ApiError(0, 'timeout', 'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.'))),
    });
    const { getTask } = api;
    let reads = 0;
    api.getTask = vi.fn(async (id: string) => (++reads === 1 ? getTask(id) : Promise.reject(new ApiError(404, 'task_not_found', 'Нет такого шага'))));
    renderApp({ api, startParam: 'register' });
    await userEvent.click(await screen.findByRole('button', { name: 'Выполнено' }));

    expect(await screen.findByText('Такого шага нет')).toBeTruthy();
    expect(screen.queryByText(/Не сохранилось/)).toBeNull();
  });

  it('opens straight to a card from a deep link and handles a stale link', async () => {
    renderApp({ api: fakeApi(), startParam: 'no-such-step' });
    expect(await screen.findByText('Такого шага нет')).toBeTruthy();
  });

  it('shows readiness and shares through MAX the status card it previews', async () => {
    const api = fakeApi();
    const bridge = fakeBridge();
    renderApp({ api, bridge, botLink: 'https://max.ru/otkryvay_bot' });
    await userEvent.click(await screen.findByRole('button', { name: /Готовность к открытию/ }));
    // The percent in the ring is the heading of the screen; the ring only draws it, so there is no progress bar besides.
    const title = await screen.findByRole('heading', { level: 1, name: 'готовность к открытию 0%' });
    expect(title.parentElement!.style.getPropertyValue('--ready-arc')).toBe('0%');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Выполнено 0 из 3')).toBeTruthy();
    expect(screen.getByText('Обязательных 0 из 2')).toBeTruthy();
    // The required steps left, their number at the right of the heading.
    const left = screen.getByRole('heading', { level: 2, name: 'Осталось обязательного: 2' }).closest('section')!;
    expect(within(left).getAllByRole('button').map((row) => row.textContent)).toEqual([expect.stringContaining('Зарегистрировать ИП'), expect.stringContaining('Зарегистрировать кассу')]);

    await userEvent.click(screen.getByRole('button', { name: 'Поделиться с партнёром' }));
    const sent = vi.mocked(bridge.share).mock.calls[0]![0];
    expect(sent).toMatch(/^Готовность к открытию: 0%\n[\s\S]*https:\/\/max\.ru\/otkryvay_bot$/);
    // The card shows the very text that goes to the chat, line by line.
    const card = screen.getByRole('heading', { level: 2, name: 'Уйдёт в чат' }).closest('section')!;
    expect(within(card).getByText(/^Готовность к открытию: 0%/).textContent).toBe(sent);
    await waitFor(() => expect(api.sendEvent).toHaveBeenCalledWith('share_clicked', { shared: true, result: 'shared' }));
  });

  it('says the card was copied where MAX cannot open the share sheet, again on each copy', async () => {
    let finish!: (outcome: ShareOutcome) => void;
    const bridge = fakeBridge();
    bridge.share = vi.fn(() => new Promise<ShareOutcome>((resolve) => (finish = resolve)));
    renderApp({ api: fakeApi(), bridge });
    await userEvent.click(await screen.findByRole('button', { name: /Готовность к открытию/ }));
    const button = await screen.findByRole('button', { name: 'Поделиться с партнёром' });
    // The live region is there before anything happens: a region added with its text may go unannounced.
    const live = screen.getByRole('status');
    expect(live.textContent).toBe('');
    const copied = 'Текст готовности скопирован — вставьте его в чат с партнёром или бухгалтером.';
    await userEvent.click(button);
    finish({ result: 'copied' });
    await waitFor(() => expect(live.textContent).toBe(copied));

    // A second copy empties the region first: the same words are announced anew.
    await userEvent.click(button);
    expect(live.textContent).toBe('');
    finish({ result: 'copied' });
    await waitFor(() => expect(live.textContent).toBe(copied));
  });

  it('explains when sharing is unavailable', async () => {
    const bridge = fakeBridge();
    bridge.share = vi.fn(async (): Promise<ShareOutcome> => ({ result: 'unavailable' }));
    renderApp({ api: fakeApi(), bridge });
    await userEvent.click(await screen.findByRole('button', { name: /Готовность к открытию/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Поделиться с партнёром' }));
    expect(await screen.findByText(/Не удалось открыть окно отправки/)).toBeTruthy();
  });

  it('stays quiet when the user closes the MAX share sheet', async () => {
    const bridge = fakeBridge();
    bridge.share = vi.fn(async (): Promise<ShareOutcome> => ({ result: 'cancelled' }));
    renderApp({ api: fakeApi(), bridge });
    await userEvent.click(await screen.findByRole('button', { name: /Готовность к открытию/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Поделиться с партнёром' }));
    expect(screen.queryByText(/Не удалось открыть окно отправки/)).toBeNull();
    expect(screen.queryByText(/скопирован/)).toBeNull();
  });

  it('does not open a second share sheet while the first one is in progress', async () => {
    let finish!: (outcome: ShareOutcome) => void;
    const bridge = fakeBridge();
    bridge.share = vi.fn(() => new Promise<ShareOutcome>((resolve) => (finish = resolve)));
    renderApp({ api: fakeApi(), bridge });
    await userEvent.click(await screen.findByRole('button', { name: /Готовность к открытию/ }));
    const button = await screen.findByRole('button', { name: 'Поделиться с партнёром' });

    await userEvent.click(button);
    await userEvent.click(button);
    expect(bridge.share).toHaveBeenCalledTimes(1);
    // While the sheet is open the button keeps the focus and its name.
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole('button', { name: 'Поделиться с партнёром' })).toBe(button);

    finish({ result: 'shared' });
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull());
    expect(button.getAttribute('aria-disabled')).toBeNull();
  });

  it('explains the failure when sharing breaks, and lets the user try again', async () => {
    const bridge = fakeBridge();
    bridge.share = vi.fn(async (): Promise<ShareOutcome> => {
      throw new Error('bridge is gone');
    });
    renderApp({ api: fakeApi(), bridge });
    await userEvent.click(await screen.findByRole('button', { name: /Готовность к открытию/ }));
    const button = await screen.findByRole('button', { name: 'Поделиться с партнёром' });

    await userEvent.click(button);
    expect(await screen.findByText(/Не удалось открыть окно отправки/)).toBeTruthy();
    expect(button.getAttribute('aria-disabled')).toBeNull();
    await userEvent.click(button);
    expect(bridge.share).toHaveBeenCalledTimes(2);
  });

  it('records why sharing failed, so pilot analytics can tell a cancel from a client error', async () => {
    const api = fakeApi();
    const bridge = fakeBridge();
    bridge.share = vi.fn(async (): Promise<ShareOutcome> => ({ result: 'cancelled', error: 'client.web_app_share.failed' }));
    renderApp({ api, bridge });
    await userEvent.click(await screen.findByRole('button', { name: /Готовность к открытию/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Поделиться с партнёром' }));
    await waitFor(() =>
      expect(api.sendEvent).toHaveBeenCalledWith('share_clicked', { shared: false, result: 'cancelled', error: 'client.web_app_share.failed' }),
    );
  });
});

describe('«Объясни проще»', () => {
  it('is hidden when the feature is off', async () => {
    renderApp({ api: fakeApi(), startParam: 'register' });
    await screen.findByText('Зачем');
    expect(screen.queryByRole('button', { name: 'Объясни проще' })).toBeNull();
  });

  it('shows a generated explanation, clearly marked, when the feature is on', async () => {
    const api = fakeApi({ getConfig: vi.fn(async () => ({ features: { explain: true } })) });
    renderApp({ api, startParam: 'register' });
    await userEvent.click(await screen.findByRole('button', { name: 'Объясни проще' }));
    expect(await screen.findByText('Сначала оформите ИП.')).toBeTruthy();
    expect(screen.getByText(/сгенерировано ИИ/)).toBeTruthy();
  });

  it('says the explanation is unavailable on an error', async () => {
    const api = fakeApi({
      getConfig: vi.fn(async () => ({ features: { explain: true } })),
      explainTask: vi.fn(async () => { throw new ApiError(503, 'explanation_unavailable', 'нет'); }),
    });
    renderApp({ api, startParam: 'register' });
    await userEvent.click(await screen.findByRole('button', { name: 'Объясни проще' }));
    expect(await screen.findByText(/Пояснение недоступно/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Выполнено' })).toBeTruthy();
  });
});

describe('the route screen', () => {
  const route = (openingDate = profile.opening_date) => {
    const built = buildRoute(pack, { ...profile, opening_date: openingDate }, '2026-09-18', {});
    if (built.status !== 'ok') throw new Error('route expected');
    return toRouteView(built.route, pack);
  };

  it('reads a route without the forecast (an older API) as one whose opening can be met: no warning', () => {
    const { projectedOpeningDate: _, ...older } = route('2026-09-25');
    render(
      <ThemeProvider>
        <RouteScreen route={older as RouteView} onOpenTask={() => {}} onOpenReadiness={() => {}} />
      </ThemeProvider>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'До открытия 7 дней' })).toBeTruthy();
    expect(screen.queryByText(/не успеть|откроетесь/)).toBeNull();
  });

  it.each([
    [44, 'До открытия 44 дня'],
    [1, 'До открытия 1 день'],
    [0, 'Открытие сегодня'],
    [-3, 'Дата открытия прошла 3 дня назад'],
  ])('reads %i days to the opening as one heading', (days, name) => {
    render(
      <ThemeProvider>
        <RouteScreen route={{ ...route(), daysToOpening: days }} onOpenTask={() => {}} onOpenReadiness={() => {}} />
      </ThemeProvider>,
    );
    expect(screen.getByRole('heading', { level: 1, name })).toBeTruthy();
  });
});

describe('the readiness screen', () => {
  it('says so when no required step is left, and counts them all done', () => {
    const built = buildRoute(pack, profile, '2026-09-18', { register: 'done', kkt: 'done' });
    if (built.status !== 'ok') throw new Error('route expected');
    render(
      <ThemeProvider>
        <ReadinessScreen route={toRouteView(built.route, pack)} statusCard="Готовность к открытию: 66%" onBack={() => {}} onOpenTask={() => {}} onShare={async () => 'shared'} />
      </ThemeProvider>,
    );
    const title = screen.getByRole('heading', { level: 1, name: 'готовность к открытию 66%' });
    // The ring goes round as far as the percent: two thirds of a turn.
    expect(title.parentElement!.style.getPropertyValue('--ready-arc')).toBe('66%');
    expect(screen.getByText('Обязательных 2 из 2')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Обязательное выполнено' })).toBeTruthy();
    expect(screen.queryByText('Осталось обязательного')).toBeNull();
  });
});

describe('taskStatusText', () => {
  const task: TaskSummary = {
    id: 'sout', title: 'Провести СОУТ', lane: 'ops', kind: 'test_data', status: 'todo', latestStart: '2027-09-11',
    floatDays: 300, overdue: false, onCriticalPath: false, waitingFor: [],
  };

  it('names the month, and adds the year only to start dates outside the current year', () => {
    expect(taskStatusText(task, '2026-09-23')).toBe('Начать до 11 сентября 2027');
    expect(taskStatusText({ ...task, latestStart: '2026-10-05' }, '2026-09-23')).toBe('Начать до 5 октября');
  });
});

describe('readLaunchContext', () => {
  it('returns null outside MAX and reads the user and start param inside', () => {
    expect(readLaunchContext(undefined)).toBeNull();
    expect(readLaunchContext({ initData: 'x', initDataUnsafe: { user: { id: 7 }, start_param: 'kkt' }, platform: 'web' })).toEqual({
      initData: 'x', user: { id: 7 }, startParam: 'kkt', platform: 'web',
    });
  });
});
