import {
  buildRoute,
  decideKeep,
  diffDays,
  keepOpeningReplies,
  openingDelayDays,
  parseRoutePayload,
  readiness,
  rescheduleReplies,
  stepReply,
  topBlockers,
  nextBestStep,
  transition,
  type KeepOutcome,
  type OnboardingInput,
  type OpeningMove,
  type ReplySpec,
} from '@otkryvay/core';
import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from '../clock.js';
import type { PackRegistry } from '../content/packs.js';
import type { Repositories } from '../db/repositories.js';
import type { RouteService } from './routes.js';

export interface OnboardingServiceDeps {
  repos: Repositories;
  routes: RouteService;
  packs: PackRegistry;
  clock: Clock;
  log: FastifyBaseLogger;
}

/**
 * Shell around the onboarding state machine: loads the saved dialog state, runs the pure
 * transition, saves the new state and, when the profile is complete, stores the route.
 */
export function createOnboardingService(deps: OnboardingServiceDeps) {
  const { repos, routes, packs, clock, log } = deps;

  async function firstStep(userId: number): Promise<ReplySpec[]> {
    const loaded = await routes.getRoute(userId);
    if (!loaded) return [];
    const step = topBlockers(loaded.route)[0] ?? nextBestStep(loaded.route);
    return step ? [stepReply(step, loaded.route.today)] : [];
  }

  /** «Перенести на …»: the move (routes.rescheduleOpening), its event and the answer. */
  async function answerReschedule(userId: number, move: OpeningMove): Promise<ReplySpec[]> {
    const outcome = await routes.rescheduleOpening(userId, move);
    if (outcome.status === 'moved') {
      // move.from is the date the route had: only a route with the date the offer was made for is moved. The move may
      // have gone further than the button said when the offer was days old.
      await repos.events.record('opening_rescheduled', userId, {
        shiftDays: diffDays(move.from, outcome.route.openingDate),
        slipped: outcome.route.openingDate !== outcome.requested,
      });
    }
    return rescheduleReplies(outcome);
  }

  /** «Оставить …» stores nothing: the stored date stays, and the route already dates the steps from the reachable one. */
  async function answerKeep(userId: number, kept: string): Promise<ReplySpec[]> {
    const loaded = await routes.getRoute(userId);
    if (!loaded) return keepOpeningReplies({ status: 'no_route' });
    const decision = decideKeep(loaded.route, kept);
    if (decision.status === 'kept') {
      await repos.events.record('opening_kept', userId, { delayDays: decision.delayDays });
    }
    const outcome: KeepOutcome = { status: decision.status, route: loaded.route };
    return keepOpeningReplies(outcome);
  }

  return {
    async handle(userId: number, input: OnboardingInput): Promise<ReplySpec[]> {
      await repos.users.touch(userId);

      // The route buttons are the shell's; any other input — an answer, «Пройти заново», /restart — is the machine's.
      const payload = input.type === 'callback' ? input.payload : null;
      const button = payload === null ? null : parseRoutePayload(payload);
      if (button?.kind === 'unknown') {
        // Not a button the bot makes (or one of a later version): the machine would only take it for an answer.
        log.warn({ userId, payload: payload?.slice(0, 64) }, 'unknown route button');
        return [];
      }
      if (button?.kind === 'first') return firstStep(userId);

      const state = await repos.onboarding.get(userId);
      // The opening buttons act on the stored route once the questions are answered (or were never asked: a route
      // seeded without a dialog). In the middle of the questions — after /restart — the machine asks the current one
      // again, so an old button does not move the route that is about to be replaced.
      if (button && (state === null || state.step === 'done')) {
        return button.kind === 'reschedule' ? answerReschedule(userId, button.move) : answerKeep(userId, button.date);
      }

      // First contact of any kind starts the dialog: a typed «привет» counts as much as the Start button.
      if (state === null) {
        await repos.events.record('bot_started', userId);
      }

      const today = clock.today();
      const result = transition(state, input, {
        today,
        regions: packs.regions(),
        buildRoute: (profile) => {
          const pack = packs.forCity(profile.city);
          return pack
            ? buildRoute(pack, profile, today)
            : { status: 'needs_clarification', reason: 'unsupported_city', message: 'Для этого города пока нет пакета правил.' };
        },
      });

      await repos.onboarding.save(userId, result.state);

      if (result.completedProfile) {
        await repos.events.record('onboarding_completed', userId, { city: result.completedProfile.city, format: result.completedProfile.format });
        const created = await routes.createRoute(userId, result.completedProfile);
        if (created) {
          const progress = readiness(created.route);
          await repos.events.record('route_built', userId, {
            pack: created.route.packId,
            actions: progress.total,
            critical: progress.criticalTotal,
            daysToOpening: created.route.daysToOpening,
            delayDays: openingDelayDays(created.route),
          });
        }
      }
      if (input.type === 'restart') {
        await repos.events.record('onboarding_restarted', userId);
      }

      return result.replies;
    },
  };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
