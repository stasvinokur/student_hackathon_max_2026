import type { Profile } from '../profile.js';
import { diffDays, fromEpochDay, isIsoDate, toEpochDay } from './dates.js';
import { evaluatePredicate } from './predicate.js';
import type { ActionCard, RulesPack } from './schema.js';
import type { RouteView, TaskSummary } from './view.js';

export type TaskStatus = 'todo' | 'done';
export type TaskStatuses = Readonly<Record<string, TaskStatus>>;

export interface RouteStep {
  action: ActionCard;
  status: TaskStatus;
  /** Applicable prerequisites only (dependencies filtered out by applies_if are dropped). */
  dependsOn: string[];
  /** Prerequisites that are not done yet. */
  waitingFor: string[];
  /**
   * Latest day to start / finish to open on the opening date the route counts from: projectedOpeningDate when the
   * planned one cannot be met, the planned one otherwise. A step to do is never dated before today: an optional step
   * whose own date has passed is due as soon as it can be started. An optional step never pulls a required one
   * earlier, so its dates may come before the latest finish of its required prerequisite.
   */
  latestStart: string;
  latestFinish: string;
  /** Earliest possible start / finish counting from today and unfinished prerequisites. */
  earliestStart: string;
  earliestFinish: string;
  /** Spare days against the opening date the route counts from: latestStart − earliestStart, never negative for a step to do. */
  floatDays: number;
  /**
   * The planned opening date cannot be met because of this step, and it can be started today: a required step
   * (critical or ops) with no spare days and no unfinished prerequisites while projectedOpeningDate is set.
   */
  overdue: boolean;
  /**
   * Not done and has the smallest float among the required steps to do (critical and ops); among the optional ones
   * once only they are left.
   */
  onCriticalPath: boolean;
}

export interface Route {
  packId: string;
  packVersion: string;
  openingDate: string;
  /**
   * The earliest opening the required steps allow if the remaining ones start today, when it is later than
   * openingDate; null when openingDate can be met. Step dates count from it.
   */
  projectedOpeningDate: string | null;
  today: string;
  /** Negative when the planned opening date has passed. */
  daysToOpening: number;
  /** Topological order: every step comes after its prerequisites. */
  steps: RouteStep[];
}

export type ClarificationReason = 'unsupported_city' | 'invalid_opening_date' | 'no_applicable_actions';

export type BuildRouteResult =
  | { status: 'ok'; route: Route }
  | { status: 'needs_clarification'; reason: ClarificationReason; message: string };

/**
 * Builds the personal route. Deterministic: the same pack, profile, today and statuses
 * always produce the same route. `today` is passed in — the core never reads the clock.
 */
export function buildRoute(pack: RulesPack, profile: Profile, today: string, statuses: TaskStatuses = {}): BuildRouteResult {
  if (!pack.manifest.cities.includes(profile.city)) {
    return {
      status: 'needs_clarification',
      reason: 'unsupported_city',
      message: `Пакет «${pack.manifest.title}» пока не покрывает этот город.`,
    };
  }
  if (!isIsoDate(profile.opening_date) || !isIsoDate(today)) {
    return { status: 'needs_clarification', reason: 'invalid_opening_date', message: 'Нужна дата открытия в формате ГГГГ-ММ-ДД.' };
  }

  const applicable = pack.actions.filter((a) => !a.applies_if || evaluatePredicate(a.applies_if, profile));
  if (applicable.length === 0) {
    return {
      status: 'needs_clarification',
      reason: 'no_applicable_actions',
      message: 'Для такого сочетания ответов в пакете нет проверенных действий — нужно уточнение.',
    };
  }

  const ids = new Set(applicable.map((a) => a.id));
  // Validation rejects a prerequisite listed twice; dedupe anyway: the ordering below counts each edge once.
  const deps = new Map(applicable.map((a) => [a.id, [...new Set(a.depends_on)].filter((d) => ids.has(d))]));
  const ordered = topologicalOrder(applicable, deps);
  const isDone = (id: string) => statuses[id] === 'done';

  const todayDay = toEpochDay(today)!;
  const openingDay = toEpochDay(profile.opening_date)!;

  // Backward pass: the latest schedule that still meets the planned opening date, which may lie in the past. A step
  // must finish by the latest start of its dependents, with two exceptions:
  // - a done dependent bounds nothing: a step may be marked done ahead of the one it waits for;
  // - an optional (support) dependent never bounds a required prerequisite: an optional step holds nothing back, and a
  //   tight date of its own would otherwise pull a required step earlier and move the opening through it. Its own date
  //   may then come before the latest finish of that prerequisite; when it comes even before the step can start, the
  //   step is pulled to its earliest start (see the shift below).
  // Validation keeps support steps from having required dependents, so a support step is bounded by all of its own.
  const lanes = new Map(ordered.map((a) => [a.id, a.lane]));
  const latestStart = new Map<string, number>();
  const latestFinish = new Map<string, number>();
  const dependents = new Map<string, string[]>(ordered.map((a) => [a.id, []]));
  for (const action of ordered) {
    if (isDone(action.id)) continue;
    for (const dep of deps.get(action.id)!) {
      if (action.lane === 'support' && lanes.get(dep) !== 'support') continue;
      dependents.get(dep)!.push(action.id);
    }
  }

  for (const action of [...ordered].reverse()) {
    const byOpening = openingDay - action.due_days_before_opening;
    const byDependents = Math.min(...dependents.get(action.id)!.map((id) => latestStart.get(id)!));
    const finish = Math.min(byOpening, byDependents);
    latestFinish.set(action.id, finish);
    latestStart.set(action.id, finish - action.duration_days);
  }

  // Forward pass: the earliest schedule starting today. Done steps are finished as of today.
  const earliestStart = new Map<string, number>();
  const earliestFinish = new Map<string, number>();
  for (const action of ordered) {
    const start = Math.max(todayDay, ...deps.get(action.id)!.map((id) => earliestFinish.get(id)!));
    earliestStart.set(action.id, start);
    earliestFinish.set(action.id, isDone(action.id) ? todayDay : start + action.duration_days);
  }

  // Float against the planned date. Negative — the step cannot start in time even today.
  const plannedFloat = (id: string) => latestStart.get(id)! - earliestStart.get(id)!;

  // Required steps to do hold the opening: when some of them cannot make the planned date, the whole schedule moves
  // by the most days any of them lacks. That is the schedule of the earliest reachable opening, the same one a route
  // built for it gives, so step dates never lie in the past. Optional (support) steps move nothing: one whose own date
  // has passed is pulled to its earliest start instead.
  const gates = (a: ActionCard) => !isDone(a.id) && a.lane !== 'support';
  const gating = ordered.filter(gates);
  const delay = Math.max(0, ...gating.map((a) => -plannedFloat(a.id)));
  // Days the dates of a step move: the delay of the whole schedule, and for a step to do still dated before its
  // earliest start after it (only an optional one can be) the days that are left to reach that start.
  const shiftOf = (id: string) => {
    const float = plannedFloat(id) + delay;
    return isDone(id) || float >= 0 ? delay : delay - float;
  };
  const floatOf = (id: string) => plannedFloat(id) + shiftOf(id);

  // The critical path runs through the required steps; the optional ones make it only once they alone are left.
  const pending = ordered.filter((a) => !isDone(a.id));
  const pathSteps = gating.length > 0 ? gating : pending;
  const criticalFloat = pathSteps.length > 0 ? Math.min(...pathSteps.map((a) => floatOf(a.id))) : null;

  const steps: RouteStep[] = ordered.map((action) => {
    const done = isDone(action.id);
    const dependsOn = deps.get(action.id)!;
    const waitingFor = dependsOn.filter((id) => !isDone(id));
    const floatDays = floatOf(action.id);
    return {
      action,
      status: done ? 'done' : 'todo',
      dependsOn,
      waitingFor,
      latestStart: fromEpochDay(latestStart.get(action.id)! + shiftOf(action.id)),
      latestFinish: fromEpochDay(latestFinish.get(action.id)! + shiftOf(action.id)),
      earliestStart: fromEpochDay(earliestStart.get(action.id)!),
      earliestFinish: fromEpochDay(earliestFinish.get(action.id)!),
      floatDays,
      // The planned date is lost because of this step, and it can be started today.
      overdue: delay > 0 && gates(action) && floatDays === 0 && waitingFor.length === 0,
      onCriticalPath: pathSteps.includes(action) && floatDays === criticalFloat,
    };
  });

  return {
    status: 'ok',
    route: {
      packId: pack.manifest.id,
      packVersion: pack.manifest.version,
      openingDate: profile.opening_date,
      projectedOpeningDate: delay > 0 ? fromEpochDay(openingDay + delay) : null,
      today,
      daysToOpening: diffDays(today, profile.opening_date),
      steps,
    },
  };
}

/** Kahn's algorithm; ties keep the pack order so the result is stable. The pack is validated acyclic. */
function topologicalOrder(actions: ActionCard[], deps: Map<string, string[]>): ActionCard[] {
  const remaining = new Map(actions.map((a) => [a.id, deps.get(a.id)!.length]));
  const result: ActionCard[] = [];
  const placed = new Set<string>();

  while (result.length < actions.length) {
    const next = actions.find((a) => !placed.has(a.id) && remaining.get(a.id) === 0);
    if (!next) throw new Error('dependency cycle in a validated pack');
    result.push(next);
    placed.add(next.id);
    for (const a of actions) {
      if (deps.get(a.id)!.includes(next.id)) remaining.set(a.id, remaining.get(a.id)! - 1);
    }
  }
  return result;
}

/** Up to `limit` unfinished critical-lane steps that most endanger the opening date. */
export function topBlockers(route: Route, limit = 3): RouteStep[] {
  return route.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status !== 'done' && step.action.lane === 'critical')
    .sort(
      (a, b) =>
        Number(b.step.overdue) - Number(a.step.overdue) ||
        a.step.floatDays - b.step.floatDays ||
        a.step.latestStart.localeCompare(b.step.latestStart) ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map(({ step }) => step);
}

/**
 * The most urgent step that can be started now (all prerequisites done), or null when everything is done. A step that
 * moves the opening comes first, then required steps by their spare days; an optional step comes only once no
 * required one can be started, whatever its spare days (one whose own date has passed has none, yet holds nothing back).
 */
export function nextBestStep(route: Route): RouteStep | null {
  const optional = (step: RouteStep) => Number(step.action.lane === 'support');
  const available = route.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status !== 'done' && step.waitingFor.length === 0)
    .sort(
      (a, b) =>
        Number(b.step.overdue) - Number(a.step.overdue) ||
        optional(a.step) - optional(b.step) ||
        a.step.floatDays - b.step.floatDays ||
        a.step.latestStart.localeCompare(b.step.latestStart) ||
        a.index - b.index,
    );
  return available[0]?.step ?? null;
}

/**
 * The steps of the route view, not done, that wait for step `id` alone: marking it done makes them available. On the
 * view, which the mini-app has; here, not beside the view, so that it comes without the schemas of the API.
 */
export function stepsUnblockedBy(route: RouteView, id: string): TaskSummary[] {
  return Object.values(route.lanes)
    .flat()
    .filter((step) => step.status !== 'done' && step.waitingFor.length === 1 && step.waitingFor[0]?.id === id);
}

export interface Readiness {
  done: number;
  total: number;
  /** 0–100, rounded down so 100% means everything is done. */
  percent: number;
  criticalDone: number;
  criticalTotal: number;
}

export function readiness(route: Route): Readiness {
  const critical = route.steps.filter((s) => s.action.lane === 'critical');
  const done = route.steps.filter((s) => s.status === 'done').length;
  const total = route.steps.length;
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.floor((done / total) * 100),
    criticalDone: critical.filter((s) => s.status === 'done').length,
    criticalTotal: critical.length,
  };
}
