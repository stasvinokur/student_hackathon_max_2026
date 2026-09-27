import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cellAt,
  explainCell,
  KEBAB_ID,
  parseLocationCriteria,
  type CompetitionVerdict,
  type LocationCriteria,
  type LocationIndex,
  type ScoreResult,
} from '@otkryvay/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { LOCATION_INDEX_FILE } from '../../shell/content/location-index.js';
import { plain } from './format.js';

// The location files of a rules pack (doc-3 §4.1): the methodology a person edits, the reference points the
// snapshot is checked against, and the way the snapshot is written.

export const CRITERIA_FILE = 'location-criteria.yaml';
export const FIXTURES_FILE = 'location-fixtures.yaml';
/** Where the API reads the snapshot from. */
export const SNAPSHOT_FILE = LOCATION_INDEX_FILE;

export interface LoadedCriteria {
  config: LocationCriteria;
  /** sha256 (hex) of the file as it lies on disk: the snapshot is stale when it differs from source.configSha256. */
  sha256: string;
  path: string;
}

/** Reads content/<pack>/location-criteria.yaml and validates it; throws with every issue and its path. */
export async function loadLocationCriteria(contentDir: string, packId: string): Promise<LoadedCriteria> {
  const path = join(contentDir, packId, CRITERIA_FILE);
  const bytes = await readFile(path);
  const result = parseLocationCriteria(parseYaml(bytes.toString('utf8')));
  if (!result.ok) {
    throw new Error(`the location criteria of pack "${packId}" are invalid:\n${result.issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`);
  }
  return { config: result.value, sha256: createHash('sha256').update(bytes).digest('hex'), path };
}

// ---------- the snapshot file ----------

/**
 * The snapshot as JSON that is compact and still reads well in a diff: objects one key per line, an array of
 * plain values (a cell column, a place) on one line, so a rebuild shows which columns and places changed.
 */
export function serializeLocationIndex(ix: LocationIndex): string {
  return `${write(ix, '')}\n`;
}

function write(value: unknown, indent: string): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== 'object')) return JSON.stringify(value);
    return `[\n${value.map((item) => `${inner}${write(item, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return '{}';
    return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${write(item, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

// ---------- reference points ----------

/** A number is exact; min and max are inclusive. */
const BoundSchema = z.union([z.number(), z.strictObject({ min: z.number().optional(), max: z.number().optional() })]);
type Bound = z.infer<typeof BoundSchema>;

const IncludedSchema = z.strictObject({
  included: z.literal(true),
  /** Levels 0–100 by criterion id. */
  level: z.record(z.string(), BoundSchema).optional(),
  /** The index 0–100 with the default importance of every criterion. */
  score: BoundSchema.optional(),
  /** Words the fact of a criterion must contain, as the card shows it (spaces in place of no-break spaces). */
  fact: z.record(z.string(), z.string().min(1)).optional(),
  /** Words the name of the place must contain. */
  title: z.string().min(1).optional(),
  /**
   * A place of the top with the default importance lies at most this many cells away (Chebyshev distance: rows
   * and columns). The top keeps its places min_spacing_cells apart, so a good spot may be represented by its neighbour.
   */
  top_within_cells: z.number().int().min(0).optional(),
  /** Competition verdict with the default importance. */
  verdict: z.enum(['saturated', 'usual', 'niche']).optional(),
});

const ReferencePointSchema = z.strictObject({
  id: z.string().regex(KEBAB_ID, 'id must be kebab-case'),
  title: z.string().min(1),
  /** Where the coordinates come from and what the point checks. */
  note: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  expect: z.discriminatedUnion('included', [IncludedSchema, z.strictObject({ included: z.literal(false) })]),
});

export const LocationFixturesSchema = z.strictObject({
  pack: z.string().min(1),
  points: z.array(ReferencePointSchema).min(1),
});

export type LocationFixtures = z.infer<typeof LocationFixturesSchema>;
export type ReferencePoint = LocationFixtures['points'][number];

/** Reads content/<pack>/location-fixtures.yaml; undefined when the pack has none. */
export async function loadLocationFixtures(contentDir: string, packId: string): Promise<LocationFixtures | undefined> {
  let text: string;
  try {
    text = await readFile(join(contentDir, packId, FIXTURES_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = LocationFixturesSchema.safeParse(parseYaml(text));
  if (!parsed.success) throw new Error(`the location fixtures of pack "${packId}" are invalid:\n${z.prettifyError(parsed.error)}`);
  if (parsed.data.pack !== packId) throw new Error(`the location fixtures belong to pack "${parsed.data.pack}", not "${packId}"`);
  return parsed.data;
}

export interface ReferencePointCheck {
  point: ReferencePoint;
  /** Index of the point's cell in the snapshot, or −1 when the cell is not in the index. */
  cell: number;
  /** What differs from the expectation; empty when the point passes. */
  failures: string[];
  /** What the snapshot says about the point, for the report. */
  summary: string;
}

/** Checks a reference point against a snapshot scored with the default importance (`result`). */
export function checkReferencePoint(ix: LocationIndex, result: ScoreResult, point: ReferencePoint): ReferencePointCheck {
  const at = cellAt(ix.grid, point.lat, point.lon);
  const cell = at ? cellIndex(ix, at.row, at.col) : -1;
  const where = at ? `cell (${at.row}, ${at.col})` : 'outside the grid';
  const failures: string[] = [];
  const { expect } = point;

  if (!expect.included) {
    if (cell >= 0) failures.push(`${where} is in the index, expected it not to be`);
    return { point, cell, failures, summary: cell >= 0 ? `${where} in the index` : `${where} not in the index` };
  }
  if (cell < 0) return { point, cell, failures: [`${where} is not in the index`], summary: `${where} not in the index` };

  const explanation = explainCell(ix, result, cell);
  for (const [id, bound] of Object.entries(expect.level ?? {})) {
    const level = ix.cells.level[id]?.[cell];
    if (level === undefined) failures.push(`criterion "${id}" has no level`);
    else if (!inBound(level, bound)) failures.push(`level of "${id}" is ${level}, expected ${describeBound(bound)}`);
  }
  if (expect.score !== undefined) {
    const score = result.scores[cell] ?? null;
    if (score === null || !inBound(score, expect.score)) failures.push(`index is ${score}, expected ${describeBound(expect.score)}`);
  }
  for (const [id, words] of Object.entries(expect.fact ?? {})) {
    const factor = explanation.factors.find((f) => f.id === id);
    if (!factor) failures.push(`criterion "${id}" has no fact`);
    else if (!plain(factor.fact).includes(words)) failures.push(`fact of "${id}" is «${plain(factor.fact)}», expected it to contain «${words}»`);
  }
  if (expect.title !== undefined && !plain(explanation.title).includes(expect.title)) {
    failures.push(`title is «${plain(explanation.title)}», expected it to contain «${expect.title}»`);
  }
  const nearestTop = topDistance(ix, result, cell);
  if (expect.top_within_cells !== undefined && !(nearestTop <= expect.top_within_cells)) {
    const found = Number.isFinite(nearestTop) ? `the nearest place of the top is ${nearestTop} cells away` : 'the top is empty';
    failures.push(`${found}, expected at most ${expect.top_within_cells}`);
  }
  const verdict: CompetitionVerdict | undefined = explanation.competition?.verdict;
  if (expect.verdict !== undefined && verdict !== expect.verdict) failures.push(`competition is ${verdict ?? 'not rated'}, expected ${expect.verdict}`);

  const levels = Object.entries(ix.cells.level)
    .map(([id, column]) => `${id} ${column[cell]}`)
    .join(', ');
  const summary =
    `${where} «${plain(explanation.title)}», index ${explanation.score ?? '—'}, top ${Number.isFinite(nearestTop) ? `${nearestTop} cells away` : '—'}; ` +
    `levels: ${levels}`;
  return { point, cell, failures, summary };
}

/** Index of the cell (row, col) in the snapshot, or −1; cells are sorted by row, then col. */
function cellIndex(ix: LocationIndex, row: number, col: number): number {
  const rows = ix.cells.row;
  const cols = ix.cells.col;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid]! < row || (rows[mid] === row && cols[mid]! < col)) low = mid + 1;
    else high = mid;
  }
  return low < rows.length && rows[low] === row && cols[low] === col ? low : -1;
}

/** Chebyshev distance in cells from a cell to the nearest place of the top; Infinity when the top is empty. */
function topDistance(ix: LocationIndex, result: ScoreResult, cell: number): number {
  const { row, col } = ix.cells;
  let nearest = Infinity;
  for (const place of result.top) {
    nearest = Math.min(nearest, Math.max(Math.abs(row[place.cell]! - row[cell]!), Math.abs(col[place.cell]! - col[cell]!)));
  }
  return nearest;
}

function inBound(value: number, bound: Bound): boolean {
  if (typeof bound === 'number') return value === bound;
  return (bound.min === undefined || value >= bound.min) && (bound.max === undefined || value <= bound.max);
}

function describeBound(bound: Bound): string {
  if (typeof bound === 'number') return String(bound);
  if (bound.min !== undefined && bound.max !== undefined) return `${bound.min}–${bound.max}`;
  if (bound.min !== undefined) return `at least ${bound.min}`;
  return bound.max === undefined ? 'any value' : `at most ${bound.max}`;
}
