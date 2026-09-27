// The opening date against the route: telling the user it cannot be met, and moving it when they agree.

import type { Profile } from '../profile.js';
import { diffDays, formatDayMonthNear } from './dates.js';
import { buildRoute, type Route, type TaskStatuses } from './route.js';
import type { RulesPack } from './schema.js';

/** The opening date has passed; an opening today has not yet. Takes a route or its view alike. */
export function openingPassed(route: Pick<Route, 'openingDate' | 'today'>): boolean {
  // ISO dates compare as strings.
  return route.openingDate < route.today;
}

/** Days the earliest reachable opening is later than the planned one; 0 when the planned one can be met. Takes a route or its view alike. */
export function openingDelayDays(route: Pick<Route, 'openingDate' | 'projectedOpeningDate'>): number {
  return route.projectedOpeningDate === null ? 0 : diffDays(route.openingDate, route.projectedOpeningDate);
}

/**
 * «К 26 октября не успеть — если начать сегодня, откроетесь 8 декабря», or null when the opening date can be met.
 * Once the date has passed only the reachable one is named. No final punctuation: the caller ends the sentence.
 * Takes a route or its view alike.
 */
export function lateOpeningText(route: Pick<Route, 'openingDate' | 'projectedOpeningDate' | 'today'>): string | null {
  const { openingDate, projectedOpeningDate, today } = route;
  if (projectedOpeningDate === null) return null;
  const reachable = `откроетесь ${formatDayMonthNear(projectedOpeningDate, today)}`;
  if (openingPassed(route)) return `Если начать сегодня, ${reachable}`;
  return `К ${formatDayMonthNear(openingDate, today)} не успеть — если начать сегодня, ${reachable}`;
}

/** A move of the opening date the user was offered: from the date stored then to the one offered. */
export interface OpeningMove {
  from: string;
  to: string;
}

/**
 * unchanged — the date is already the offered one (the button was pressed twice); stale — the stored date is no longer
 * the one the offer was made for, or no route can be built for the offered one; expired — the date the move would
 * store is today or has passed, so the stored one stays; move — store openingDate.
 */
export type RescheduleDecision =
  | { status: 'unchanged' }
  | { status: 'stale' }
  | { status: 'expired' }
  | { status: 'move'; openingDate: string };

/**
 * What to do when the user accepts a move of the opening date. The offer may be days old: when the offered date
 * cannot be met any more either, the move goes to the earliest reachable one, so the new date is never late at once;
 * a date no longer ahead is not stored.
 */
export function decideReschedule(pack: RulesPack, profile: Profile, today: string, statuses: TaskStatuses, move: OpeningMove): RescheduleDecision {
  if (profile.opening_date === move.to) return { status: 'unchanged' };
  if (profile.opening_date !== move.from) return { status: 'stale' };
  const trial = buildRoute(pack, { ...profile, opening_date: move.to }, today, statuses);
  if (trial.status !== 'ok') return { status: 'stale' };
  // With every required step done nothing projects a later date, and the offered one may have passed meanwhile.
  const openingDate = trial.route.projectedOpeningDate ?? move.to;
  // ISO dates compare as strings.
  if (openingDate <= today) return { status: 'expired' };
  return { status: 'move', openingDate };
}

/**
 * stale — the stored date is no longer the one the button was made for; passed — the date has passed, there is nothing
 * to keep; kept — the date stays, the earliest reachable opening delayDays after it (0 when it can be met).
 */
export type KeepDecision = { status: 'stale' } | { status: 'passed' } | { status: 'kept'; delayDays: number };

/** What came of «Оставить …» for the date `kept` the button carries. Nothing is stored either way. */
export function decideKeep(route: Pick<Route, 'openingDate' | 'projectedOpeningDate' | 'today'>, kept: string): KeepDecision {
  if (route.openingDate !== kept) return { status: 'stale' };
  if (openingPassed(route)) return { status: 'passed' };
  return { status: 'kept', delayDays: openingDelayDays(route) };
}
