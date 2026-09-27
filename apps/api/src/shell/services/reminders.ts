import { planReminders, type Route } from '@otkryvay/core';
import { moscowMorning, type Clock } from '../clock.js';
import type { Repositories } from '../db/repositories.js';

export interface ReminderServiceDeps {
  repos: Repositories;
  clock: Clock;
  /** Delay of the "next step" reminder; shortened for demos via REMINDER_DELAY_SECONDS. */
  delaySeconds: number;
}

/** Stores the core reminder plan for a route, replacing any pending reminders of that route. */
export function createReminderService({ repos, clock, delaySeconds }: ReminderServiceDeps) {
  return {
    async reschedule(userId: number, routeId: number, route: Route): Promise<number> {
      const now = clock.now();
      await repos.reminders.cancelPendingForRoute(routeId, now);
      const plans = planReminders(route);
      for (const plan of plans) {
        const dueAt = plan.due === 'soon' ? new Date(now.getTime() + delaySeconds * 1000) : moscowMorning(plan.due.date);
        await repos.reminders.schedule({ userId, routeId, actionId: plan.actionId, kind: plan.kind, dueAt });
      }
      return plans.length;
    },
  };
}

export type ReminderService = ReturnType<typeof createReminderService>;
