import type { Api } from '@maxhub/max-bot-api';
import { reminderReply, type ReminderKind } from '@otkryvay/core';
import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from '../clock.js';
import type { Repositories } from '../db/repositories.js';
import { renderReply, type RenderOptions } from '../max/render.js';
import type { RouteService } from '../services/routes.js';

export interface ReminderWorkerDeps {
  repos: Repositories;
  routes: RouteService;
  api: Pick<Api, 'sendMessageToUser'>;
  render: RenderOptions;
  clock: Clock;
  log: FastifyBaseLogger;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between messages: MAX allows about 2 messages per second per chat. */
  pacingMs?: number;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** MAX answers 403 (the bot was stopped or blocked) and 404 (no dialog) for good — retrying cannot help. */
function isPermanent(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 403 || status === 404;
}

/** Drains due reminders from the queue. Safe to run in several processes (claimDue leases rows). */
export function createReminderWorker(deps: ReminderWorkerDeps) {
  const { repos, routes, api, render, clock, log } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const pacingMs = deps.pacingMs ?? 600;
  const batchSize = deps.batchSize ?? 20;
  const leaseMs = deps.leaseMs ?? 2 * 60_000;
  const maxAttempts = deps.maxAttempts ?? 5;

  async function tick(): Promise<{ sent: number; skipped: number; failed: number }> {
    const result = { sent: 0, skipped: 0, failed: 0 };
    const due = await repos.reminders.claimDue(clock.now(), batchSize, leaseMs);

    for (const [index, reminder] of due.entries()) {
      // The route may have changed since the reminder was planned: re-check before sending.
      const loaded = await routes.getRoute(reminder.userId);
      const step = loaded?.routeId === reminder.routeId ? loaded.route.steps.find((s) => s.action.id === reminder.actionId) : undefined;
      if (!loaded || !step || step.status === 'done') {
        await repos.reminders.cancel(reminder.id, clock.now());
        result.skipped++;
        continue;
      }

      if (index > 0) await sleep(pacingMs);
      try {
        const { text, extra } = renderReply(reminderReply(step, reminder.kind as ReminderKind, loaded.route.today), render);
        await api.sendMessageToUser(reminder.userId, text, extra);
        await repos.reminders.markSent(reminder.id, clock.now());
        await repos.events.record('reminder_sent', reminder.userId, { kind: reminder.kind, task: step.action.id });
        result.sent++;
      } catch (error) {
        result.failed++;
        const message = error instanceof Error ? error.message : String(error);
        if (isPermanent(error)) {
          await repos.reminders.cancel(reminder.id, clock.now(), message);
          log.warn({ err: error, reminderId: reminder.id }, 'reminder dropped: the user cannot receive messages');
        } else if (reminder.attempts >= maxAttempts) {
          await repos.reminders.cancel(reminder.id, clock.now(), message);
          log.error({ err: error, reminderId: reminder.id, attempts: reminder.attempts }, 'reminder dropped after repeated failures');
        } else {
          const retryAt = new Date(clock.now().getTime() + reminder.attempts * 2 * 60_000);
          await repos.reminders.markFailed(reminder.id, message, retryAt);
          log.warn({ err: error, reminderId: reminder.id, retryAt }, 'reminder delivery failed, will retry');
        }
      }
    }
    return result;
  }

  return {
    tick,
    /** Polls the queue every `intervalMs`; returns a stop function. */
    start(intervalMs: number): () => void {
      let running = false;
      const timer = setInterval(() => {
        if (running) return;
        running = true;
        tick()
          .then((r) => r.sent + r.failed > 0 && log.info(r, 'reminder tick'))
          .catch((error: unknown) => log.error({ err: error }, 'reminder tick failed'))
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      return () => clearInterval(timer);
    },
  };
}
