// The opening date in the chat: the offer to move a date that cannot be met, and the answers to its buttons.

import { formatDayMonthNear } from '../rules/dates.js';
import { lateOpeningText, openingPassed } from '../rules/opening.js';
import { plural } from '../rules/plural.js';
import { nextBestStep, type Route } from '../rules/route.js';
import { keepOpeningPayload, rescheduleOpeningPayload } from './payloads.js';
import { openRouteButton, restartButton, type ReplySpec } from './reply.js';
import { startPhrase } from './step-reply.js';

/** What came of a press on «Перенести на …» (decideReschedule); route is the route after it, requested the date offered. */
export type RescheduleOutcome =
  | { status: 'no_route' }
  | { status: 'stale' | 'unchanged'; route: Route }
  | { status: 'expired' | 'moved'; requested: string; route: Route };

/** What came of a press on «Оставить …» (decideKeep); route is the stored one. */
export type KeepOutcome = { status: 'no_route' } | { status: 'stale' | 'passed' | 'kept'; route: Route };

/** A message with the button that opens the route in the mini-app. */
function routeReply(text: string): ReplySpec {
  return { text, buttons: [[openRouteButton()]] };
}

/** A route button pressed with no route stored: the way on is the questions. */
function noRouteReply(): ReplySpec {
  return { text: 'Маршрута пока нет — пройдите вопросы заново.', buttons: [[restartButton()]] };
}

/** A button made for an opening date the route no longer has. */
function staleReply(route: Route): ReplySpec {
  return routeReply(`Эта кнопка устарела: в маршруте уже другая дата открытия — ${formatDayMonthNear(route.openingDate, route.today)}.`);
}

/** `text` followed by «К 8 декабря не успеть — …» as a sentence of its own when the opening date cannot be met. */
function withLateOpening(text: string, route: Route): string {
  const late = lateOpeningText(route);
  return late === null ? text : `${text} ${late}.`;
}

/**
 * The offer to move an opening date that cannot be met to the earliest reachable one, or null when it can be met.
 * A message of its own: pressing a button clears every callback button of its message, and the summary before it
 * keeps «Начать с №1». A date that has passed cannot be kept: the offer is to move it alone.
 */
export function rescheduleOfferReply(route: Route): ReplySpec | null {
  const { openingDate, projectedOpeningDate, today } = route;
  if (projectedOpeningDate === null) return null;
  const reachable = formatDayMonthNear(projectedOpeningDate, today);
  const buttons: ReplySpec['buttons'] = [
    [{ kind: 'callback', text: `Перенести на ${reachable}`, payload: rescheduleOpeningPayload(openingDate, projectedOpeningDate) }],
  ];
  if (!openingPassed(route)) {
    buttons.push([{ kind: 'callback', text: `Оставить ${formatDayMonthNear(openingDate, today)}`, payload: keepOpeningPayload(openingDate) }]);
  }
  return { text: `Перенести дату открытия на ${reachable}? Отметки выполненных шагов сохранятся.`, buttons };
}

/** The answer to a press on «Перенести на …»: what happened to the date, and a fresh offer when it has slipped again. */
export function rescheduleReplies(outcome: RescheduleOutcome): ReplySpec[] {
  if (outcome.status === 'no_route') return [noRouteReply()];
  const { route } = outcome;
  const opening = formatDayMonthNear(route.openingDate, route.today);

  switch (outcome.status) {
    case 'moved': {
      const days = `до него ${route.daysToOpening} ${plural(route.daysToOpening, 'день', 'дня', 'дней')}`;
      // The offer may be days old: the move then went further than the button said.
      const moved =
        route.openingDate === outcome.requested
          ? `Готово: открытие — ${opening}, ${days}.`
          : `${formatDayMonthNear(outcome.requested, route.today)} уже не успеть — перенесли открытие на ${opening}, ${days}.`;
      const next = nextBestStep(route);
      const lines = [`${moved} Отметки выполненных шагов сохранены.`];
      if (next) lines.push(`Следующий шаг: ${next.action.title} — ${startPhrase(next, route.today)}.`);
      return [routeReply(lines.join('\n'))];
    }
    case 'unchanged': {
      // Pressed again: the date is already the offered one, yet it may have slipped since the first press — then the
      // message says so, and why a fresh offer follows.
      const offer = rescheduleOfferReply(route);
      return [routeReply(withLateOpening(`Дата открытия уже ${opening}.`, route)), ...(offer ? [offer] : [])];
    }
    case 'stale':
      // The stored date is no longer the one the offer was made for. decideReschedule says stale as well when no route
      // can be built for the offered date; in practice that does not happen: applies_if never looks at the opening date,
      // and the city is the one of the stored route.
      return [staleReply(route)];
    case 'expired':
      return [routeReply(`${formatDayMonthNear(outcome.requested, route.today)} уже наступило — дату открытия не меняем.`)];
  }
}

/** The answer to a press on «Оставить …»: the date stays, and a date that cannot be met still dates the steps from the reachable one. */
export function keepOpeningReplies(outcome: KeepOutcome): ReplySpec[] {
  if (outcome.status === 'no_route') return [noRouteReply()];
  const { route } = outcome;
  const opening = formatDayMonthNear(route.openingDate, route.today);

  switch (outcome.status) {
    case 'stale':
      return [staleReply(route)];
    case 'passed': {
      // The buttons of the offer are gone once one is pressed: a fresh offer, to move the date alone, is the way on.
      const offer = rescheduleOfferReply(route);
      return [routeReply(withLateOpening(`Дата открытия ${opening} прошла.`, route)), ...(offer ? [offer] : [])];
    }
    case 'kept': {
      const { projectedOpeningDate, today } = route;
      if (projectedOpeningDate === null) return [routeReply(`Оставили ${opening} — к этой дате можно успеть.`)];
      return [
        routeReply(`Оставили ${opening}. Сроки шагов посчитаны так, чтобы открыться как можно раньше — ${formatDayMonthNear(projectedOpeningDate, today)}.`),
      ];
    }
  }
}
