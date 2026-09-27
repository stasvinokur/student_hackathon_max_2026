import type { Profile } from '@otkryvay/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../clock.js';
import { loadRulesPack } from '../content/load.js';
import { createPackRegistry, type PackRegistry } from '../content/packs.js';
import type { Database } from '../db/client.js';
import { createRepositories, type Repositories } from '../db/repositories.js';
import { openTestDatabase, truncateAll } from '../db/test-database.js';
import { createRouteService } from './routes.js';

const database: Database | null = await openTestDatabase();
const USER = 1001;
const clock = fixedClock('2026-09-18T09:00:00Z');
// The newbie of the pack fixtures: from 18 September, 18 October cannot be met and 30 November can.
const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 0, sells_food: false, opening_date: '2026-10-18' };
const MOVE = { from: '2026-10-18', to: '2026-11-30' };

describe.skipIf(!database)('moving the opening date against another write (integration)', () => {
  let repos: Repositories;
  let packs: PackRegistry;
  let routeId: number;

  beforeAll(async () => {
    repos = createRepositories(database!.db);
    packs = createPackRegistry([await loadRulesPack('kazan-coffee')]);
  });
  beforeEach(async () => {
    await truncateAll(database!);
    await repos.users.touch(USER);
    routeId = (await createRouteService({ repos, packs, clock }).createRoute(USER, profile))!.routeId;
  });
  afterAll(async () => {
    await database?.close();
  });

  /** The route service whose writes of the opening date run `around` in place of the plain write: another write racing it. */
  function racing(around: (write: () => Promise<boolean>) => Promise<boolean>) {
    const setOpeningDate = vi.fn((id: number, from: string, to: string) => around(() => repos.routes.setOpeningDate(id, from, to)));
    const reschedule = vi.fn(async () => 0);
    const routes = createRouteService({ repos: { ...repos, routes: { ...repos.routes, setOpeningDate } }, packs, clock, reminders: { reschedule } });
    return { routes, setOpeningDate, reschedule };
  }

  it('answers a press that loses to another one as a second press: the date is already the one offered', async () => {
    let first = true;
    const { routes, setOpeningDate, reschedule } = racing(async (write) => {
      // The other press writes first.
      if (first) await repos.routes.setOpeningDate(routeId, MOVE.from, MOVE.to);
      first = false;
      return write();
    });

    expect(await routes.rescheduleOpening(USER, MOVE)).toMatchObject({ status: 'unchanged', route: { openingDate: '2026-11-30' } });
    expect(setOpeningDate).toHaveBeenCalledTimes(1);
    // The reminders are replanned by the press that moved the date.
    expect(reschedule).not.toHaveBeenCalled();
  });

  it('answers stale when the route was replaced before the write', async () => {
    const { routes, reschedule } = racing(async (write) => {
      // A /restart finished with another date.
      await createRouteService({ repos, packs, clock }).createRoute(USER, { ...profile, opening_date: '2026-12-15' });
      return write();
    });
    expect(await routes.rescheduleOpening(USER, MOVE)).toMatchObject({ status: 'stale', route: { openingDate: '2026-12-15' } });
    expect((await repos.routes.getForUser(USER))?.profile.opening_date).toBe('2026-12-15');
    expect(reschedule).not.toHaveBeenCalled();
  });

  it('answers no route when the route was removed before the write', async () => {
    const { routes, reschedule } = racing(async (write) => {
      await database!.db.execute(sql`delete from routes`);
      return write();
    });
    expect(await routes.rescheduleOpening(USER, MOVE)).toEqual({ status: 'no_route' });
    expect(reschedule).not.toHaveBeenCalled();
  });

  it('decides once more only: a date that changes under the second decision as well makes the button stale', async () => {
    const { routes, setOpeningDate, reschedule } = racing(async (write) => {
      // Every write loses: the date changes right before it and is back by the next decision.
      await repos.routes.setOpeningDate(routeId, MOVE.from, '2026-12-01');
      const written = await write();
      await repos.routes.setOpeningDate(routeId, '2026-12-01', MOVE.from);
      return written;
    });

    expect(await routes.rescheduleOpening(USER, MOVE)).toMatchObject({ status: 'stale' });
    expect(setOpeningDate).toHaveBeenCalledTimes(2);
    expect(reschedule).not.toHaveBeenCalled();
  });
});
