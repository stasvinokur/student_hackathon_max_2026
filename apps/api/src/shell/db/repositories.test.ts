import type { OnboardingState, Profile } from '@otkryvay/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { createRepositories, type Repositories } from './repositories.js';
import { openTestDatabase, truncateAll } from './test-database.js';

const database: Database | null = await openTestDatabase();
const USER = 103194277;
const profile: Profile = {
  format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 0, sells_food: false, opening_date: '2026-11-20',
};

describe.skipIf(!database)('repositories (integration)', () => {
  let repos: Repositories;

  beforeAll(() => {
    repos = createRepositories(database!.db);
  });
  beforeEach(async () => {
    await truncateAll(database!);
  });
  afterAll(async () => {
    await database?.close();
  });

  async function newRoute(actionIds = ['register', 'kkt', 'lease']) {
    await repos.users.touch(USER);
    return repos.routes.replaceForUser(USER, { packId: 'kazan-coffee', packVersion: '1.0.0', profile, actionIds });
  }

  it('registers a user once and updates last_seen_at', async () => {
    await repos.users.touch(USER);
    await repos.users.touch(USER);
    const rows = await database!.db.execute(sql`select count(*)::int as n from users`);
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('saves and reads onboarding state', async () => {
    await repos.users.touch(USER);
    expect(await repos.onboarding.get(USER)).toBeNull();

    const state: OnboardingState = { step: 'city', answers: { format: 'cafe' } };
    await repos.onboarding.save(USER, state);
    await repos.onboarding.save(USER, { ...state, step: 'legal_status' });
    expect(await repos.onboarding.get(USER)).toEqual({ step: 'legal_status', answers: { format: 'cafe' } });
  });

  it('stores a route with pack version and todo tasks, and replaces it on re-onboarding', async () => {
    const first = await newRoute();
    await repos.tasks.setStatus(first, 'register', 'done', new Date());
    await repos.reminders.schedule({ userId: USER, routeId: first, actionId: 'kkt', kind: 'next_step', dueAt: new Date() });

    const stored = await repos.routes.getForUser(USER);
    expect(stored).toMatchObject({ id: first, packId: 'kazan-coffee', packVersion: '1.0.0', profile, actionIds: ['register', 'kkt', 'lease'] });
    expect(stored?.statuses).toEqual({ register: 'done', kkt: 'todo', lease: 'todo' });

    const second = await repos.routes.replaceForUser(USER, { packId: 'kazan-coffee', packVersion: '1.1.0', profile, actionIds: ['register'] });
    expect(second).not.toBe(first);
    expect((await repos.routes.getForUser(USER))?.statuses).toEqual({ register: 'todo' });
    const leftovers = await database!.db.execute(sql`select count(*)::int as n from reminders`);
    expect(leftovers[0]).toEqual({ n: 0 });
  });

  it('moves the opening date of a route in place: the id, the marks and created_at stay', async () => {
    const routeId = await newRoute();
    await repos.tasks.setStatus(routeId, 'register', 'done', new Date('2026-09-20T10:00:00Z'));
    // Built a week ago: the KPI «3 шага за 7 дней» counts from created_at, which a move must not reset.
    const builtAt = '2026-09-13 10:00:00+00';
    await database!.db.execute(sql`update routes set created_at = ${builtAt}::timestamptz, updated_at = ${builtAt}::timestamptz`);

    expect(await repos.routes.setOpeningDate(routeId, '2026-11-20', '2026-12-08')).toBe(true);

    const stored = await repos.routes.getForUser(USER);
    expect(stored).toMatchObject({ id: routeId, profile: { ...profile, opening_date: '2026-12-08' }, actionIds: ['register', 'kkt', 'lease'] });
    expect(stored?.statuses).toEqual({ register: 'done', kkt: 'todo', lease: 'todo' });
    const [times] = await database!.db.execute<{ kept: boolean; touched: boolean }>(
      sql`select created_at = ${builtAt}::timestamptz as kept, updated_at > ${builtAt}::timestamptz as touched from routes`,
    );
    expect(times).toEqual({ kept: true, touched: true });

    expect(await repos.routes.setOpeningDate(routeId + 999, '2026-12-08', '2026-12-20')).toBe(false);
  });

  it('moves the opening date only from the date it was decided on', async () => {
    const routeId = await newRoute();
    // Another press has moved the date already: a move decided on the old one must not write over it.
    expect(await repos.routes.setOpeningDate(routeId, '2026-10-26', '2026-12-08')).toBe(false);
    expect((await repos.routes.getForUser(USER))?.profile.opening_date).toBe('2026-11-20');
  });

  it('updates task status only for tasks of the route', async () => {
    const routeId = await newRoute();
    const now = new Date('2026-09-20T10:00:00Z');
    expect(await repos.tasks.setStatus(routeId, 'kkt', 'done', now)).toBe(true);
    expect(await repos.tasks.setStatus(routeId, 'not-in-route', 'done', now)).toBe(false);
    expect(await repos.tasks.setStatus(routeId + 999, 'kkt', 'done', now)).toBe(false);
    expect((await repos.routes.getForUser(USER))?.statuses.kkt).toBe('done');
  });

  it('claims only due, pending reminders and supports retry and cancellation', async () => {
    const routeId = await newRoute();
    const now = new Date('2026-09-20T10:00:00Z');
    const due = await repos.reminders.schedule({ userId: USER, routeId, actionId: 'kkt', kind: 'next_step', dueAt: new Date('2026-09-20T09:00:00Z') });
    await repos.reminders.schedule({ userId: USER, routeId, actionId: 'lease', kind: 'deadline', dueAt: new Date('2026-09-21T09:00:00Z') });
    const cancelled = await repos.reminders.schedule({ userId: USER, routeId, actionId: 'register', kind: 'next_step', dueAt: new Date('2026-09-20T08:00:00Z') });
    expect(await repos.reminders.cancelForTask(routeId, 'register', now)).toBe(1);

    const claimed = await repos.reminders.claimDue(now, 10, 60_000);
    expect(claimed.map((r) => r.id)).toEqual([due]);
    expect(claimed[0]?.attempts).toBe(1);
    expect(claimed.map((r) => r.id)).not.toContain(cancelled);

    // Leased: not claimable again until the lease expires.
    expect(await repos.reminders.claimDue(now, 10, 60_000)).toEqual([]);

    await repos.reminders.markFailed(due, '429 Too Many Requests', new Date('2026-09-20T10:05:00Z'));
    expect(await repos.reminders.claimDue(new Date('2026-09-20T10:04:00Z'), 10, 60_000)).toEqual([]);
    const retried = await repos.reminders.claimDue(new Date('2026-09-20T10:06:00Z'), 10, 60_000);
    expect(retried).toMatchObject([{ id: due, attempts: 2, lastError: '429 Too Many Requests' }]);

    await repos.reminders.markSent(due, new Date('2026-09-20T10:06:01Z'));
    expect(await repos.reminders.claimDue(new Date('2026-09-22T00:00:00Z'), 10, 60_000)).toMatchObject([{ actionId: 'lease' }]);
  });

  it('hands each reminder to exactly one of several concurrent workers', async () => {
    const routeId = await newRoute();
    const now = new Date('2026-09-20T10:00:00Z');
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(await repos.reminders.schedule({ userId: USER, routeId, actionId: 'kkt', kind: 'next_step', dueAt: new Date(now.getTime() - i * 1000) }));
    }

    const batches = await Promise.all(Array.from({ length: 6 }, () => repos.reminders.claimDue(now, 10, 60_000)));
    const claimed = batches.flat().map((r) => r.id);

    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.sort((a, b) => a - b)).toEqual(ids.sort((a, b) => a - b));
  });

  it('records analytics events', async () => {
    await repos.events.record('bot_started', USER);
    await repos.events.record('route_built', USER, { actions: 3, pack: 'kazan-coffee' });
    const rows = await database!.db.execute(sql`select type, props from events order by id`);
    expect(rows).toEqual([
      { type: 'bot_started', props: {} },
      { type: 'route_built', props: { actions: 3, pack: 'kazan-coffee' } },
    ]);
  });
});
