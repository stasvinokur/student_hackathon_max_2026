import { cellFactors, placeTitle } from './explain.js';
import {
  IMPORTANCE,
  IMPORTANCE_WEIGHT,
  type Importance,
  type LocationCriterion,
  type LocationIndex,
  type SaturationCriterion,
} from './schema.js';

// Scoring in the browser (doc-3 §3.4–3.6): the snapshot holds levels and facts, the user's importance
// turns them into a percentile index. The snapshot's columns are plain number arrays read in place and the
// results are typed arrays, with no object per cell: 5 thousand cells × 10 criteria take about 2 ms,
// so the map can rescore on every change.

/** Importance chosen by the user per criterion id; other criteria keep the snapshot defaults. */
export type LocationSettings = Readonly<Partial<Record<string, Importance>>>;

export interface ScoreOptions {
  /** Size of the top; the snapshot's top.size by default. */
  topN?: number;
  /** Least Chebyshev distance between top places, in cells; the snapshot's top.minSpacingCells by default. */
  minSpacingCells?: number;
}

/**
 * Competition relative to demand, per cell (doc-3 §3.5). It depends on the snapshot only: demand deciles
 * use the methodology's default weights, not the user's.
 */
export interface Competition {
  /** Coffee shops + indirectWeight × other cafes. */
  local: Float64Array;
  /** Usual competition: the median `local` of each demand decile (0 for an empty decile). */
  expected: number[];
  /** Decile 0–9 of demand by the methodology's default weights, over all cells; equal demand, equal decile. */
  decile: Uint8Array;
  /** (local + 1) / (expected + 1). */
  ratio: Float64Array;
  /** Saturation S: up to 1 above the usual, down to −nicheBonus below it. */
  s: Float64Array;
}

export interface TopPlace {
  cell: number;
  rank: number;
  score: number;
  title: string;
  /** Facts of the (at most) two criteria that add the most to the score. */
  highlights: string[];
}

export type ScoreWarning = 'no_demand_criteria' | 'no_candidates';

export interface ScoreResult {
  /** Percentile 0–100 among candidates; null for excluded cells and when no demand criterion is on. */
  scores: Array<number | null>;
  /** (D − P) / Σ demand weights; 0 when no demand criterion is on. */
  raw: Float64Array;
  /** D: Σ weight × level over demand criteria, with the user's weights. */
  demand: Float64Array;
  /** Null when the snapshot has no saturation criterion; the same whatever the settings, even with competitors off. */
  competition: Competition | null;
  /** Cells that pass every required criterion: the M of «N-е место из M» in the rank of a cell. */
  candidates: number;
  top: TopPlace[];
  warnings: ScoreWarning[];
  /** Importance in effect per criterion, aligned with ix.criteria. */
  importance: Importance[];
  /** Index of the first required criterion a cell fails, −1 when it fails none. */
  excludedBy: Int16Array;
}

/**
 * Scores every cell of a snapshot accepted by parseLocationIndex:
 * raw = (D − P) / Σ w_demand, P = Σ w·L over shares + w·100·S for saturation; `required` criteria
 * drop cells (demand: level 0; share: the share reaches excludeShare; saturation: the ratio reaches
 * excludeRatio); the score is the percentile of raw among the remaining cells.
 * S compares a cell with cells of similar demand by the methodology's default weights, so it does not move
 * with the settings: raising the weight of a demand criterion never drops a cell below one with less of it.
 */
export function scoreLocations(ix: LocationIndex, settings?: LocationSettings | null, opts: ScoreOptions = {}): ScoreResult {
  const count = ix.cells.row.length;
  const chosen = settingsOf(settings);
  const importance = ix.criteria.map((criterion) => importanceOf(criterion, chosen));
  const weights = importance.map((value) => IMPORTANCE_WEIGHT[value]);

  const demand = new Float64Array(count);
  const penalty = new Float64Array(count);
  let demandWeight = 0;
  ix.criteria.forEach((criterion, c) => {
    const weight = weights[c]!;
    if (criterion.model === 'saturation' || weight === 0) return;
    const level = levelColumn(ix, criterion.id);
    const sum = criterion.model === 'decay' ? demand : penalty;
    if (criterion.model === 'decay') demandWeight += weight;
    for (let i = 0; i < count; i++) sum[i] = sum[i]! + weight * level[i]!;
  });

  const saturationAt = ix.criteria.findIndex((criterion) => criterion.model === 'saturation');
  const saturationCriterion = ix.criteria[saturationAt];
  const competition = saturationCriterion?.model === 'saturation' ? saturation(ix, saturationCriterion) : null;
  const saturationWeight = weights[saturationAt] ?? 0;
  if (competition && saturationWeight > 0) {
    for (let i = 0; i < count; i++) penalty[i] = penalty[i]! + saturationWeight * 100 * competition.s[i]!;
  }

  const excludedBy = new Int16Array(count).fill(-1);
  ix.criteria.forEach((criterion, c) => {
    if (importance[c] !== 'required') return;
    const fails = requirementCheck(ix, criterion, competition);
    for (let i = 0; i < count; i++) if (excludedBy[i] === -1 && fails(i)) excludedBy[i] = c;
  });

  const raw = new Float64Array(count);
  const candidate = new Uint8Array(count);
  let candidates = 0;
  for (let i = 0; i < count; i++) {
    if (demandWeight > 0) raw[i] = (demand[i]! - penalty[i]!) / demandWeight;
    if (excludedBy[i] === -1) {
      candidate[i] = 1;
      candidates++;
    }
  }

  const warnings: ScoreWarning[] = [];
  if (demandWeight === 0) warnings.push('no_demand_criteria');
  if (candidates === 0) warnings.push('no_candidates');
  const scores = demandWeight > 0 ? percentileScores(raw, candidate) : new Array<number | null>(count).fill(null);

  const result: ScoreResult = { scores, raw, demand, competition, candidates, top: [], warnings, importance, excludedBy };
  result.top = spacedTop(ix, result, opts.topN ?? ix.top.size, opts.minSpacingCells ?? ix.top.minSpacingCells);
  return result;
}

/**
 * Competition relative to demand (doc-3 §3.5): local = n + indirectWeight·m; the usual competition E is
 * the median local of the cell's decile of demand by the methodology's default weights, taken over all
 * cells; r = (local + 1) / (E + 1); S = min(1, log2(r) / 2) when r ≥ 1, otherwise −nicheBonus · min(1, −log2 r).
 *
 * "Similar demand" is a property of the place, so it ignores the user's weights: otherwise switching a
 * criterion on would move cells between deciles and could push a cell with more of it below one with less.
 */
export function saturation(ix: LocationIndex, criterion: SaturationCriterion): Competition {
  const count = ix.cells.row.length;
  const columns = ix.cells.fact[criterion.id];
  const n = columns?.n;
  const m = columns?.m;
  if (!n || !m) throw new Error(`no competitor columns "${criterion.id}" in a validated snapshot`);
  const { indirectWeight, nicheBonus } = criterion.saturation;

  const local = new Float64Array(count);
  for (let i = 0; i < count; i++) local[i] = n[i]! + indirectWeight * m[i]!;

  // Without default demand criteria every cell has demand 0 and all fall into decile 0.
  const demand = new Float64Array(count);
  for (const c of ix.criteria) {
    const weight = IMPORTANCE_WEIGHT[c.defaultImportance];
    if (c.model !== 'decay' || weight === 0) continue;
    const level = levelColumn(ix, c.id);
    for (let i = 0; i < count; i++) demand[i] = demand[i]! + weight * level[i]!;
  }

  // Decile by the number of cells with strictly lower demand, so equal demand shares a decile.
  const sorted = Float64Array.from(demand).sort();
  const decile = new Uint8Array(count);
  const starts = new Int32Array(11);
  for (let i = 0; i < count; i++) {
    const q = Math.floor((10 * lowerBound(sorted, demand[i]!)) / count);
    decile[i] = q;
    starts[q + 1] = starts[q + 1]! + 1;
  }
  for (let q = 0; q < 10; q++) starts[q + 1] = starts[q + 1]! + starts[q]!;

  // Group local values by decile (counting sort), then take each group's median.
  const grouped = new Float64Array(count);
  const next = starts.slice(0, 10);
  for (let i = 0; i < count; i++) {
    const q = decile[i]!;
    grouped[next[q]!] = local[i]!;
    next[q] = next[q]! + 1;
  }
  const expected: number[] = [];
  for (let q = 0; q < 10; q++) expected.push(median(grouped.subarray(starts[q]!, starts[q + 1]!).sort()));

  const ratio = new Float64Array(count);
  const s = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const r = (local[i]! + 1) / (expected[decile[i]!]! + 1);
    ratio[i] = r;
    s[i] = r >= 1 ? Math.min(1, Math.log2(r) / 2) : -nicheBonus * Math.min(1, -Math.log2(r));
  }
  return { local, expected, decile, ratio, s };
}

/**
 * Percentile among candidates (doc-3 §3.4): round(100·k / (m − 1)), k — candidates with a strictly lower
 * raw, m — candidates; equal raw values get the same score, a single candidate gets 100.
 */
export function percentileScores(raw: ArrayLike<number>, candidate: ArrayLike<number>): Array<number | null> {
  let m = 0;
  for (let i = 0; i < raw.length; i++) if (candidate[i]) m++;
  const sorted = new Float64Array(m);
  for (let i = 0, j = 0; i < raw.length; i++) if (candidate[i]) sorted[j++] = raw[i]!;
  sorted.sort();

  const scores: Array<number | null> = [];
  for (let i = 0; i < raw.length; i++) {
    if (!candidate[i]) scores.push(null);
    else scores.push(m === 1 ? 100 : Math.round((100 * lowerBound(sorted, raw[i]!)) / (m - 1)));
  }
  return scores;
}

/**
 * The best candidates spread over the city: ordered by raw, then demand, then cell index, a cell is
 * taken when it is at least minSpacingCells rows or columns away from every place already taken.
 */
export function spacedTop(ix: LocationIndex, result: ScoreResult, topN: number, minSpacingCells: number): TopPlace[] {
  const { raw, demand, scores } = result;
  const { row, col } = ix.cells;
  const order: number[] = [];
  for (let i = 0; i < scores.length; i++) if (scores[i] !== null) order.push(i);
  order.sort((a, b) => raw[b]! - raw[a]! || demand[b]! - demand[a]! || a - b);

  const top: TopPlace[] = [];
  let rank = 0;
  for (let p = 0; p < order.length && top.length < topN; p++) {
    const cell = order[p]!;
    if (p === 0 || raw[cell]! < raw[order[p - 1]!]!) rank = p + 1;
    if (!farFrom(top, cell, row, col, minSpacingCells)) continue;
    const highlights = cellFactors(ix, result, cell)
      .filter((factor) => factor.points > 0)
      .slice(0, 2)
      .map((factor) => factor.fact);
    top.push({ cell, rank, score: scores[cell]!, title: placeTitle(ix, cell), highlights });
  }
  return top;
}

function farFrom(top: readonly TopPlace[], cell: number, row: readonly number[], col: readonly number[], spacing: number): boolean {
  for (const place of top) {
    const distance = Math.max(Math.abs(row[cell]! - row[place.cell]!), Math.abs(col[cell]! - col[place.cell]!));
    if (distance < spacing) return false;
  }
  return true;
}

/** Settings come from local storage: null, an array or any other non-object there means no settings. */
function settingsOf(settings: unknown): LocationSettings {
  if (typeof settings !== 'object' || settings === null) return {};
  const prototype: unknown = Object.getPrototypeOf(settings);
  return prototype === Object.prototype || prototype === null ? (settings as LocationSettings) : {};
}

/** Settings over the default; an unknown value (say, from old local storage) keeps the default. */
function importanceOf(criterion: LocationCriterion, settings: LocationSettings): Importance {
  const chosen: unknown = Object.hasOwn(settings, criterion.id) ? settings[criterion.id] : undefined;
  return typeof chosen === 'string' && (IMPORTANCE as readonly string[]).includes(chosen) ? (chosen as Importance) : criterion.defaultImportance;
}

/** Whether a cell fails a criterion marked `required` (doc-3 §3.6). */
function requirementCheck(ix: LocationIndex, criterion: LocationCriterion, competition: Competition | null): (cell: number) => boolean {
  switch (criterion.model) {
    case 'decay': {
      const level = levelColumn(ix, criterion.id);
      return (cell) => level[cell]! <= 0;
    }
    case 'share': {
      // Compare as a share: 30 / 100 is exactly 0.3, while 0.3 * 100 is not exactly 30.
      const level = levelColumn(ix, criterion.id);
      return (cell) => level[cell]! / 100 >= criterion.excludeShare;
    }
    case 'saturation': {
      const ratio = competition?.ratio;
      return (cell) => ratio !== undefined && ratio[cell]! >= criterion.saturation.excludeRatio;
    }
  }
}

function levelColumn(ix: LocationIndex, id: string): readonly number[] {
  const level = ix.cells.level[id];
  if (!level) throw new Error(`no level column "${id}" in a validated snapshot`);
  return level;
}

/** First index whose value is not less than `value` in an ascending array. */
function lowerBound(sorted: Float64Array, value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid]! < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function median(sorted: Float64Array): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >>> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
