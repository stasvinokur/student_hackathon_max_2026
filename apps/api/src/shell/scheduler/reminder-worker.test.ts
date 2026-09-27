import type { Profile } from '@otkryvay/core';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../clock.js';
import { loadRulesPack } from '../content/load.js';
import { createPackRegistry, type PackRegistry } from '../content/packs.js';
import type { Database } from '../db/client.js';
import { createRepositories, type Repositories } from '../db/repositories.js';
import { openTestDatabase, truncateAll } from '../db/test-database.js';
import { createReminderService } from '../services/reminders.js';
import { createRouteService, type RouteService } from '../services/routes.js';
import { createReminderWorker } from './reminder-worker.js';

const database: Database | null = await openTestDatabase();
const USER = 103194277;
const log = pino({ level: 'silent' });
const profile: Profile = {
  format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 0, sells_food: false, opening_date: '2026-12-15',
};

/** A clock the test moves forward by hand. */
function manualClock(startIso: string) {
  let now = new Date(startIso);
  const clock: Clock & { advance(seconds: number): void } = {
    now: () => now,
    today: () => now.toISOString().slice(0, 10),
    advance: (seconds) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
  return clock;
}

describe.skipIf(!database)('reminder worker (integration)', () => {
  let repos: Repositories;
  let packs: PackRegistry;

  beforeAll(async () => {
    repos = createRepositories(database!.db);
    packs = createPackRegistry([await loadRulesPack('kazan-coffee')]);
  });
  beforeEach(async () => {
    await truncateAll(database!);
    await repos.users.touch(USER);
  });
  afterAll(async () => {
    await database?.close();
  });

  function setup(sendImpl?: () => Promise<unknown>) {
    const clock = manualClock('2026-09-18T09:00:00Z');
    const reminders = createReminderService({ repos, clock, delaySeconds: 60 });
    const routes: RouteService = createRouteService({ repos, packs, clock, reminders });
    const sent: { userId: number; text: string; extra: unknown }[] = [];
    const sendMessageToUser = vi.fn(async (userId: number, text: string, extra?: unknown) => {
      if (sendImpl) await sendImpl();
      sent.push({ userId, text, extra });
      return {} as never;
    });
    const sleep = vi.fn(async () => {});
    const worker = createReminderWorker({ repos, routes, api: { sendMessageToUser }, render: { webApp: 'bot' }, clock, log, sleep });
    return { clock, routes, worker, sent, sendMessageToUser, sleep };
  }

  it('plans reminders after onboarding and sends the next step with a deep link to its card', async () => {
    const { clock, routes, worker, sent } = setup();
    await routes.createRoute(USER, profile);

    expect(await worker.tick()).toEqual({ sent: 0, skipped: 0, failed: 0 }); // not due yet
    clock.advance(61);
    expect(await worker.tick()).toMatchObject({ sent: 1 });

    expect(sent[0]?.text).toContain('Следующий шаг к открытию:');
    expect(sent[0]?.text).toContain('«Зарегистрировать ИП или ООО с кодами общепита»');
    expect(JSON.stringify(sent[0]?.extra)).toContain('"type":"open_app"');
    expect(JSON.stringify(sent[0]?.extra)).toContain('"payload":"register-business"');
    expect(await worker.tick()).toMatchObject({ sent: 0 }); // sent once
  });

  it('writes the year when the start date falls into the next year', async () => {
    const { clock, routes, worker, sent } = setup();
    await routes.createRoute(USER, { ...profile, opening_date: '2027-06-01' });
    clock.advance(61);
    expect(await worker.tick()).toMatchObject({ sent: 1 });
    expect(sent[0]?.text).toMatch(/Начать до \d{2}\.\d{2}\.2027\./);
  });

  it('replans after a status change and never reminds about a done task', async () => {
    const { clock, routes, worker, sent } = setup();
    await routes.createRoute(USER, profile);
    await routes.setTaskStatus(USER, 'register-business', 'done');

    clock.advance(61);
    await worker.tick();
    expect(sent.map((m) => m.text).join('\n')).not.toContain('Зарегистрировать ИП');
    expect(sent[0]?.text).toContain('«Найти и арендовать помещение, пригодное для общепита»');
  });

  it('skips a reminder whose task was completed after it was planned', async () => {
    const { clock, routes, worker, sendMessageToUser } = setup();
    const created = await routes.createRoute(USER, profile);
    // Mark done directly in storage, bypassing replanning, to simulate a race.
    await repos.tasks.setStatus(created!.routeId, 'register-business', 'done', clock.now());

    clock.advance(61);
    expect(await worker.tick()).toMatchObject({ sent: 0, skipped: 1 });
    expect(sendMessageToUser).not.toHaveBeenCalled();
  });

  it('retries after a temporary failure and gives up after the attempt limit', async () => {
    let failures = 1;
    const { clock, routes, worker, sent } = setup(async () => {
      if (failures-- > 0) throw new Error('429 Too Many Requests');
    });
    await routes.createRoute(USER, profile);
    clock.advance(61);

    expect(await worker.tick()).toMatchObject({ sent: 0, failed: 1 });
    expect(await worker.tick()).toMatchObject({ failed: 0, sent: 0 }); // backoff: not yet
    clock.advance(121);
    expect(await worker.tick()).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);

    // Permanent failure: dropped after 5 attempts instead of retrying forever.
    const broken = setup(async () => {
      throw new Error('403 Forbidden');
    });
    await truncateAll(database!);
    await repos.users.touch(USER);
    await broken.routes.createRoute(USER, profile);
    broken.clock.advance(61);
    for (let i = 0; i < 6; i++) {
      await broken.worker.tick();
      broken.clock.advance(3600);
    }
    expect(broken.sendMessageToUser).toHaveBeenCalledTimes(5);
  });

  it('drops a reminder at once when MAX says the dialog is gone (403/404) and keeps the reason', async () => {
    // MaxError from @maxhub/max-bot-api carries the HTTP status.
    const { clock, routes, worker, sendMessageToUser } = setup(async () => {
      throw Object.assign(new Error('404: Dialog not found'), { status: 404 });
    });
    await routes.createRoute(USER, profile);
    clock.advance(61);

    expect(await worker.tick()).toMatchObject({ sent: 0, failed: 1 });
    for (let i = 0; i < 3; i++) {
      clock.advance(3600);
      await worker.tick();
    }
    expect(sendMessageToUser).toHaveBeenCalledTimes(1);
    const rows = await database!.db.execute<{ attempts: number; last_error: string | null; cancelled: boolean }>(
      sql`select attempts, last_error, cancelled_at is not null as cancelled from reminders where kind = 'next_step'`,
    );
    expect([...rows]).toEqual([{ attempts: 1, last_error: '404: Dialog not found', cancelled: true }]);
  });

  it('paces messages to respect the per-chat rate limit', async () => {
    const { clock, routes, worker, sleep } = setup();
    const created = await routes.createRoute(USER, profile);
    // Two more due reminders for the same chat.
    for (const actionId of ['lease-premises', 'get-ukep']) {
      await repos.reminders.schedule({ userId: USER, routeId: created!.routeId, actionId, kind: 'deadline', dueAt: clock.now() });
    }
    clock.advance(61);
    expect(await worker.tick()).toMatchObject({ sent: 3 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(600);
  });
});
