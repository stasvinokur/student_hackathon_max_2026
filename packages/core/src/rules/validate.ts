import { isPredicateField, PREDICATE_FIELDS } from '../profile.js';
import { inBox } from './region.js';
import { RulesPackSchema, type ActionCard, type Predicate, type RulesPack, type Scalar } from './schema.js';

export interface PackIssue {
  /** Location in the pack, e.g. "actions[3].source.url" or "actions[kkt-register].depends_on". */
  path: string;
  message: string;
}

export type ParsePackResult = { ok: true; pack: RulesPack } | { ok: false; issues: PackIssue[] };

/**
 * Validates raw pack data (already parsed from YAML/JSON by the shell).
 * A pack with any issue must not be loaded: better no route than an unverified one.
 */
export function parseRulesPack(raw: unknown): ParsePackResult {
  const parsed = RulesPackSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
    };
  }

  const pack = parsed.data;
  const issues = [
    ...checkUniqueIds(pack.actions),
    ...checkDependencies(pack.actions),
    ...checkSupportDependencies(pack.actions),
    ...checkRequiredBeforeOpening(pack.actions),
    ...checkSources(pack.actions),
    ...pack.actions.flatMap((action) =>
      action.applies_if ? checkPredicate(action.applies_if, `actions[${action.id}].applies_if`) : [],
    ),
    ...checkPlaces(pack),
  ];

  return issues.length > 0 ? { ok: false, issues } : { ok: true, pack };
}

/** Zod issue path → "actions[3].source.url". */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>(
    (acc, key) => (typeof key === 'number' ? `${acc}[${key}]` : acc ? `${acc}.${String(key)}` : String(key)),
    '',
  );
}

function checkUniqueIds(actions: ActionCard[]): PackIssue[] {
  const seen = new Set<string>();
  const issues: PackIssue[] = [];
  for (const action of actions) {
    if (seen.has(action.id)) {
      issues.push({ path: `actions[${action.id}].id`, message: `duplicate action id "${action.id}"` });
    }
    seen.add(action.id);
  }
  return issues;
}

function checkDependencies(actions: ActionCard[]): PackIssue[] {
  const ids = new Set(actions.map((a) => a.id));
  const issues: PackIssue[] = [];

  for (const action of actions) {
    const listed = new Set<string>();
    for (const dep of action.depends_on) {
      if (listed.has(dep)) {
        issues.push({ path: `actions[${action.id}].depends_on`, message: `duplicate action "${dep}" in depends_on` });
      } else if (dep === action.id) {
        issues.push({ path: `actions[${action.id}].depends_on`, message: `action "${action.id}" depends on itself` });
      } else if (!ids.has(dep)) {
        issues.push({ path: `actions[${action.id}].depends_on`, message: `unknown action "${dep}" in depends_on` });
      }
      listed.add(dep);
    }
  }

  const cycle = findCycle(actions);
  if (cycle) {
    issues.push({ path: `actions[${cycle[0]}].depends_on`, message: `dependency cycle: ${cycle.join(' → ')}` });
  }
  return issues;
}

/**
 * The route moves the opening for required steps only (critical and ops), and support steps are optional: a required
 * step waiting for an optional one would let a skipped improvement hold the opening back unnoticed.
 */
function checkSupportDependencies(actions: ActionCard[]): PackIssue[] {
  const lanes = new Map(actions.map((a) => [a.id, a.lane]));
  const issues: PackIssue[] = [];
  for (const action of actions) {
    if (action.lane === 'support') continue;
    for (const dep of new Set(action.depends_on)) {
      if (lanes.get(dep) !== 'support') continue;
      issues.push({
        path: `actions[${action.id}].depends_on`,
        message: `${action.lane} action "${action.id}" depends on support action "${dep}": an optional step cannot hold the opening back`,
      });
    }
  }
  return issues;
}

/**
 * Required steps are done before the opening: the earliest reachable opening counts from their finish, and one
 * finished after it would let the projected date fall before its own work is done, even before today. What may wait
 * until after the opening is an improvement: a support step.
 */
function checkRequiredBeforeOpening(actions: ActionCard[]): PackIssue[] {
  return actions
    .filter((action) => action.lane !== 'support' && action.due_days_before_opening < 0)
    .map((action) => ({
      path: `actions[${action.id}].due_days_before_opening`,
      message:
        `${action.lane} action "${action.id}" finishes after the opening (due_days_before_opening ${action.due_days_before_opening}): ` +
        'only a support step may',
    }));
}

/** Returns the first dependency cycle as a list of ids (first id repeated at the end), or null. */
export function findCycle(actions: ReadonlyArray<Pick<ActionCard, 'id' | 'depends_on'>>): string[] | null {
  const deps = new Map(actions.map((a) => [a.id, a.depends_on]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep) || dep === id) continue; // reported separately
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const action of actions) {
    const cycle = visit(action.id);
    if (cycle) return cycle;
  }
  return null;
}

function checkSources(actions: ActionCard[]): PackIssue[] {
  const issues: PackIssue[] = [];
  for (const action of actions) {
    // A critical action can stop the opening, and an official fact claims to be one:
    // both must point to a verifiable source with the date it was checked.
    if (action.lane !== 'critical' && action.kind !== 'official_fact') continue;
    const reason = action.lane === 'critical' ? 'critical action' : 'official_fact';
    if (!action.source?.url) {
      issues.push({ path: `actions[${action.id}].source.url`, message: `${reason} "${action.id}" must link to an official source (source.url)` });
    }
    if (!action.source?.checked_at) {
      issues.push({ path: `actions[${action.id}].source.checked_at`, message: `${reason} "${action.id}" must state when the source was checked (source.checked_at)` });
    }
  }
  return issues;
}

/**
 * Places are shown on the map as official addresses: ids are unique, coordinates lie in the region,
 * cards point only to existing places, and every place serves some card — an unused one is almost always a typo.
 */
function checkPlaces(pack: RulesPack): PackIssue[] {
  const issues: PackIssue[] = [];
  const { bbox } = pack.manifest.region;
  const ids = new Set<string>();

  for (const place of pack.places) {
    if (ids.has(place.id)) issues.push({ path: `places[${place.id}].id`, message: `duplicate place id "${place.id}"` });
    ids.add(place.id);
    if (bbox && !inBox(bbox, place.lat, place.lon)) {
      issues.push({
        path: `places[${place.id}]`,
        message:
          `place "${place.id}" (lat ${place.lat}, lon ${place.lon}) is outside manifest.region.bbox ` +
          `(south ${bbox.south}, west ${bbox.west}, north ${bbox.north}, east ${bbox.east})`,
      });
    }
  }

  const used = new Set<string>();
  for (const action of pack.actions) {
    const listed = new Set<string>();
    for (const id of action.places) {
      if (listed.has(id)) issues.push({ path: `actions[${action.id}].places`, message: `duplicate place "${id}" in places` });
      else if (!ids.has(id)) issues.push({ path: `actions[${action.id}].places`, message: `unknown place "${id}" in places` });
      listed.add(id);
      used.add(id);
    }
  }

  for (const id of ids) {
    if (!used.has(id)) issues.push({ path: `places[${id}]`, message: `unused place "${id}": no action lists it in places` });
  }
  return issues;
}

function checkPredicate(predicate: Predicate, path: string): PackIssue[] {
  if ('all' in predicate) return predicate.all.flatMap((p, i) => checkPredicate(p, `${path}.all[${i}]`));
  if ('any' in predicate) return predicate.any.flatMap((p, i) => checkPredicate(p, `${path}.any[${i}]`));
  if ('not' in predicate) return checkPredicate(predicate.not, `${path}.not`);

  const { field } = predicate;
  if (!isPredicateField(field)) {
    return [{ path: `${path}.field`, message: `unknown profile field "${field}"; allowed: ${Object.keys(PREDICATE_FIELDS).join(', ')}` }];
  }
  const spec = PREDICATE_FIELDS[field];

  if ('gt' in predicate || 'gte' in predicate || 'lt' in predicate || 'lte' in predicate) {
    return spec.type === 'number' ? [] : [{ path, message: `field "${field}" is not numeric, cannot compare with gt/gte/lt/lte` }];
  }

  const values: Scalar[] = 'eq' in predicate ? [predicate.eq] : predicate.in;
  return values.flatMap((value) => {
    const problem = valueProblem(field, spec, value);
    return problem ? [{ path, message: problem }] : [];
  });
}

function valueProblem(field: string, spec: (typeof PREDICATE_FIELDS)[keyof typeof PREDICATE_FIELDS], value: Scalar): string | null {
  switch (spec.type) {
    case 'enum':
      return typeof value === 'string' && (spec.values as readonly string[]).includes(value)
        ? null
        : `"${String(value)}" is not a valid value of "${field}"; allowed: ${spec.values.join(', ')}`;
    case 'string':
      return typeof value === 'string' ? null : `field "${field}" expects a string, got ${typeof value}`;
    case 'number':
      return typeof value === 'number' ? null : `field "${field}" expects a number, got ${typeof value}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `field "${field}" expects true/false, got ${typeof value}`;
  }
}
