import type { OnboardingState, Profile, TaskStatus } from '@otkryvay/core';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { events, onboardingStates, reminders, routes, routeTasks, users } from './schema.js';

type Db = Database['db'];

export interface StoredRoute {
  id: number;
  userId: number;
  packId: string;
  packVersion: string;
  profile: Profile;
  actionIds: string[];
  statuses: Record<string, TaskStatus>;
}

export interface NewReminder {
  userId: number;
  routeId: number;
  actionId: string | null;
  kind: string;
  dueAt: Date;
}

export type ReminderRow = typeof reminders.$inferSelect;

export function createRepositories(db: Db) {
  return {
    users: {
      /** Registers the user on first contact and updates last_seen_at afterwards. */
      async touch(userId: number): Promise<void> {
        await db
          .insert(users)
          .values({ maxUserId: userId })
          .onConflictDoUpdate({ target: users.maxUserId, set: { lastSeenAt: sql`now()` } });
      },
    },

    onboarding: {
      async get(userId: number): Promise<OnboardingState | null> {
        const [row] = await db.select().from(onboardingStates).where(eq(onboardingStates.userId, userId));
        return (row?.state as OnboardingState | undefined) ?? null;
      },

      async save(userId: number, state: OnboardingState): Promise<void> {
        await db
          .insert(onboardingStates)
          .values({ userId, state })
          .onConflictDoUpdate({ target: onboardingStates.userId, set: { state, updatedAt: sql`now()` } });
      },
    },

    routes: {
      /**
       * Stores a freshly built route as the user's only active route. The previous route,
       * its task statuses and pending reminders are removed (cascade).
       */
      async replaceForUser(
        userId: number,
        route: { packId: string; packVersion: string; profile: Profile; actionIds: string[] },
      ): Promise<number> {
        return db.transaction(async (tx) => {
          await tx.delete(routes).where(eq(routes.userId, userId));
          const [created] = await tx.insert(routes).values({ userId, ...route }).returning({ id: routes.id });
          const routeId = created!.id;
          if (route.actionIds.length > 0) {
            await tx.insert(routeTasks).values(route.actionIds.map((actionId) => ({ routeId, actionId, status: 'todo' as const })));
          }
          return routeId;
        });
      },

      /**
       * Moves the opening date of a stored route in place: only profile.opening_date changes. The route keeps its id,
       * the statuses of its tasks and created_at, which the KPI «3 шага за 7 дней» counts from.
       * Compare-and-set: the date is written only while it is still `from`, the one the move was decided on, so of two
       * presses of one button handled at once only one moves it. Returns false when nothing was written: no such route,
       * or its date is no longer `from`.
       */
      async setOpeningDate(routeId: number, from: string, to: string): Promise<boolean> {
        const updated = await db
          .update(routes)
          .set({ profile: sql`jsonb_set(${routes.profile}, '{opening_date}', to_jsonb(${to}::text))`, updatedAt: sql`now()` })
          .where(and(eq(routes.id, routeId), sql`${routes.profile}->>'opening_date' = ${from}`))
          .returning({ id: routes.id });
        return updated.length > 0;
      },

      async getForUser(userId: number): Promise<StoredRoute | null> {
        const [row] = await db.select().from(routes).where(eq(routes.userId, userId));
        if (!row) return null;
        const tasks = await db
          .select({ actionId: routeTasks.actionId, status: routeTasks.status })
          .from(routeTasks)
          .where(eq(routeTasks.routeId, row.id));
        return {
          id: row.id,
          userId: row.userId,
          packId: row.packId,
          packVersion: row.packVersion,
          profile: row.profile as Profile,
          actionIds: row.actionIds,
          statuses: Object.fromEntries(tasks.map((t) => [t.actionId, t.status])),
        };
      },
    },

    tasks: {
      /** Returns false when the task does not belong to the route. */
      async setStatus(routeId: number, actionId: string, status: TaskStatus, now: Date): Promise<boolean> {
        const updated = await db
          .update(routeTasks)
          .set({ status, doneAt: status === 'done' ? now : null, updatedAt: now })
          .where(and(eq(routeTasks.routeId, routeId), eq(routeTasks.actionId, actionId)))
          .returning({ actionId: routeTasks.actionId });
        return updated.length > 0;
      },
    },

    reminders: {
      async schedule(reminder: NewReminder): Promise<number> {
        const [row] = await db.insert(reminders).values(reminder).returning({ id: reminders.id });
        return row!.id;
      },

      /**
       * Atomically leases up to `limit` due reminders. Rows locked by a concurrent worker are
       * skipped (FOR UPDATE SKIP LOCKED), and a leased row is invisible to others until the
       * lease expires, so each reminder is handed to exactly one worker at a time.
       */
      async claimDue(now: Date, limit: number, leaseMs: number): Promise<ReminderRow[]> {
        const due = db
          .select({ id: reminders.id })
          .from(reminders)
          .where(
            and(
              isNull(reminders.sentAt),
              isNull(reminders.cancelledAt),
              lte(reminders.dueAt, now),
              or(isNull(reminders.lockedUntil), lt(reminders.lockedUntil, now)),
            ),
          )
          .orderBy(asc(reminders.dueAt))
          .limit(limit)
          .for('update', { skipLocked: true });

        return db
          .update(reminders)
          .set({ lockedUntil: new Date(now.getTime() + leaseMs), attempts: sql`${reminders.attempts} + 1` })
          .where(inArray(reminders.id, due))
          .returning();
      },

      async markSent(id: number, now: Date): Promise<void> {
        await db.update(reminders).set({ sentAt: now, lockedUntil: null, lastError: null }).where(eq(reminders.id, id));
      },

      /** Keeps the reminder pending and makes it claimable again at `retryAt`. */
      async markFailed(id: number, error: string, retryAt: Date): Promise<void> {
        await db.update(reminders).set({ lockedUntil: retryAt, lastError: error.slice(0, 500) }).where(eq(reminders.id, id));
      },

      /** Cancels every pending reminder of a route before a new plan is stored. */
      async cancelPendingForRoute(routeId: number, now: Date): Promise<number> {
        const cancelled = await db
          .update(reminders)
          .set({ cancelledAt: now })
          .where(and(eq(reminders.routeId, routeId), isNull(reminders.sentAt), isNull(reminders.cancelledAt)))
          .returning({ id: reminders.id });
        return cancelled.length;
      },

      /** Drops a single reminder that is no longer relevant (task done, route replaced, retries exhausted). */
      /** Cancels one reminder; `error` keeps the reason when delivery was given up. */
      async cancel(id: number, now: Date, error?: string): Promise<void> {
        await db
          .update(reminders)
          .set({ cancelledAt: now, lockedUntil: null, ...(error === undefined ? {} : { lastError: error.slice(0, 500) }) })
          .where(eq(reminders.id, id));
      },

      /** Cancels pending reminders about a task (e.g. it was marked done). */
      async cancelForTask(routeId: number, actionId: string, now: Date): Promise<number> {
        const cancelled = await db
          .update(reminders)
          .set({ cancelledAt: now })
          .where(
            and(eq(reminders.routeId, routeId), eq(reminders.actionId, actionId), isNull(reminders.sentAt), isNull(reminders.cancelledAt)),
          )
          .returning({ id: reminders.id });
        return cancelled.length;
      },
    },

    events: {
      async record(type: string, userId: number | null, props: Record<string, unknown> = {}): Promise<void> {
        await db.insert(events).values({ type, userId, props });
      },
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
