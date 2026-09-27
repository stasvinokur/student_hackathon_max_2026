// Callback payloads of the bot's buttons outside the questions of onboarding, in one place: «Пройти заново», which the
// onboarding machine handles, and the route: ones, which the shell handles once onboarding is done.

import { isIsoDate } from '../rules/dates.js';
import type { OpeningMove } from '../rules/opening.js';

/** Callback payload of the «Пройти заново» button: onboarding from the first question. */
export const RESTART_PAYLOAD = 'ob:restart';

/** Callback payload of the «Начать с №1» button; handled by the shell after onboarding. */
export const ROUTE_FIRST_STEP_PAYLOAD = 'route:first';

/**
 * Callback payload of the «Перенести на …» button: route:reschedule:2026-10-26:2026-12-08, 38 characters. It carries
 * the date the offer was made for, so a button pressed after the date changed is recognised as stale, and the date it
 * offers.
 */
export function rescheduleOpeningPayload(from: string, to: string): string {
  return `route:reschedule:${from}:${to}`;
}

/** The move a «Перенести на …» payload carries, or null when it is not one or a date is not a real one. */
export function parseRescheduleOpeningPayload(payload: string): OpeningMove | null {
  const match = /^route:reschedule:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(payload);
  if (!match) return null;
  const from = match[1]!;
  const to = match[2]!;
  return isIsoDate(from) && isIsoDate(to) ? { from, to } : null;
}

/**
 * Callback payload of the «Оставить …» button: route:keep:2026-10-26. It carries the date kept, so a button pressed
 * after the date changed is recognised as stale.
 */
export function keepOpeningPayload(date: string): string {
  return `route:keep:${date}`;
}

/** The date a «Оставить …» payload carries, or null when it is not one or the date is not a real one. */
export function parseKeepOpeningPayload(payload: string): string | null {
  const match = /^route:keep:(\d{4}-\d{2}-\d{2})$/.exec(payload);
  return match && isIsoDate(match[1]!) ? match[1]! : null;
}

/**
 * A press of a route button: «Начать с №1», «Перенести на …» or «Оставить …»; unknown — a payload with the route:
 * prefix that is none of them (malformed, or a button of a later version).
 */
export type RoutePayload = { kind: 'first' } | { kind: 'reschedule'; move: OpeningMove } | { kind: 'keep'; date: string } | { kind: 'unknown' };

/** The route button a callback payload belongs to, or null when it is not a route one: the onboarding machine's. */
export function parseRoutePayload(payload: string): RoutePayload | null {
  if (!payload.startsWith('route:')) return null;
  if (payload === ROUTE_FIRST_STEP_PAYLOAD) return { kind: 'first' };
  const move = parseRescheduleOpeningPayload(payload);
  if (move) return { kind: 'reschedule', move };
  const date = parseKeepOpeningPayload(payload);
  return date ? { kind: 'keep', date } : { kind: 'unknown' };
}
