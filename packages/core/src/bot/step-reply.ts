import { formatDueDate } from '../rules/dates.js';
import type { RouteStep } from '../rules/route.js';
import type { ReplySpec } from './reply.js';

const KIND_NOTE = {
  official_fact: 'Основано на официальном источнике.',
  recommendation: 'Это рекомендация, а не требование закона.',
  test_data: 'Тестовые данные: карточка ещё не проверена юристом.',
} as const;

/**
 * «начать сегодня» or «начать до 14.10» (with the year outside the current one): by when to start, mid-sentence. A step
 * starts today when it moves the opening or its latest start has come. The route never dates a step to do before
 * today, so a date already behind is only a safeguard: the user never reads a past date as a deadline.
 */
export function startPhrase(step: RouteStep, today: string): string {
  // ISO dates compare as strings.
  return step.overdue || step.latestStart <= today ? 'начать сегодня' : `начать до ${formatDueDate(step.latestStart, today)}`;
}

/**
 * The line of a step message that says by when to start it: startPhrase as a sentence. A step that moves the opening
 * says what waiting costs instead: every day it waits moves the opening one more day.
 */
export function startLine(step: RouteStep, today: string): string {
  if (step.overdue) return 'Начните сегодня — каждый день задержки сдвигает открытие.';
  const phrase = startPhrase(step, today);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`;
}

/** A route step as a chat message: what to do, why, by when — with a button to its card in the mini-app. */
export function stepReply(step: RouteStep, today: string): ReplySpec {
  const lines = [
    `Шаг: ${step.action.title}`,
    '',
    `Зачем: ${step.action.why}`,
    `Что сделать сейчас: ${step.action.do_now}`,
    startLine(step, today),
    '',
    KIND_NOTE[step.action.kind],
  ];
  return {
    text: lines.join('\n'),
    buttons: [[{ kind: 'open_app', text: 'Открыть карточку', startParam: step.action.id }]],
  };
}
