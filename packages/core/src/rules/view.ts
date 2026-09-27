import { z } from 'zod';
import { KINDS, LANES, type Place, type RulesPack } from './schema.js';
import { nextBestStep, readiness, topBlockers, type Route, type RouteStep } from './route.js';

// The API contract of the mini-app. Schemas double as OpenAPI documentation in the shell.

export const TaskRefSchema = z.object({ id: z.string(), title: z.string() });

export const PlaceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string().nullable().describe('Short name for the label of the place on the map; null — the label is the name'),
  address: z.string(),
  lat: z.number().min(-90).max(90).describe('Latitude, WGS 84'),
  lon: z.number().min(-180).max(180).describe('Longitude, WGS 84'),
  note: z.string().nullable().describe('Note for the user about the place'),
  osmUrl: z.string().nullable().describe('OpenStreetMap object the coordinates were taken from'),
  source: z
    .object({ url: z.string(), title: z.string(), checkedAt: z.iso.date() })
    .describe('Official page confirming the address and purpose, and the date it was checked'),
});

export const RoutePlaceSchema = PlaceViewSchema.extend({
  actions: z.array(TaskRefSchema).min(1).describe('Route steps done at this place, in route order'),
});

export const TaskSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  lane: z.enum(LANES),
  kind: z.enum(KINDS),
  status: z.enum(['todo', 'done']),
  latestStart: z.iso
    .date()
    .describe('Latest day to start to open on the projected opening date of the route (openingDate when reachable); never before today for a step to do'),
  floatDays: z
    .number()
    .int()
    .describe('Spare days against the projected opening date of the route, or its openingDate when it is reachable; never negative for a step to do'),
  overdue: z.boolean().describe('The opening date chosen for the route cannot be met because of this step, and it can be started today'),
  onCriticalPath: z
    .boolean()
    .describe('Not done and has the fewest spare days among the critical and ops steps to do; among the support steps once only they are left'),
  waitingFor: z.array(TaskRefSchema).describe('Unfinished prerequisites'),
});

export const TaskDetailSchema = TaskSummarySchema.extend({
  why: z.string(),
  doNow: z.string(),
  prepare: z.array(z.string()),
  doneWhen: z.string(),
  durationDays: z.number().int(),
  latestFinish: z.iso
    .date()
    .describe('Latest day to finish to open on the projected opening date of the route (openingDate when reachable); moves with latestStart'),
  dependsOn: z.array(TaskRefSchema),
  source: z
    .object({ url: z.string().nullable(), title: z.string().nullable(), checkedAt: z.string().nullable() })
    .nullable()
    .describe('Official source and the date it was checked'),
  places: z.array(PlaceViewSchema).describe('Physical places for this step (official address, verified source), in card order'),
});

export const ReadinessSchema = z.object({
  done: z.number().int(),
  total: z.number().int(),
  percent: z.number().int().min(0).max(100),
  criticalDone: z.number().int(),
  criticalTotal: z.number().int(),
});

export const RouteViewSchema = z.object({
  pack: z.object({ id: z.string(), version: z.string(), title: z.string(), checkedAt: z.string(), disclaimer: z.string().nullable() }),
  openingDate: z.iso.date(),
  projectedOpeningDate: z.iso
    .date()
    .nullable()
    .describe(
      'Earliest reachable opening date when openingDate cannot be met if the remaining steps start today; step dates count from it. ' +
        'null — openingDate is reachable',
    ),
  today: z.iso.date(),
  daysToOpening: z.number().int(),
  readiness: ReadinessSchema,
  nextStep: TaskSummarySchema.nullable(),
  blockers: z.array(TaskSummarySchema).max(3),
  lanes: z.object({
    critical: z.array(TaskSummarySchema),
    ops: z.array(TaskSummarySchema),
    support: z.array(TaskSummarySchema),
  }),
  places: z
    .array(RoutePlaceSchema)
    .describe('Physical places of the route steps (official address, verified source), each once, in route order'),
});

export type PlaceView = z.infer<typeof PlaceViewSchema>;
export type RoutePlace = z.infer<typeof RoutePlaceSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type RouteView = z.infer<typeof RouteViewSchema>;

function refs(route: Route, ids: string[]) {
  return ids.map((id) => ({ id, title: route.steps.find((s) => s.action.id === id)?.action.title ?? id }));
}

function toPlaceView(place: Place): PlaceView {
  const { id, name, short_name, address, lat, lon, osm, note, source } = place;
  return {
    id,
    name,
    shortName: short_name ?? null,
    address,
    lat,
    lon,
    note: note ?? null,
    // node/<id>, way/<id> and relation/<id> are also the paths of their pages on openstreetmap.org.
    osmUrl: osm ? `https://www.openstreetmap.org/${osm}` : null,
    source: { url: source.url, title: source.title, checkedAt: source.checked_at },
  };
}

/** Places of a step in the order of its card; the pack is validated, so every id is in the catalog. */
function placesOf(step: RouteStep, pack: RulesPack): Place[] {
  return step.action.places.flatMap((id) => pack.places.find((p) => p.id === id) ?? []);
}

/** Places of the route steps without repeats, in the order the route first reaches them. */
function routePlaces(route: Route, pack: RulesPack): RoutePlace[] {
  const byId = new Map<string, RoutePlace>();
  for (const step of route.steps) {
    for (const place of placesOf(step, pack)) {
      const ref = { id: step.action.id, title: step.action.title };
      const seen = byId.get(place.id);
      if (seen) seen.actions.push(ref);
      else byId.set(place.id, { ...toPlaceView(place), actions: [ref] });
    }
  }
  return [...byId.values()];
}

export function toTaskSummary(route: Route, step: RouteStep): TaskSummary {
  return {
    id: step.action.id,
    title: step.action.title,
    lane: step.action.lane,
    kind: step.action.kind,
    status: step.status,
    latestStart: step.latestStart,
    floatDays: step.floatDays,
    overdue: step.overdue,
    onCriticalPath: step.onCriticalPath,
    waitingFor: refs(route, step.waitingFor),
  };
}

/** `pack` is the pack the route was built from: it holds the places the card refers to. */
export function toTaskDetail(route: Route, step: RouteStep, pack: RulesPack): TaskDetail {
  const { source } = step.action;
  return {
    ...toTaskSummary(route, step),
    why: step.action.why,
    doNow: step.action.do_now,
    prepare: step.action.prepare,
    doneWhen: step.action.done_when,
    durationDays: step.action.duration_days,
    latestFinish: step.latestFinish,
    dependsOn: refs(route, step.dependsOn),
    source: source ? { url: source.url ?? null, title: source.title ?? null, checkedAt: source.checked_at ?? null } : null,
    places: placesOf(step, pack).map(toPlaceView),
  };
}

export function toRouteView(route: Route, pack: RulesPack): RouteView {
  const summary = (step: RouteStep) => toTaskSummary(route, step);
  const inLane = (lane: (typeof LANES)[number]) => route.steps.filter((s) => s.action.lane === lane).map(summary);
  const next = nextBestStep(route);

  return {
    pack: {
      id: pack.manifest.id,
      version: pack.manifest.version,
      title: pack.manifest.title,
      checkedAt: pack.manifest.checked_at,
      disclaimer: pack.manifest.disclaimer ?? null,
    },
    openingDate: route.openingDate,
    projectedOpeningDate: route.projectedOpeningDate,
    today: route.today,
    daysToOpening: route.daysToOpening,
    readiness: readiness(route),
    nextStep: next ? summary(next) : null,
    blockers: topBlockers(route).map(summary),
    lanes: { critical: inLane('critical'), ops: inLane('ops'), support: inLane('support') },
    places: routePlaces(route, pack),
  };
}
