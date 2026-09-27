import type { ZodError } from 'zod';
import { inBox } from '../rules/region.js';
import type { RulesPack } from '../rules/schema.js';
import { formatPath, type PackIssue } from '../rules/validate.js';
import {
  factColumns,
  FACT_COLUMNS,
  LocationCriteriaSchema,
  LocationIndexSchema,
  type LocationCriteria,
  type LocationFact,
  type LocationIndex,
} from './schema.js';

export type ParseLocationResult<T> = { ok: true; value: T } | { ok: false; issues: PackIssue[] };

/**
 * Validates the methodology config (already parsed from YAML by the shell).
 * The builder must not run on a config with any issue.
 */
export function parseLocationCriteria(raw: unknown): ParseLocationResult<LocationCriteria> {
  const parsed = LocationCriteriaSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };

  const config = parsed.data;
  const views = config.criteria.map((c) => ({ ...c, anchor: c.model === 'decay' ? c.title_anchor : undefined }));
  const issues = [...checkCriteria(views, 'title_anchor'), ...checkRepeats(config.linked_actions, 'linked_actions')];
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: config };
}

/**
 * Validates a location index snapshot (already parsed from JSON), and its links to the rules pack when given.
 * A snapshot with any issue must not be served: a wrong map is worse than no map.
 */
export function parseLocationIndex(raw: unknown, pack?: RulesPack): ParseLocationResult<LocationIndex> {
  const parsed = LocationIndexSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };

  const ix = parsed.data;
  const views = ix.criteria.map((c) => ({ ...c, anchor: c.model === 'decay' ? c.titleAnchor : undefined }));
  const issues = [
    ...checkCriteria(views, 'titleAnchor'),
    ...checkVersion(ix),
    ...checkRepeats(ix.linkedActions, 'linkedActions'),
    ...checkPlaces(ix),
    ...checkCells(ix),
    ...(pack ? checkPack(ix, pack) : []),
  ];
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: ix };
}

function zodIssues(error: ZodError): PackIssue[] {
  return error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message }));
}

function checkRepeats(actions: readonly string[], path: string): PackIssue[] {
  const seen = new Set<string>();
  const issues: PackIssue[] = [];
  for (const action of actions) {
    if (seen.has(action)) issues.push({ path, message: `duplicate action "${action}" in ${path}` });
    seen.add(action);
  }
  return issues;
}

// ---------- criteria (config and snapshot alike) ----------

interface CriterionView {
  id: string;
  role: 'demand' | 'penalty';
  model: 'decay' | 'saturation' | 'share';
  fact: LocationFact;
  anchor: { within: number; text: string } | undefined;
}

function checkCriteria(criteria: readonly CriterionView[], anchorKey: 'title_anchor' | 'titleAnchor'): PackIssue[] {
  const issues: PackIssue[] = [];
  const seen = new Set<string>();
  let saturation: string | undefined;

  for (const c of criteria) {
    if (seen.has(c.id)) issues.push({ path: `criteria[${c.id}].id`, message: `duplicate criterion id "${c.id}"` });
    seen.add(c.id);
    if (c.model !== 'saturation') continue;
    if (saturation === undefined) saturation = c.id;
    else issues.push({ path: `criteria[${c.id}].model`, message: `only one saturation criterion is allowed, "${saturation}" is already one` });
  }

  if (!criteria.some((c) => c.role === 'demand')) {
    issues.push({ path: 'criteria', message: 'at least one demand criterion is required' });
  }

  for (const c of criteria) {
    const path = `criteria[${c.id}]`;
    issues.push(...checkTemplate(c.fact.text, placeholders(c.fact, 'text'), `${path}.fact.text`));
    if (c.fact.type === 'nearest') issues.push(...checkTemplate(c.fact.unnamed, placeholders(c.fact, 'unnamed'), `${path}.fact.unnamed`));
    if (c.fact.none !== undefined) issues.push(...checkTemplate(c.fact.none, placeholders(c.fact, 'none'), `${path}.fact.none`));
    if (!c.anchor) continue;
    if (c.fact.type !== 'nearest') {
      issues.push({ path: `${path}.${anchorKey}`, message: 'a title anchor needs a fact of type nearest' });
    } else if (c.anchor.within > c.fact.max) {
      issues.push({ path: `${path}.${anchorKey}.within`, message: `must not exceed fact.max (${c.fact.max}): farther objects are not in the snapshot` });
    } else {
      issues.push(...checkTemplate(c.anchor.text, ['name', 'dist'], `${path}.${anchorKey}.text`));
    }
  }
  return issues;
}

/**
 * Placeholders a template can use: `unnamed` is shown for an object without a name and `none` when there is
 * no object, so neither can name one, and `none` has no distance either.
 */
function placeholders(fact: LocationFact, template: 'text' | 'unnamed' | 'none'): string[] {
  switch (fact.type) {
    case 'nearest': {
      const object = template === 'text' ? ['name', 'dist'] : template === 'unnamed' ? ['dist'] : [];
      return [...object, 'max', ...(fact.radius === undefined ? [] : ['n', 'radius'])];
    }
    case 'count':
      return ['n', 'radius', ...(fact.floors === undefined ? [] : ['m'])];
    case 'competitors':
      return ['n', 'm', 'radius'];
    case 'share':
      return template === 'text' ? ['pct'] : [];
  }
}

function checkTemplate(template: string, allowed: readonly string[], path: string): PackIssue[] {
  const unknown = [...template.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]!).filter((name) => !allowed.includes(name));
  if (unknown.length === 0) return [];
  const list = (names: readonly string[]) => (names.length > 0 ? names.map((name) => `{${name}}`).join(', ') : 'none');
  return [{ path, message: `unknown placeholder ${list(unknown)}; allowed: ${list(allowed)}` }];
}

// ---------- snapshot ----------

function checkVersion(ix: LocationIndex): PackIssue[] {
  const expected = `${ix.source.osmBase.replace(/[-:]/g, '')}-${ix.source.configSha256.slice(0, 8)}`;
  return ix.version === expected
    ? []
    : [{ path: 'version', message: `version must be "${expected}": source.osmBase and the first 8 hex digits of source.configSha256` }];
}

function checkPlaces(ix: LocationIndex): PackIssue[] {
  return firstFailure(
    ix.places.length,
    (p) => {
      const kind = ix.places[p]![0];
      const owner = ix.criteria[kind];
      if (!owner) return `criterion index ${kind} does not exist (criteria: ${ix.criteria.length})`;
      return owner.fact.type === 'nearest' ? null : `criterion "${owner.id}" has no nearest fact, so it has no places`;
    },
    (p) => `places[${p}]`,
    'places',
  );
}

function checkCells(ix: LocationIndex): PackIssue[] {
  const { cells, criteria } = ix;
  const count = cells.row.length;
  const issues: PackIssue[] = [];
  const checkLength = (values: readonly number[], path: string) => {
    if (values.length !== count) issues.push({ path, message: `expected ${count} values, one per cell, got ${values.length}` });
  };

  checkLength(cells.col, 'cells.col');

  for (const c of criteria) {
    if (c.model === 'saturation') continue;
    const level = own(cells.level, c.id);
    if (level) checkLength(level, `cells.level.${c.id}`);
    else issues.push({ path: `cells.level.${c.id}`, message: `missing level column of criterion "${c.id}"` });
  }
  for (const key of Object.keys(cells.level)) {
    const c = criteria.find((criterion) => criterion.id === key);
    if (!c) issues.push({ path: `cells.level.${key}`, message: `unknown criterion "${key}"` });
    else if (c.model === 'saturation') issues.push({ path: `cells.level.${key}`, message: `criterion "${key}" has no level: saturation is computed from facts` });
  }

  criteria.forEach((c, index) => {
    const path = `cells.fact.${c.id}`;
    const needed = factColumns(c.fact);
    const columns = own(cells.fact, c.id);
    if (needed.length === 0) {
      if (columns) issues.push({ path, message: `a ${c.fact.type} fact has no columns` });
      return;
    }
    if (!columns) {
      issues.push({ path, message: `missing fact columns of criterion "${c.id}": ${needed.join(', ')}` });
      return;
    }
    for (const column of FACT_COLUMNS) {
      const values = columns[column];
      if (needed.includes(column) && values) checkLength(values, `${path}.${column}`);
      else if (needed.includes(column)) issues.push({ path: `${path}.${column}`, message: `missing column: a ${c.fact.type} fact needs ${needed.join(', ')}` });
      else if (values) issues.push({ path: `${path}.${column}`, message: `unexpected column: a ${c.fact.type} fact needs ${needed.join(', ')}` });
    }
    if (columns.near && needed.includes('near')) issues.push(...checkNear(ix, index, columns.near, `${path}.near`));
    if (c.fact.type === 'nearest' && columns.near && columns.dist) issues.push(...checkDist(c.fact.max, columns.near, columns.dist, `${path}.dist`));
  });
  for (const key of Object.keys(cells.fact)) {
    if (!criteria.some((c) => c.id === key)) issues.push({ path: `cells.fact.${key}`, message: `unknown criterion "${key}"` });
  }

  // Positions are compared across the two columns, so only when they line up.
  if (cells.col.length === count) issues.push(...checkPositions(ix));
  return issues;
}

/**
 * near is a place of the same criterion when the nearest object within fact.max has a name, −2 when it has none,
 * −1 when there is no object within fact.max (the schema allows nothing lower).
 */
function checkNear(ix: LocationIndex, criterion: number, near: readonly number[], path: string): PackIssue[] {
  return firstFailure(
    near.length,
    (i) => {
      const p = near[i]!;
      if (p < 0) return null;
      const place = ix.places[p];
      if (!place) return `place ${p} does not exist (places: ${ix.places.length})`;
      const owner = ix.criteria[place[0]];
      // A place of a missing criterion is reported under places.
      return owner && place[0] !== criterion ? `place ${p} belongs to criterion "${owner.id}"` : null;
    },
    (i) => `${path}[${i}]`,
    'cells',
  );
}

/**
 * dist is the distance to the nearest object within fact.max, named or not (near ≥ 0 or −2); without one
 * (near = −1) there is no distance to store.
 */
function checkDist(max: number, near: readonly number[], dist: readonly number[], path: string): PackIssue[] {
  return firstFailure(
    Math.min(near.length, dist.length),
    (i) => {
      const d = dist[i]!;
      if (near[i] === -1) return d === 0 ? null : `dist must be 0 when near is -1, got ${d}`;
      return d <= max ? null : `dist ${d} is beyond fact.max (${max})`;
    },
    (i) => `${path}[${i}]`,
    'cells',
  );
}

function checkPositions(ix: LocationIndex): PackIssue[] {
  const { row, col } = ix.cells;
  const { rows, cols } = ix.grid;
  const at = (i: number) => `(${row[i]}, ${col[i]})`;
  const decreasing = (i: number) => row[i]! < row[i - 1]!;
  return [
    ...firstFailure(row.length, (i) => (row[i]! < rows ? null : `row ${row[i]} is outside the grid (rows: ${rows})`), (i) => `cells.row[${i}]`, 'cells'),
    ...firstFailure(col.length, (i) => (col[i]! < cols ? null : `col ${col[i]} is outside the grid (cols: ${cols})`), (i) => `cells.col[${i}]`, 'cells'),
    ...firstFailure(
      row.length,
      (i) => {
        if (i === 0 || row[i]! > row[i - 1]! || (row[i] === row[i - 1] && col[i]! > col[i - 1]!)) return null;
        if (row[i] === row[i - 1] && col[i] === col[i - 1]) return `cell ${at(i)} is listed twice`;
        return `cell ${at(i)} comes after ${at(i - 1)}: cells must be sorted by row, then col`;
      },
      (i) => (decreasing(i) ? `cells.row[${i}]` : `cells.col[${i}]`),
      'cells',
    ),
  ];
}

function checkPack(ix: LocationIndex, pack: RulesPack): PackIssue[] {
  const { id, region } = pack.manifest;
  const issues: PackIssue[] = [];
  if (ix.pack !== id) issues.push({ path: 'pack', message: `snapshot of pack "${ix.pack}" does not belong to pack "${id}"` });

  const actions = new Set(pack.actions.map((a) => a.id));
  for (const action of ix.linkedActions) {
    if (!actions.has(action)) issues.push({ path: 'linkedActions', message: `unknown action "${action}" in linkedActions` });
  }

  const { bbox } = region;
  if (!bbox) return issues;
  const { lat, lon } = ix.grid.origin;
  if (!inBox(bbox, lat, lon)) {
    issues.push({ path: 'grid.origin', message: `grid origin ${lat}, ${lon} is outside the region bbox of pack "${id}"` });
  }
  issues.push(
    ...firstFailure(
      ix.places.length,
      (p) => {
        const [, name, placeLat, placeLon] = ix.places[p]!;
        return inBox(bbox, placeLat, placeLon) ? null : `place "${name}" (${placeLat}, ${placeLon}) is outside the region bbox of pack "${id}"`;
      },
      (p) => `places[${p}]`,
      'places',
    ),
  );
  return issues;
}

// ---------- helpers ----------

/** Own property only: criterion ids such as "constructor" must not reach Object.prototype. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * One issue for the first failing element, with the number of failing elements: a broken builder
 * would otherwise report thousands of cells.
 */
function firstFailure(length: number, problem: (i: number) => string | null, path: (i: number) => string, unit: string): PackIssue[] {
  let first: PackIssue | undefined;
  let failures = 0;
  for (let i = 0; i < length; i++) {
    const message = problem(i);
    if (message === null) continue;
    failures++;
    first ??= { path: path(i), message };
  }
  if (!first) return [];
  return [failures > 1 ? { ...first, message: `${first.message}; ${failures} ${unit} in total` } : first];
}
