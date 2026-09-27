import type { BBox, LocationCriterionConfig, LocationIndex, OsmFeature, ScoreResult } from '@otkryvay/core';
import type { ReferencePointCheck } from './content.js';
import { formatBytes, plain } from './format.js';

// What the pipeline tells about a run (doc-3 §4.4, step 10): how the OSM data looked, what the builder kept, how
// the levels and the competition came out, whether the reference points pass. Pure: numbers in, lines out.

/** What a layer of OSM data looked like and what became of it. */
export interface LayerCheck {
  id: string;
  /** Elements in the Overpass answer. */
  elements: number;
  /** Objects featuresFromOverpass made of them (an element without the needed geometry gives none). */
  features: number;
  /** Objects in the snapshot (featureCount): inside the bbox, after merging close ones. */
  kept: number;
  /** Objects left out as outside the bbox: a point outside it, a line or an area without a part inside. */
  outside: number;
  /** Objects merged into others (merge_within). */
  merged: number;
  /** Elements with an unresolved coordinate (null) in their geometry, and how many of them still gave an object. */
  withNulls: number;
  nullsKept: number;
  /** Elements with a coordinate outside the bbox in their geometry: the global [bbox] did not clip them. */
  beyondBbox: number;
  /** Names the core changed: control, direction or invisible characters, repeated spaces, over 120 characters. */
  cleanedNames: number;
  /** building:levels given but not a number of floors 1–150, so treated as not mapped. */
  badLevels: number;
}

interface RawElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number } | null>;
  members?: Array<{ geometry?: Array<{ lat: number; lon: number } | null> }>;
}

const PREFIX = { node: 'n', way: 'w', relation: 'r' } as const;

/**
 * Checks a layer against its Overpass answer (already accepted by featuresFromOverpass) and the snapshot.
 * `kept` is the featureCount of the criterion in the snapshot.
 */
export function checkLayer(json: unknown, criterion: LocationCriterionConfig, features: readonly OsmFeature[], bbox: BBox, kept: number): LayerCheck {
  const elements = (json as { elements: RawElement[] }).elements;
  const byKey = new Map(features.map((feature) => [feature.key, feature]));
  const check: LayerCheck = {
    id: criterion.id,
    elements: elements.length,
    features: features.length,
    kept,
    outside: 0,
    merged: 0,
    withNulls: 0,
    nullsKept: 0,
    beyondBbox: 0,
    cleanedNames: 0,
    badLevels: 0,
  };
  for (const element of elements) {
    const feature = byKey.get(`${PREFIX[element.type]}${element.id}`);
    const coordinates = [...(element.geometry ?? []), ...(element.members ?? []).flatMap((member) => member.geometry ?? [])];
    if (coordinates.some((point) => point === null)) {
      check.withNulls++;
      if (feature) check.nullsKept++;
    }
    if (coordinates.some((point) => point !== null && !inside(bbox, point.lat, point.lon))) check.beyondBbox++;
    const raw = rawName(element.tags ?? {});
    if (feature && raw !== undefined && feature.name !== raw) check.cleanedNames++;
    if (feature?.kind === 'point' && element.tags?.['building:levels'] !== undefined && feature.levels === undefined) check.badLevels++;
  }
  // Points are tested as the builder tests them; lines and areas are not merged, so what is missing was outside.
  const points = features.filter((feature) => feature.kind === 'point');
  if (points.length === features.length) {
    check.outside = points.filter((point) => !inside(bbox, point.lat, point.lon)).length;
    check.merged = features.length - check.outside - kept;
  } else {
    check.outside = features.length - kept;
  }
  return check;
}

/** name:ru, else name, as OSM has it (trimmed): what the core cleans. */
function rawName(tags: Readonly<Record<string, string>>): string | undefined {
  for (const key of ['name:ru', 'name']) {
    const value = tags[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function inside(bbox: BBox, lat: number, lon: number): boolean {
  return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
}

// ---------- the snapshot ----------

interface CompetitionStats {
  cells: number;
  saturated: number;
  usual: number;
  niche: number;
  /** Cells «Исключать» drops: the ratio reaches excludeRatio. */
  excluded: number;
  /** Cells without a coffee shop or a cafe within the radius. */
  empty: number;
  /** The usual competition of every demand decile. */
  expected: number[];
}

/** Verdicts of the competition with the default importance (doc-3 §3.5). */
function competitionStats(ix: LocationIndex, result: ScoreResult): CompetitionStats | undefined {
  const criterion = ix.criteria.find((c) => c.model === 'saturation');
  const { competition } = result;
  if (criterion?.model !== 'saturation' || !competition) return undefined;
  const { saturatedRatio, nicheRatio, excludeRatio } = criterion.saturation;
  const stats: CompetitionStats = { cells: competition.ratio.length, saturated: 0, usual: 0, niche: 0, excluded: 0, empty: 0, expected: competition.expected };
  competition.ratio.forEach((ratio, i) => {
    if (ratio >= saturatedRatio) stats.saturated++;
    else if (ratio <= nicheRatio) stats.niche++;
    else stats.usual++;
    if (ratio >= excludeRatio) stats.excluded++;
    if (competition.local[i] === 0) stats.empty++;
  });
  return stats;
}

// ---------- drops against the snapshot of the pack ----------

/** A count that fell against the snapshot of the pack. */
export interface Drop {
  what: string;
  before: number;
  after: number;
}

/** A fall by more than a fifth is worth a look: a city does not lose a fifth of its cafes between two slices. */
const DROP = 0.2;

/**
 * What fell by more than a fifth against the previous snapshot: objects of a criterion (featureCount), cells, and
 * buildings when the probe record of the previous time is at hand.
 */
export function dropsOf(previous: { ix: LocationIndex; buildings: number | undefined }, ix: LocationIndex, buildings: number): Drop[] {
  const drops: Drop[] = [];
  const compare = (what: string, before: number, after: number) => {
    if (after < before * (1 - DROP)) drops.push({ what, before, after });
  };
  for (const criterion of ix.criteria) {
    const before = previous.ix.criteria.find((c) => c.id === criterion.id);
    if (before) compare(criterion.id, before.featureCount, criterion.featureCount);
  }
  compare('cells', previous.ix.cells.row.length, ix.cells.row.length);
  if (previous.buildings !== undefined) compare('buildings', previous.buildings, buildings);
  return drops;
}

// ---------- the report ----------

export interface RunReport {
  pack: string;
  osmBase: string;
  /** The mirror that answered the probe (source.endpoint). */
  endpoint: string;
  configSha256: string;
  layers: readonly LayerCheck[];
  /** The mirror every layer came from, by criterion id (the probe record). */
  mirrors: Readonly<Record<string, string>>;
  buildings: { count: number; endpoint: string | undefined };
  ix: LocationIndex;
  result: ScoreResult;
  fixtures: readonly ReferencePointCheck[] | undefined;
  /** Counts that fell by more than a fifth against the snapshot of the pack of that time. */
  drops: { osmBase: string; drops: readonly Drop[] } | undefined;
  /** Where the snapshot went; `instead` — the snapshot of the pack a failed reference point left as it was. */
  written: { path: string; instead: string | undefined; failed: number };
  bytes: number;
  gzipBytes: number;
  seconds: number;
  /** Requests answered by a mirror and from the cache. */
  network: number;
  cached: number;
}

/** The report of a run, line by line. */
export function formatReport(report: RunReport): string[] {
  const { ix, result } = report;
  const count = ix.cells.row.length;
  const lines: string[] = [];
  lines.push(`location index of pack ${report.pack}: OSM ${report.osmBase} from ${report.endpoint}, config ${report.configSha256.slice(0, 8)}`);
  lines.push(`requests: ${report.network} to Overpass, ${report.cached} from the cache`);
  if (report.drops) {
    lines.push('');
    lines.push(`WARNING: much fewer objects than in the snapshot of the pack (OSM ${report.drops.osmBase}):`);
    for (const { what, before, after } of report.drops.drops) {
      lines.push(`  ${what}: ${before} → ${after} (−${Math.round((100 * (before - after)) / before)} %)`);
    }
  }
  lines.push('');

  lines.push(table(
    ['criterion', 'elements', 'objects', 'kept', 'merged', 'outside', 'P50', 'P95', 'level > 0', 'mirror'],
    ix.criteria.map((criterion) => {
      const layer = report.layers.find((l) => l.id === criterion.id);
      const level = ix.cells.level[criterion.id];
      const norm = criterion.model === 'saturation' ? undefined : criterion.norm;
      const positive = level ? level.filter((value) => value > 0).length : undefined;
      return [
        criterion.id,
        String(layer?.elements ?? '—'),
        String(layer?.features ?? '—'),
        String(criterion.featureCount),
        String(layer?.merged ?? '—'),
        String(layer?.outside ?? '—'),
        norm ? String(norm.p50) : '—',
        norm ? String(norm.p95) : '—',
        positive === undefined ? '—' : `${percent(positive, count)} (${positive})`,
        hostOf(report.mirrors[criterion.id]),
      ];
    }),
  ));
  lines.push(`buildings: ${report.buildings.count} centres from ${hostOf(report.buildings.endpoint)}`);
  lines.push('');

  const { rows, cols } = ix.grid;
  lines.push(`cells: ${count} in the index of ${rows * cols} (${rows} × ${cols} of ${ix.grid.cellMeters} m)`);
  const stats = competitionStats(ix, result);
  if (stats) {
    lines.push(
      `competition (default importance): saturated ${percent(stats.saturated, stats.cells)}, usual ${percent(stats.usual, stats.cells)}, ` +
        `niche ${percent(stats.niche, stats.cells)}; «Исключать» drops ${percent(stats.excluded, stats.cells)} (${stats.excluded}); ` +
        `no cafe within the radius: ${percent(stats.empty, stats.cells)}`,
    );
    lines.push(`usual competition by demand decile: ${stats.expected.map((value) => String(Math.round(value * 100) / 100)).join(' ')}`);
  }
  lines.push('');

  lines.push('data checks:');
  const nulls = report.layers.filter((l) => l.withNulls > 0).map((l) => `${l.id} ${l.withNulls} (${l.nullsKept} still gave an object)`);
  lines.push(`  unresolved coordinates (null) in geometry: ${nulls.length > 0 ? nulls.join(', ') : 'none'}`);
  const beyond = report.layers.filter((l) => l.beyondBbox > 0).map((l) => `${l.id} ${l.beyondBbox}`);
  lines.push(`  geometry reaching beyond the bbox: ${beyond.length > 0 ? beyond.join(', ') : 'none'}`);
  const cleaned = report.layers.filter((l) => l.cleanedNames > 0).map((l) => `${l.id} ${l.cleanedNames}`);
  lines.push(`  names cleaned: ${cleaned.length > 0 ? cleaned.join(', ') : 'none'}`);
  const levels = report.layers.filter((l) => l.badLevels > 0).map((l) => `${l.id} ${l.badLevels}`);
  lines.push(`  building:levels outside 1–150 or not a number: ${levels.length > 0 ? levels.join(', ') : 'none'}`);
  const outside = report.layers.filter((l) => l.outside > 0).map((l) => `${l.id} ${l.outside}`);
  lines.push(`  objects outside the bbox, left out: ${outside.length > 0 ? outside.join(', ') : 'none'}`);
  lines.push('');

  if (report.fixtures) {
    const failed = report.fixtures.filter((check) => check.failures.length > 0).length;
    lines.push(`reference points: ${report.fixtures.length - failed} of ${report.fixtures.length} pass`);
    for (const check of report.fixtures) {
      lines.push(`  ${check.failures.length === 0 ? 'ok  ' : 'FAIL'} ${check.point.id}: ${check.summary}`);
      for (const failure of check.failures) lines.push(`         - ${failure}`);
    }
  } else {
    lines.push('reference points: the pack has none');
  }
  lines.push('');

  lines.push(`top ${result.top.length} (default importance), ${result.candidates} candidates:`);
  for (const place of result.top) {
    const at = `(${ix.cells.row[place.cell]}, ${ix.cells.col[place.cell]})`;
    lines.push(`  ${String(place.rank).padStart(4)}. ${place.score} ${at} ${plain(place.title)} — ${place.highlights.map(plain).join('; ')}`);
  }
  lines.push('');

  const size = `${formatBytes(report.bytes)} (${formatBytes(report.gzipBytes)} gzip), ${ix.places.length} places`;
  const { path, instead, failed } = report.written;
  const points = `${failed} reference point${failed === 1 ? '' : 's'} failed`;
  lines.push(instead === undefined ? `snapshot: ${path}, ${size}` : `snapshot NOT written to ${instead}: ${points}; the result is in ${path}, ${size}`);
  lines.push(`time: ${Math.round(report.seconds)} s`);
  return lines;
}

/** Counts of `out count` answers of a layer: per selector and for all of them together. */
export interface LayerCount {
  id: string;
  selectors: ReadonlyArray<{ selector: string; nodes: number; ways: number; relations: number; total: number }>;
  total: number;
}

export function formatCounts(counts: readonly LayerCount[], buildings: number | undefined): string[] {
  const rows = counts.flatMap((layer) => [
    ...layer.selectors.map((s) => [layer.id, s.selector, String(s.nodes), String(s.ways), String(s.relations), String(s.total)]),
    ...(layer.selectors.length > 1 ? [[layer.id, 'all together', '', '', '', String(layer.total)]] : []),
  ]);
  if (buildings !== undefined) rows.push(['buildings', 'way["building"]', '', String(buildings), '', String(buildings)]);
  return [table(['criterion', 'selector', 'nodes', 'ways', 'relations', 'total'], rows, 2)];
}

// ---------- formatting ----------

/** The host of a mirror, or a dash when the mirror of an answer is not known (an answer cached before the probe records). */
function hostOf(url: string | undefined): string {
  return url === undefined ? '—' : new URL(url).host;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((100 * part) / whole).toFixed(1)} %`;
}

/** A plain text table: the first `textColumns` columns aligned left, the numbers right. */
function table(header: readonly string[], rows: ReadonlyArray<readonly string[]>, textColumns = 1): string {
  const widths = header.map((title, c) => Math.max(title.length, ...rows.map((row) => row[c]!.length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, c) => (c < textColumns ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!)))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
