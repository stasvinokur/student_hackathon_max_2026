import type { ReplySpec } from '../bot/reply.js';
import { startLine } from '../bot/step-reply.js';
import { addDays } from '../rules/dates.js';
import { nextBestStep, topBlockers, type Route, type RouteStep } from '../rules/route.js';

export type ReminderKind = 'next_step' | 'deadline';

export interface ReminderPlan {
  actionId: string;
  kind: ReminderKind;
  /** 'soon' — after the shell's default delay; otherwise a calendar date for a morning reminder. */
  due: 'soon' | { date: string };
}

/** Days before the latest start date when a blocker reminder is sent. */
export const DEADLINE_LEAD_DAYS = 2;

/**
 * Which reminders a route needs right now. Pure: the shell cancels the old plan and stores this one
 * whenever the route changes (built, task done or reopened).
 */
export function planReminders(route: Route): ReminderPlan[] {
  const plans: ReminderPlan[] = [];
  const next = nextBestStep(route);
  if (next) plans.push({ actionId: next.action.id, kind: 'next_step', due: 'soon' });

  for (const blocker of topBlockers(route)) {
    // The next step gets no deadline reminder: the next-step reminder, sent soon, stands in for it.
    if (blocker.action.id === next?.action.id) continue;
    const date = addDays(blocker.latestStart, -DEADLINE_LEAD_DAYS);
    // A reminder date that is today or past leaves too little lead to warn ahead: the step gets no deadline reminder.
    // The route shows its start date all the same, «Просрочено» when it moves the opening.
    if (date > route.today) plans.push({ actionId: blocker.action.id, kind: 'deadline', due: { date } });
  }
  return plans;
}

/** Chat message for a reminder, with a button that opens the step's card in the mini-app. */
export function reminderReply(step: RouteStep, kind: ReminderKind, today: string): ReplySpec {
  // A deadline reminder is planned days ahead: by the time it is sent the step may already move the opening, and its
  // deadline is no longer «soon».
  const lead =
    kind === 'next_step' ? 'Следующий шаг к открытию:' : step.overdue ? 'Пора начинать:' : 'Скоро срок по шагу, который может сорвать запуск:';
  return {
    text: `${lead}\n«${step.action.title}»\n${startLine(step, today)}\n\nЧто сделать сейчас: ${step.action.do_now}`,
    buttons: [[{ kind: 'open_app', text: 'Открыть карточку', startParam: step.action.id }]],
  };
}
