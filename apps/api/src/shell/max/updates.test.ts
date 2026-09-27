import type { Update } from '@maxhub/max-bot-api/types';
import { asc, isNull, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock, type Clock } from '../clock.js';
import { createPackRegistry, type PackRegistry } from '../content/packs.js';
import { loadRulesPack } from '../content/load.js';
import type { Database } from '../db/client.js';
import { createRepositories, type Repositories } from '../db/repositories.js';
import { reminders } from '../db/schema.js';
import { openTestDatabase, truncateAll } from '../db/test-database.js';
import { createOnboardingService, type OnboardingService } from '../services/onboarding.js';
import { createReminderService } from '../services/reminders.js';
import { createRouteService } from '../services/routes.js';
import { createUpdateHandler, frozenAttachments, toOnboardingInput, type UpdateHandler, type UpdateHandlerDeps } from './updates.js';

const log = pino({ level: 'silent' });
const USER = 103194277;
const clock = fixedClock('2026-09-18T09:00:00Z');

// ---------- MAX update builders ----------
const started = (): Update => ({ update_type: 'bot_started', timestamp: 1, chat_id: 1, user: { user_id: USER } }) as Update;
const text = (t: string, chatType = 'dialog'): Update =>
  ({
    update_type: 'message_created',
    timestamp: 1,
    message: { sender: { user_id: USER, is_bot: false }, recipient: { chat_id: 1, chat_type: chatType, user_id: null }, timestamp: 1, body: { mid: 'm', seq: 1, text: t } },
  }) as unknown as Update;
const geo = (latitude: number, longitude: number): Update =>
  ({
    update_type: 'message_created',
    timestamp: 1,
    message: {
      sender: { user_id: USER, is_bot: false }, recipient: { chat_id: 1, chat_type: 'dialog', user_id: null }, timestamp: 1,
      body: { mid: 'm', seq: 1, text: null, attachments: [{ type: 'location', latitude, longitude }] },
    },
  }) as unknown as Update;
const press = (payload: string, questionText = 'Вопрос', label = 'Ответ'): Update =>
  ({
    update_type: 'message_callback',
    timestamp: 1,
    callback: { timestamp: 1, callback_id: `cb-${payload}`, payload, user: { user_id: USER } },
    message: {
      recipient: { chat_id: 1, chat_type: 'dialog', user_id: null }, timestamp: 1,
      body: { mid: 'q', seq: 1, text: questionText, attachments: [{ type: 'inline_keyboard', payload: { buttons: [[{ type: 'callback', text: label, payload }]] } }] },
    },
  }) as unknown as Update;

describe('toOnboardingInput', () => {
  it('maps MAX updates to onboarding inputs', () => {
    expect(toOnboardingInput(started())).toEqual({ userId: USER, input: { type: 'start' } });
    expect(toOnboardingInput(text('/start'))?.input).toEqual({ type: 'start' });
    expect(toOnboardingInput(text(' /restart '))?.input).toEqual({ type: 'restart' });
    expect(toOnboardingInput(text('Казань'))?.input).toEqual({ type: 'text', text: 'Казань' });
    expect(toOnboardingInput(geo(55.79, 49.12))?.input).toEqual({ type: 'location', latitude: 55.79, longitude: 49.12 });
    expect(toOnboardingInput(press('ob:format:cafe'))?.input).toEqual({ type: 'callback', payload: 'ob:format:cafe' });
  });

  it('ignores group chats and unrelated updates', () => {
    expect(toOnboardingInput(text('привет', 'chat'))).toBeNull();
    expect(toOnboardingInput({ update_type: 'bot_stopped', timestamp: 1, chat_id: 1, user: { user_id: USER } } as Update)).toBeNull();
  });
});

describe('frozenAttachments', () => {
  it('drops answer buttons but keeps the mini-app button', () => {
    const message = {
      body: {
        attachments: [
          {
            type: 'inline_keyboard',
            payload: {
              buttons: [
                [{ type: 'open_app', text: 'Открыть маршрут', web_app: 'bot' }],
                [{ type: 'callback', text: 'Начать с №1', payload: 'route:first' }],
              ],
            },
          },
        ],
      },
    } as never;
    expect(frozenAttachments(message)).toEqual([
      { type: 'inline_keyboard', payload: { buttons: [[{ type: 'open_app', text: 'Открыть маршрут', web_app: 'bot' }]] } },
    ]);
    expect(frozenAttachments(press('ob:format:cafe').update_type === 'message_callback' ? (press('ob:format:cafe') as never as { message: never }).message : null)).toEqual([]);
  });
});

const database: Database | null = await openTestDatabase();

describe.skipIf(!database)('MAX onboarding through the update handler (integration)', () => {
  let repos: Repositories;
  let packs: PackRegistry;

  function setup(overrides: { onboarding?: OnboardingService; sendError?: Error; clock?: Clock; log?: UpdateHandlerDeps['log'] } = {}) {
    const sent: { userId: number; text: string; extra: { attachments?: unknown[] } }[] = [];
    const api = {
      sendMessageToUser: vi.fn(async (userId: number, t: string, extra?: { attachments?: unknown[] }) => {
        if (overrides.sendError) throw overrides.sendError;
        sent.push({ userId, text: t, extra: extra ?? {} });
        return {} as never;
      }),
      answerOnCallback: vi.fn(async () => ({ success: true }) as never),
    };
    const now = overrides.clock ?? clock;
    const logger = overrides.log ?? log;
    // As in main.ts: the route service replans the reminders whenever the route changes.
    const routes = createRouteService({ repos, packs, clock: now, reminders: createReminderService({ repos, clock: now, delaySeconds: 60 }) });
    const onboarding = overrides.onboarding ?? createOnboardingService({ repos, routes, packs, clock: now, log: logger });
    const handle = createUpdateHandler({ api: api as unknown as UpdateHandlerDeps['api'], onboarding, render: { webApp: 't750_hakaton_max_bot' }, log: logger });
    return { handle, api, sent, routes };
  }

  /** The questions answered as the newbie of the pack fixtures: coffee-to-go, not registered, searching premises, alone, drinks only. */
  async function answerAsNewbie(handle: UpdateHandler, openingDate: string) {
    for (const update of [press('ob:format:to_go'), text('Казань'), press('ob:legal_status:none'), press('ob:premises:searching'), press('ob:employees:0'), text(openingDate), press('ob:sells_food:false')]) {
      await handle(update);
    }
  }

  async function recordedEvents() {
    return database!.db.execute<{ type: string; props: Record<string, unknown> }>(sql`select type, props from events order by id`);
  }

  /** Reminders still to be sent, in the order they were planned. */
  async function pendingReminders() {
    const rows = await database!.db.select().from(reminders).where(isNull(reminders.cancelledAt)).orderBy(asc(reminders.id));
    return rows.map((r) => ({ actionId: r.actionId, kind: r.kind, dueAt: r.dueAt.toISOString() }));
  }

  const buttonsOf = (message: { extra: { attachments?: unknown[] } } | undefined) => JSON.stringify(message?.extra.attachments ?? []);

  beforeAll(async () => {
    repos = createRepositories(database!.db);
    packs = createPackRegistry([await loadRulesPack('kazan-coffee')]);
  });
  beforeEach(async () => {
    await truncateAll(database!);
  });
  afterAll(async () => {
    await database?.close();
  });

  it('walks from bot_started to the route summary and stores the route', async () => {
    const { handle, sent, api, routes } = setup();
    await handle(started());
    expect(sent.at(-1)?.text).toContain('Вопрос 1 из 7');

    await handle(press('ob:format:to_go', 'Вопрос 1 из 7. Что открываете?', 'Coffee-to-go без посадки'));
    expect(api.answerOnCallback).toHaveBeenCalledWith('cb-ob:format:to_go', {
      message: { text: 'Вопрос 1 из 7. Что открываете?\n\n✓ Coffee-to-go без посадки', attachments: [] },
    });

    await handle(geo(55.79, 49.12)); // Kazan by geolocation
    await handle(press('ob:legal_status:none'));
    await handle(press('ob:premises:searching'));
    await handle(press('ob:employees:0'));
    await handle(text('15.12.2026'));
    await handle(press('ob:sells_food:false'));

    const summary = sent.at(-1)!;
    expect(summary.userId).toBe(USER);
    expect(summary.text).toContain('До открытия 88 дней. Найдено 19 действий.');
    expect(summary.text).toContain('Три действия могут сорвать запуск:');
    expect(summary.text).toContain('1. Зарегистрировать ИП или ООО с кодами общепита');
    expect(JSON.stringify(summary.extra.attachments)).toContain('"type":"open_app"');

    const stored = await repos.routes.getForUser(USER);
    expect(stored).toMatchObject({ packId: 'kazan-coffee', packVersion: '1.1.2', profile: { city: 'kazan', opening_date: '2026-12-15' } });
    expect(stored?.actionIds).toHaveLength(19);
    expect((await routes.getRouteView(USER))?.blockers.map((b) => b.id)).toEqual(['register-business', 'lease-premises', 'fit-out']);

    // «Начать с №1» — the first blocker as a chat card with a deep link to it.
    await handle(press('route:first'));
    expect(sent.at(-1)?.text).toContain('Шаг: Зарегистрировать ИП или ООО с кодами общепита');
    expect(JSON.stringify(sent.at(-1)?.extra.attachments)).toContain('"payload":"register-business"');
  });

  it('accepts the city typed by hand and survives an API restart mid-dialog', async () => {
    const first = setup();
    await first.handle(started());
    await first.handle(press('ob:format:cafe'));
    await first.handle(text('Казань'));

    // A fresh handler/service (process restart) continues from the saved step.
    const second = setup();
    await second.handle(text('/start'));
    expect(second.sent.at(-1)?.text).toContain('Продолжим');
    expect(second.sent.at(-1)?.text).toContain('Вопрос 3 из 7');
    expect(await repos.onboarding.get(USER)).toEqual({ step: 'legal_status', answers: { format: 'cafe', city: 'kazan' } });
  });

  it('records analytics events for the funnel', async () => {
    const { handle } = setup();
    for (const update of [started(), press('ob:format:to_go'), text('Казань'), press('ob:legal_status:ip'), press('ob:premises:signed'), press('ob:employees:3'), text('20.10.2026'), press('ob:sells_food:true')]) {
      await handle(update);
    }
    expect((await recordedEvents()).map((e) => e.type)).toEqual(['bot_started', 'onboarding_completed', 'route_built']);
  });

  describe('an opening date that cannot be met', () => {
    // From 18 September the newbie opens no earlier than 30 November: registration → lease → fit-out → fire safety take
    // 73 days (the pack fixtures newbie-in-a-month and opening-today). With registration done, 66 days: 23 November.
    const OFFER = 'route:reschedule:2026-10-18:2026-11-30';

    it('offers to move it, and the button moves the date of the same route: the marks stay, the reminders follow', async () => {
      const { handle, sent, routes } = setup();
      await handle(started());
      await answerAsNewbie(handle, '18.10.2026');

      // The summary, then the offer as a message of its own.
      const [summary, offer] = sent.slice(-2);
      expect(summary?.text).toContain('До открытия 30 дней. Найдено 19 действий.\nК 18 октября не успеть — если начать сегодня, откроетесь 30 ноября.');
      expect(buttonsOf(summary)).toContain('"payload":"route:first"');
      expect(offer?.text).toBe('Перенести дату открытия на 30 ноября? Отметки выполненных шагов сохранятся.');
      expect(buttonsOf(offer)).toContain(`"payload":"${OFFER}"`);
      expect(buttonsOf(offer)).toContain('"payload":"route:keep:2026-10-18"');

      // Registration is done before the answer: 18 October still cannot be met, the dates count from 23 November.
      const built = (await repos.routes.getForUser(USER))!;
      await routes.setTaskStatus(USER, 'register-business', 'done');
      expect(await pendingReminders()).toEqual([
        { actionId: 'lease-premises', kind: 'next_step', dueAt: '2026-09-18T09:01:00.000Z' },
        { actionId: 'fit-out', kind: 'deadline', dueAt: '2026-10-16T07:00:00.000Z' },
        { actionId: 'production-control', kind: 'deadline', dueAt: '2026-11-03T07:00:00.000Z' },
      ]);

      await handle(press(OFFER, offer!.text, 'Перенести на 30 ноября'));
      expect(sent.at(-1)?.text).toContain('открытие — 30 ноября, до него 73 дня');
      expect(sent.at(-1)?.text).toContain('Следующий шаг: Найти и арендовать помещение, пригодное для общепита — начать до 25.09');
      const moved = await repos.routes.getForUser(USER);
      expect(moved).toMatchObject({ id: built.id, actionIds: built.actionIds, profile: { ...built.profile, opening_date: '2026-11-30' } });
      expect(moved?.statuses).toEqual({ ...built.statuses, 'register-business': 'done' });
      // The deadlines now count from 30 November: a week later than from 23 November.
      expect(await pendingReminders()).toEqual([
        { actionId: 'lease-premises', kind: 'next_step', dueAt: '2026-09-18T09:01:00.000Z' },
        { actionId: 'fit-out', kind: 'deadline', dueAt: '2026-10-23T07:00:00.000Z' },
        { actionId: 'production-control', kind: 'deadline', dueAt: '2026-11-10T07:00:00.000Z' },
      ]);

      // Pressed again: the date is already the one offered.
      await handle(press(OFFER));
      expect(sent.at(-1)?.text).toBe('Дата открытия уже 30 ноября.');
      expect((await repos.routes.getForUser(USER))?.profile.opening_date).toBe('2026-11-30');

      expect(await recordedEvents()).toEqual([
        { type: 'bot_started', props: {} },
        { type: 'onboarding_completed', props: { city: 'kazan', format: 'to_go' } },
        { type: 'route_built', props: { pack: 'kazan-coffee', actions: 19, critical: 9, daysToOpening: 30, delayDays: 43 } },
        { type: 'opening_rescheduled', props: { shiftDays: 43, slipped: false } },
      ]);
    });

    it('moves the date once when the button is pressed twice at once', async () => {
      // Webhook updates are handled as they come, not one after another: both presses may decide before either writes.
      const { handle, sent } = setup();
      await handle(started());
      await answerAsNewbie(handle, '18.10.2026');
      const before = sent.length;
      // Connections already open, as on a running server: on a cold pool the second press waits for a connection
      // while the first one goes through, and the presses never meet.
      await Promise.all([1, 2, 3].map(() => database!.db.execute(sql`select pg_sleep(0.01)`)));

      await Promise.all([handle(press(OFFER)), handle(press(OFFER))]);

      const answers = sent.slice(before).map((m) => m.text);
      expect(answers).toHaveLength(2);
      expect(answers.filter((t) => t.startsWith('Готово: открытие — 30 ноября'))).toHaveLength(1);
      expect(answers.filter((t) => t === 'Дата открытия уже 30 ноября.')).toHaveLength(1);
      expect((await recordedEvents()).filter((e) => e.type === 'opening_rescheduled')).toEqual([
        { type: 'opening_rescheduled', props: { shiftDays: 43, slipped: false } },
      ]);
      // One plan of reminders, the one of the moved route: 30 November leaves no spare day, the next step is registration.
      expect(await pendingReminders()).toEqual([
        { actionId: 'register-business', kind: 'next_step', dueAt: '2026-09-18T09:01:00.000Z' },
        { actionId: 'lease-premises', kind: 'deadline', dueAt: '2026-09-23T07:00:00.000Z' },
        { actionId: 'fit-out', kind: 'deadline', dueAt: '2026-10-23T07:00:00.000Z' },
      ]);
    });

    it('moves a days-old offer further when its date cannot be met either', async () => {
      const first = setup();
      await first.handle(started());
      await answerAsNewbie(first.handle, '18.10.2026');

      // A week later, nothing done: 30 November cannot be met any more, 7 December can.
      const later = setup({ clock: fixedClock('2026-09-25T09:00:00Z') });
      await later.handle(press(OFFER));
      expect(later.sent.at(-1)?.text).toContain('30 ноября уже не успеть — перенесли открытие на 7 декабря, до него 73 дня');
      expect(later.sent.at(-1)?.text).toContain('Следующий шаг: Зарегистрировать ИП или ООО с кодами общепита — начать сегодня');
      expect((await repos.routes.getForUser(USER))?.profile.opening_date).toBe('2026-12-07');
      expect((await recordedEvents()).at(-1)).toEqual({ type: 'opening_rescheduled', props: { shiftDays: 50, slipped: true } });
    });

    it('tells a button of the replaced route from one of the current route, and keeps the date by «Оставить»', async () => {
      const { handle, sent } = setup();
      await handle(started());
      await answerAsNewbie(handle, '18.10.2026');
      await handle(text('/restart'));
      await answerAsNewbie(handle, '25.10.2026');
      expect(buttonsOf(sent.at(-1))).toContain('"payload":"route:keep:2026-10-25"');

      // The buttons of the first route are stale: its date is no longer the one stored.
      await handle(press(OFFER));
      expect(sent.at(-1)?.text).toBe('Эта кнопка устарела: в маршруте уже другая дата открытия — 25 октября.');
      await handle(press('route:keep:2026-10-18'));
      expect(sent.at(-1)?.text).toBe('Эта кнопка устарела: в маршруте уже другая дата открытия — 25 октября.');

      await handle(press('route:keep:2026-10-25'));
      expect(sent.at(-1)?.text).toBe('Оставили 25 октября. Сроки шагов посчитаны так, чтобы открыться как можно раньше — 30 ноября.');
      expect((await repos.routes.getForUser(USER))?.profile.opening_date).toBe('2026-10-25');

      const events = await recordedEvents();
      expect(events.map((e) => e.type)).toEqual([
        'bot_started', 'onboarding_completed', 'route_built', 'onboarding_restarted', 'onboarding_completed', 'route_built', 'opening_kept',
      ]);
      expect(events.at(-2)?.props).toMatchObject({ daysToOpening: 37, delayDays: 36 });
      expect(events.at(-1)?.props).toEqual({ delayDays: 36 });
    });

    it('leaves a route button pressed in the middle of the questions to the question, and the stored route as it is', async () => {
      const { handle, sent } = setup();
      await handle(started());
      await answerAsNewbie(handle, '18.10.2026');
      await handle(text('/restart'));
      await handle(press('ob:format:to_go'));

      for (const payload of [OFFER, 'route:keep:2026-10-18']) {
        await handle(press(payload));
        expect(sent.at(-1)?.text).toContain('Эта кнопка относится к другому вопросу. Ответьте, пожалуйста, на текущий:');
        expect(sent.at(-1)?.text).toContain('Вопрос 2 из 7');
      }
      expect((await repos.routes.getForUser(USER))?.profile.opening_date).toBe('2026-10-18');
      expect(await repos.onboarding.get(USER)).toEqual({ step: 'city', answers: { format: 'to_go' } });
      expect((await recordedEvents()).map((e) => e.type)).not.toContain('opening_rescheduled');
    });

    it('answers a route button with no route, and ignores a route payload it does not know', async () => {
      const quiet = pino({ level: 'silent' });
      const warn = vi.spyOn(quiet, 'warn');
      const { handle, sent } = setup({ log: quiet });

      await handle(press('route:keep:2026-10-18'));
      expect(sent.at(-1)?.text).toBe('Маршрута пока нет — пройдите вопросы заново.');
      expect(buttonsOf(sent.at(-1))).toContain('"payload":"ob:restart"');

      const before = sent.length;
      for (const payload of ['route:reschedule:2026-02-30:2026-12-08', 'route:keep:soon', 'route:unknown']) await handle(press(payload));
      expect(sent).toHaveLength(before);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledWith({ userId: USER, payload: 'route:unknown' }, 'unknown route button');
      expect(await repos.onboarding.get(USER)).toBeNull();
    });
  });

  it('counts a first contact by a typed message as the start of the dialog', async () => {
    const { handle } = setup();
    await handle(text('привет'));
    await handle(text('/start'));
    expect((await recordedEvents()).map((e) => e.type)).toEqual(['bot_started']); // once per user, whatever came first
  });

  it('apologises instead of going silent when processing fails', async () => {
    const failing: OnboardingService = { handle: async () => { throw new Error('db is down'); } };
    const { handle, sent } = setup({ onboarding: failing });
    await expect(handle(text('привет'))).resolves.toBeUndefined();
    expect(sent.at(-1)?.text).toContain('Что-то пошло не так');
  });

  it('does not throw when MAX rejects messages (rate limit, network)', async () => {
    const { handle, api } = setup({ sendError: new Error('429 Too Many Requests') });
    await expect(handle(started())).resolves.toBeUndefined();
    expect(api.sendMessageToUser).toHaveBeenCalledTimes(2); // the reply and the failure notice
    expect(await repos.onboarding.get(USER)).toEqual({ step: 'format', answers: {} }); // state saved anyway
  });
});
