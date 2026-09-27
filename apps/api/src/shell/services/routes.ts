import {
  buildRoute,
  decideReschedule,
  nextBestStep,
  readiness,
  toRouteView,
  toTaskDetail,
  toTaskSummary,
  type OpeningMove,
  type Profile,
  type Readiness,
  type RescheduleOutcome,
  type Route,
  type RouteView,
  type RulesPack,
  type TaskDetail,
  type TaskStatus,
  type TaskSummary,
} from '@otkryvay/core';
import type { Clock } from '../clock.js';
import type { PackRegistry } from '../content/packs.js';
import type { Repositories, StoredRoute } from '../db/repositories.js';
import type { ReminderService } from './reminders.js';

export interface TaskUpdate {
  task: TaskDetail;
  readiness: Readiness;
  nextStep: TaskSummary | null;
}

/**
 * Shell service: reads state, calls the functional core, writes results.
 * Routes are recomputed on every read from the stored profile, statuses and today's date.
 */
export function createRouteService(deps: { repos: Repositories; packs: PackRegistry; clock: Clock; reminders?: ReminderService }) {
  const { repos, packs, clock, reminders } = deps;

  function compute(stored: StoredRoute, today = clock.today()): { route: Route; pack: RulesPack } | null {
    const pack = packs.get(stored.packId);
    if (!pack) return null;
    const result = buildRoute(pack, stored.profile, today, stored.statuses);
    return result.status === 'ok' ? { route: result.route, pack } : null;
  }

  async function load(userId: number) {
    const stored = await repos.routes.getForUser(userId);
    if (!stored) return null;
    const computed = compute(stored);
    return computed ? { stored, ...computed } : null;
  }

  /**
   * One decision on a press of «Перенести на …» and its write. Two presses of one button may be handled at once
   * (webhook updates are not queued): the write succeeds only while the date is still the one decided on, and the
   * press that lost decides once more on what is stored by then — a second press, a replaced route, a removed one.
   */
  async function rescheduleOnce(userId: number, move: OpeningMove, retried: boolean): Promise<RescheduleOutcome> {
    const loaded = await load(userId);
    if (!loaded) return { status: 'no_route' };
    const { stored, route, pack } = loaded;

    // The today of the loaded route: the decision, the write and the route recounted after it see the same day.
    const decision = decideReschedule(pack, stored.profile, route.today, stored.statuses, move);
    switch (decision.status) {
      case 'unchanged':
      case 'stale':
        return { status: decision.status, route };
      case 'expired':
        return { status: 'expired', requested: move.to, route };
      case 'move': {
        if (!(await repos.routes.setOpeningDate(stored.id, stored.profile.opening_date, decision.openingDate))) {
          if (!retried) return rescheduleOnce(userId, move, true);
          // The date changed under the second decision as well: whatever it is now, the button was not made for it.
          const current = await load(userId);
          return current ? { status: 'stale', route: current.route } : { status: 'no_route' };
        }
        const fresh = compute({ ...stored, profile: { ...stored.profile, opening_date: decision.openingDate } }, route.today)!;
        // The dates moved: replace the plan.
        await reminders?.reschedule(userId, stored.id, fresh.route);
        return { status: 'moved', requested: move.to, route: fresh.route };
      }
    }
  }

  return {
    /** Builds and stores a route for a finished onboarding profile. */
    async createRoute(userId: number, profile: Profile): Promise<{ routeId: number; route: Route } | null> {
      const pack = packs.forCity(profile.city);
      if (!pack) return null;
      const result = buildRoute(pack, profile, clock.today());
      if (result.status !== 'ok') return null;
      const routeId = await repos.routes.replaceForUser(userId, {
        packId: pack.manifest.id,
        packVersion: pack.manifest.version,
        profile,
        actionIds: result.route.steps.map((s) => s.action.id),
      });
      await reminders?.reschedule(userId, routeId, result.route);
      return { routeId, route: result.route };
    },

    async getRoute(userId: number): Promise<{ routeId: number; route: Route; pack: RulesPack } | null> {
      const loaded = await load(userId);
      return loaded ? { routeId: loaded.stored.id, route: loaded.route, pack: loaded.pack } : null;
    },

    async getRouteView(userId: number): Promise<RouteView | null> {
      const loaded = await load(userId);
      return loaded ? toRouteView(loaded.route, loaded.pack) : null;
    },

    async getTask(userId: number, actionId: string): Promise<TaskDetail | null> {
      const loaded = await load(userId);
      const step = loaded?.route.steps.find((s) => s.action.id === actionId);
      return loaded && step ? toTaskDetail(loaded.route, step, loaded.pack) : null;
    },

    async getReadiness(userId: number): Promise<Readiness | null> {
      const loaded = await load(userId);
      return loaded ? readiness(loaded.route) : null;
    },

    /** Returns null when the user has no route or the task is not part of it. */
    async setTaskStatus(userId: number, actionId: string, status: TaskStatus): Promise<TaskUpdate | null> {
      const loaded = await load(userId);
      if (!loaded || !loaded.route.steps.some((s) => s.action.id === actionId)) return null;

      const updated = await repos.tasks.setStatus(loaded.stored.id, actionId, status, clock.now());
      if (!updated) return null;
      if (status === 'done') await repos.reminders.cancelForTask(loaded.stored.id, actionId, clock.now());

      const fresh = compute({ ...loaded.stored, statuses: { ...loaded.stored.statuses, [actionId]: status } })!;
      // Progress changes what to remind about: replace the plan.
      await reminders?.reschedule(userId, loaded.stored.id, fresh.route);
      const step = fresh.route.steps.find((s) => s.action.id === actionId)!;
      const next = nextBestStep(fresh.route);
      return {
        task: toTaskDetail(fresh.route, step, fresh.pack),
        readiness: readiness(fresh.route),
        nextStep: next ? toTaskSummary(fresh.route, next) : null,
      };
    },

    /**
     * «Перенести на …»: moves the opening date of the stored route when the core agrees (decideReschedule). The route
     * stays the same one — its id, the marks of done steps and its build time — and only its dates are recounted.
     */
    async rescheduleOpening(userId: number, move: OpeningMove): Promise<RescheduleOutcome> {
      return rescheduleOnce(userId, move, false);
    },
  };
}

export type RouteService = ReturnType<typeof createRouteService>;
