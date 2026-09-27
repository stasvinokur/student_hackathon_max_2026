import type { Profile } from '@otkryvay/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { createRepositories, type Repositories } from '../db/repositories.js';
import { openTestDatabase, truncateAll } from '../db/test-database.js';
import { computeKpi } from './kpi.js';

const database: Database | null = await openTestDatabase();
const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 0, sells_food: false, opening_date: '2026-12-15' };

describe.skipIf(!database)('computeKpi (integration)', () => {
  let repos: Repositories;

  const event = (userId: number, type: string, at: string, props: Record<string, unknown> = {}) =>
    database!.db.execute(sql`insert into events (user_id, type, props, created_at) values (${userId}, ${type}, ${JSON.stringify(props)}::jsonb, ${at}::timestamptz)`);

  beforeAll(() => {
    repos = createRepositories(database!.db);
  });
  beforeEach(async () => {
    await truncateAll(database!);
  });
  afterAll(async () => {
    await database?.close();
  });

  it('returns empty metrics without data', async () => {
    expect(await computeKpi(database!)).toEqual({
      started: 0, onboarded: 0, activationRate: null, medianTimeToRouteSeconds: null, withRoute: 0,
      threeTasksIn7DaysRate: null, sourceOpenRate: null, reminderReturnRate: null, sharers: 0,
    });
  });

  it('computes the funnel, time-to-route, North Star and engagement', async () => {
    // Four users start; three finish onboarding (routes built after 60, 90 and 150 s).
    for (const [user, seconds] of [[1, 60], [2, 90], [3, 150], [4, null]] as const) {
      await repos.users.touch(user);
      await event(user, 'bot_started', '2026-09-18T10:00:00Z');
      if (seconds !== null) {
        await event(user, 'onboarding_completed', '2026-09-18T10:00:30Z');
        await event(user, 'route_built', new Date(Date.parse('2026-09-18T10:00:00Z') + seconds * 1000).toISOString());
      }
    }
    await database!.db.execute(sql`update users set created_at = '2026-09-18T10:00:00Z'`); // first contact
    // Routes: user 1 closes 3 tasks within 7 days, user 2 closes 3 but one after day 7, user 3 closes none.
    const routeOf = async (user: number) =>
      repos.routes.replaceForUser(user, { packId: 'kazan-coffee', packVersion: '1.0.0', profile, actionIds: ['a', 'b', 'c', 'd'] });
    const [r1, r2] = [await routeOf(1), await routeOf(2)];
    await routeOf(3);
    await database!.db.execute(sql`update routes set created_at = '2026-09-18T10:02:00Z'`);
    for (const [route, task, at] of [[r1, 'a', '2026-09-19'], [r1, 'b', '2026-09-20'], [r1, 'c', '2026-09-24'], [r2, 'a', '2026-09-19'], [r2, 'b', '2026-09-20'], [r2, 'c', '2026-09-30']] as const) {
      await repos.tasks.setStatus(route, task, 'done', new Date(`${at}T12:00:00Z`));
    }
    // Engagement: user 1 opens a source; users 1 and 2 get reminders, only user 1 returns by the deep link; user 2 shares.
    await event(1, 'source_opened', '2026-09-19T09:00:00Z', { task: 'a' });
    await event(1, 'reminder_sent', '2026-09-19T10:00:00Z');
    await event(1, 'miniapp_opened', '2026-09-19T10:05:00Z', { deepLink: true });
    await event(2, 'miniapp_opened', '2026-09-19T08:00:00Z', { deepLink: true }); // before the reminder: does not count
    await event(2, 'reminder_sent', '2026-09-19T10:00:00Z');
    await event(2, 'share_clicked', '2026-09-20T10:00:00Z', { shared: true });
    await event(3, 'share_clicked', '2026-09-20T10:00:00Z', { shared: false });

    expect(await computeKpi(database!)).toEqual({
      started: 4,
      onboarded: 3,
      activationRate: 0.75,
      medianTimeToRouteSeconds: 90,
      withRoute: 3,
      threeTasksIn7DaysRate: 0.333,
      sourceOpenRate: 0.333,
      reminderReturnRate: 0.5,
      sharers: 1,
    });
  });

  it('counts everyone who wrote to the bot as a start and times the route from the first contact', async () => {
    for (const user of [1, 2, 3]) await repos.users.touch(user);
    await database!.db.execute(sql`update users set created_at = '2026-09-18T10:00:00Z'`);
    await event(1, 'bot_started', '2026-09-18T10:00:00Z');
    await event(1, 'onboarding_completed', '2026-09-18T10:00:50Z');
    await event(1, 'route_built', '2026-09-18T10:01:00Z');
    // User 2 began by typing before first contacts were recorded as bot_started: no such event.
    await event(2, 'onboarding_completed', '2026-09-18T10:01:59Z');
    await event(2, 'route_built', '2026-09-18T10:02:00Z');
    // User 3 wrote once and left without a single funnel event.

    expect(await computeKpi(database!)).toMatchObject({ started: 3, onboarded: 2, activationRate: 0.667, medianTimeToRouteSeconds: 90 });
  });

  it('ignores the review accounts used by the jury checks', async () => {
    const reviewer = 1000001;
    await repos.users.touch(reviewer);
    await event(reviewer, 'bot_started', '2026-09-18T10:00:00Z');
    await event(reviewer, 'onboarding_completed', '2026-09-18T10:00:30Z');
    await event(reviewer, 'route_built', '2026-09-18T10:01:00Z');
    await repos.routes.replaceForUser(reviewer, { packId: 'kazan-coffee', packVersion: '1.0.0', profile, actionIds: ['a'] });
    await event(reviewer, 'source_opened', '2026-09-19T09:00:00Z', { task: 'a' });
    await event(reviewer, 'reminder_sent', '2026-09-19T10:00:00Z');
    await event(reviewer, 'miniapp_opened', '2026-09-19T10:05:00Z', { deepLink: true });
    await event(reviewer, 'share_clicked', '2026-09-20T10:00:00Z', { shared: true, result: 'shared' });
    await repos.users.touch(1000002); // new_user: the second review account
    await event(1000002, 'bot_started', '2026-09-18T11:00:00Z');

    expect(await computeKpi(database!)).toEqual({
      started: 0, onboarded: 0, activationRate: null, medianTimeToRouteSeconds: null, withRoute: 0,
      threeTasksIn7DaysRate: null, sourceOpenRate: null, reminderReturnRate: null, sharers: 0,
    });
  });

  it('counts copying the status text as sharing it', async () => {
    await event(5, 'share_clicked', '2026-09-20T10:00:00Z', { shared: false, result: 'copied' });
    await event(6, 'share_clicked', '2026-09-20T10:00:00Z', { shared: false, result: 'cancelled' });
    expect((await computeKpi(database!)).sharers).toBe(1);
  });
});
