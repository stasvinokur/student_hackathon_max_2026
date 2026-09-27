import { inBox } from '../rules/region.js';
import type { BBox } from '../rules/schema.js';
import { cellAt, decay, gridFor, pointInPolygon, toLocal, type LatLon, type LocationGrid, type Position } from './geo.js';
import { compareKeys, type OsmFeature, type OsmLine, type OsmPoint } from './osm.js';
import {
  compileNamePattern,
  factColumns,
  MAX_GRID_SIDE,
  type FactColumn,
  type LocationCriteria,
  type LocationCriterion,
  type LocationCriterionConfig,
  type LocationIndex,
  type LocationPlace,
} from './schema.js';
import { borrowNames, clip, lineInside, merge, neighbours, searchOf, type Named, type Neighbour, type Search } from './spatial.js';

// The offline builder (doc-3 §3.2–3.5, §3.8, §4.4): OpenStreetMap objects and the methodology in, a snapshot
// out. Pure and deterministic: the input is sorted here, ties are broken by OSM keys, numbers are rounded.
// Lines, the search of neighbours, merging and names are in spatial.ts; this file is the methodology.

export interface BuildLocationIndexInput {
  /** Id of the rules pack the snapshot belongs to. */
  pack: string;
  /** Region of the pack (manifest.region.bbox): the grid covers it, objects outside it are left out. */
  bbox: BBox;
  /** The methodology as parseLocationCriteria accepted it, and the sha256 (hex) of its file. */
  config: LocationCriteria;
  configSha256: string;
  /** Objects per criterion id, as featuresFromOverpass gives them. */
  layers: Readonly<Record<string, readonly OsmFeature[]>>;
  /** Centres of all buildings (buildingCentres): the built-up mask. */
  buildings: readonly LatLon[];
  /** Overpass osm_base of every layer, time of the extraction, the Overpass endpoint and the script. */
  source: { osmBase: string; extractedAt: string; endpoint: string; method: string };
}

type DecayConfig = Extract<LocationCriterionConfig, { model: 'decay' }>;
type SaturationConfig = Extract<LocationCriterionConfig, { model: 'saturation' }>;
type ShareConfig = Extract<LocationCriterionConfig, { model: 'share' }>;

/** Sample points per side of a cell for the share of an area: 5 × 5 (doc-3 §4.4). */
const SAMPLES = 5;
/** near of a cell whose nearest object has no name, and of a cell without an object within fact.max. */
const UNNAMED = -2;
const NONE = -1;
const KIND: Readonly<Record<OsmFeature['kind'], string>> = { point: 'a point', line: 'a line', area: 'an area' };

/** An object of a decay or saturation criterion; x and y are its anchor in the local metres of the grid. */
interface Item extends Named {
  key: string;
  tags: Readonly<Record<string, string>>;
  /** s of the exposure: footprint area × floors for `weight: area_levels`, otherwise 1. */
  weight: number;
  levels: number | undefined;
  /** Where the object stands as a place: the point, half the length of a line, the first object of a cluster. */
  anchor: LatLon;
  /** What distances are measured to: the point, or the points of a line inside the bbox. */
  points: Position[];
}

interface Area {
  rings: Position[][];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type DecayLayer = { model: 'decay'; criterion: DecayConfig; items: Item[]; search: Search };
type SaturationLayer = { model: 'saturation'; criterion: SaturationConfig; items: Item[]; search: Search; direct: boolean[] };
type ShareLayer = { model: 'share'; criterion: ShareConfig; areas: Area[] };
type Layer = DecayLayer | SaturationLayer | ShareLayer;

interface Cell {
  row: number;
  col: number;
}

type FactValues = Record<FactColumn, number[]>;

/** Named objects the facts point to, each once per criterion, in the order the cells first point to them. */
interface Places {
  list: LocationPlace[];
  index: Map<string, number>;
}

interface Quantiles {
  p50: number;
  p95: number;
}

/**
 * Builds the snapshot (doc-3 §4.4): the grid over the bbox; cells with at least min_buildings buildings or a
 * point demand object; per cell and criterion the level 0–100 (decay: exposure of the cap nearest objects
 * normalised by P50/P95; share: 5 × 5 samples) and the numbers of the fact; the places the facts name.
 * Throws on a grid over 4096 cells a side, a missing layer, fewer objects than min_features (fewer buildings than
 * grid.min_features), an OSM object twice in a layer, an object of the wrong kind, a weight that is not a positive
 * number, or no cell in the index.
 */
export function buildLocationIndex(input: BuildLocationIndexInput): LocationIndex {
  const { config, bbox, source } = input;
  const grid = gridFor(bbox, config.grid.cell_meters);
  // Before anything is sized by the grid: a mistaken bbox or cell size must not exhaust the memory.
  if (grid.rows > MAX_GRID_SIDE || grid.cols > MAX_GRID_SIDE) {
    throw new Error(`the grid of ${grid.rows} × ${grid.cols} cells is larger than ${MAX_GRID_SIDE} a side: take larger cells or a smaller bbox`);
  }
  const layers = config.criteria.map((criterion) => layerOf(criterion, featuresOf(input, criterion), grid, bbox));
  const maskMin = config.grid.min_features;
  if (maskMin !== undefined && input.buildings.length < maskMin) {
    throw new Error(`suspiciously little data: the built-up mask has ${input.buildings.length} buildings, grid.min_features is ${maskMin}`);
  }
  const minBuildings = config.grid.min_buildings;
  const cells = includedCells(grid, bbox, input.buildings, layers, minBuildings);
  if (cells.length === 0) {
    const buildings = `${minBuildings} building${minBuildings === 1 ? '' : 's'}`;
    throw new Error(`no cell made it into the index: none has ${buildings} or a point demand object`);
  }

  const count = cells.length;
  const zeros = () => new Array<number>(count).fill(0);
  // Per criterion and cell: what a level is made of — the exposure of a decay criterion, the share of a share
  // criterion (saturation has no level) — and the numbers of the fact; the named objects the facts point to.
  const amounts = layers.map((layer) => new Float64Array(layer.model === 'saturation' ? 0 : count));
  const facts = layers.map((): FactValues => ({ near: zeros(), dist: zeros(), n: zeros(), m: zeros() }));
  const places: Places = { list: [], index: new Map() };
  const areasByCell = layers.map((layer) => (layer.model === 'share' ? overlaps(layer.areas, cells, grid) : []));

  // Cells first, then criteria: places are listed in the order the cells first point to them.
  cells.forEach(({ row, col }, i) => {
    const x = (col + 0.5) * grid.cellMeters;
    const y = (row + 0.5) * grid.cellMeters;
    layers.forEach((layer, c) => {
      if (layer.model === 'share') {
        amounts[c]![i] = shareOf(layer.areas, areasByCell[c]![i]!, row, col, grid.cellMeters);
        return;
      }
      const around = neighbours(layer.search, x, y);
      if (layer.model === 'saturation') {
        competitorFacts(layer, around, facts[c]!, i);
        return;
      }
      amounts[c]![i] = exposureOf(layer, around);
      decayFacts(layer, around, facts[c]!, i, c, places);
    });
  });

  const criteria: LocationCriterion[] = [];
  const level: Record<string, number[]> = {};
  const fact: LocationIndex['cells']['fact'] = {};
  layers.forEach((layer, c) => {
    const { id } = layer.criterion;
    if (layer.model === 'saturation') {
      criteria.push(saturationCriterion(layer));
    } else {
      const amount = amounts[c]!;
      const norm = quantiles(amount);
      level[id] = layer.model === 'decay' ? decayLevels(amount, layer.criterion.norm, norm) : Array.from(amount, (share) => Math.round(100 * share));
      criteria.push(measuredCriterion(layer, norm));
    }
    const columns = factColumns(layer.criterion.fact);
    if (columns.length === 0) return;
    const stored: LocationIndex['cells']['fact'][string] = {};
    for (const column of columns) stored[column] = facts[c]![column];
    fact[id] = stored;
  });

  return {
    format: 'otkryvay.location-index/1',
    pack: input.pack,
    version: `${source.osmBase.replace(/[-:]/g, '')}-${input.configSha256.slice(0, 8)}`,
    title: config.title,
    disclaimer: config.disclaimer,
    dataStatus: 'prepared_snapshot',
    linkedActions: [...config.linked_actions],
    top: { size: config.top.size, minSpacingCells: config.top.min_spacing_cells },
    source: {
      name: 'OpenStreetMap',
      licence: 'ODbL-1.0',
      licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
      attribution: '© участники OpenStreetMap',
      attributionUrl: 'https://www.openstreetmap.org/copyright',
      osmBase: source.osmBase,
      extractedAt: source.extractedAt,
      endpoint: source.endpoint,
      method: source.method,
      configSha256: input.configSha256,
    },
    grid,
    criteria,
    places: places.list,
    cells: { row: cells.map((cell) => cell.row), col: cells.map((cell) => cell.col), level, fact },
  };
}

function featuresOf(input: BuildLocationIndexInput, criterion: LocationCriterionConfig): readonly OsmFeature[] {
  const features = Object.hasOwn(input.layers, criterion.id) ? input.layers[criterion.id] : undefined;
  if (!features) throw new Error(`no OSM layer for criterion "${criterion.id}"`);
  // An empty or cut Overpass answer must not look like an empty city (doc-3 §4.3).
  if (features.length < criterion.min_features) {
    const objects = `${features.length} OSM object${features.length === 1 ? '' : 's'}`;
    throw new Error(`suspiciously little data: criterion "${criterion.id}" has ${objects}, min_features is ${criterion.min_features}`);
  }
  // Two objects under one key would merge into one place.
  const keys = new Set<string>();
  for (const { key } of features) {
    if (keys.has(key)) throw new Error(`duplicate OSM object ${key} in layer "${criterion.id}"`);
    keys.add(key);
  }
  return features;
}

// ---------- objects ----------

function layerOf(criterion: LocationCriterionConfig, features: readonly OsmFeature[], grid: LocationGrid, bbox: BBox): Layer {
  switch (criterion.model) {
    case 'decay': {
      const { fact } = criterion;
      const items = itemsOf(criterion, features, grid, bbox);
      const reach = Math.max(criterion.decay.zero, fact.type === 'nearest' ? fact.max : 0, fact.radius ?? 0);
      return { model: 'decay', criterion, items, search: searchOf(items, reach) };
    }
    case 'saturation': {
      const items = itemsOf(criterion, features, grid, bbox);
      const rules = criterion.direct.tags.map(tagRule);
      const pattern = compileNamePattern(criterion.direct.name_pattern);
      const direct = items.map((item) => rules.some((rule) => rule(item.tags)) || namedLikeCoffee(item, pattern));
      return { model: 'saturation', criterion, items, search: searchOf(items, criterion.fact.radius), direct };
    }
    case 'share':
      return { model: 'share', criterion, areas: areasOf(criterion, features, grid, bbox) };
  }
}

/**
 * Items of a decay or saturation criterion in key order. A line criterion takes lines, the others points, as
 * featuresFromOverpass gives them. Only what lies inside the bbox is kept, so that every place lies in the pack
 * region: a point inside it, the part of a line inside it. Then decay criteria merge close objects and let the
 * unnamed ones borrow names.
 */
function itemsOf(criterion: DecayConfig | SaturationConfig, features: readonly OsmFeature[], grid: LocationGrid, bbox: BBox): Item[] {
  const lines = criterion.model === 'decay' && criterion.geometry === 'line';
  const weighted = criterion.model === 'decay' && criterion.weight !== undefined;
  const items: Item[] = [];
  for (const feature of [...features].sort((a, b) => compareKeys(a.key, b.key))) {
    if (feature.kind === 'area' || (feature.kind === 'line') !== lines) {
      throw new Error(`criterion "${criterion.id}" takes ${lines ? 'lines' : 'points'}, got ${KIND[feature.kind]} (${feature.key})`);
    }
    const item = feature.kind === 'point' ? pointItem(feature, weighted, criterion.id, grid, bbox) : lineItem(feature, grid, bbox);
    if (item) items.push(item);
  }
  if (criterion.model !== 'decay') return items;
  const merged = criterion.merge_within === undefined ? items : merge(items, criterion.merge_within);
  return criterion.borrow_name_within === undefined ? merged : borrowNames(merged, criterion.borrow_name_within);
}

function pointItem(feature: OsmPoint, weighted: boolean, layer: string, grid: LocationGrid, bbox: BBox): Item | undefined {
  // A weight goes into every sum around its object: one Infinity or NaN would spoil the whole criterion.
  if (weighted && !(Number.isFinite(feature.weight) && feature.weight > 0)) {
    throw new Error(`OSM object ${feature.key} in layer "${layer}" weighs ${feature.weight}: footprint area × floors must be a positive number`);
  }
  if (!inBox(bbox, feature.lat, feature.lon)) return undefined;
  const { x, y } = toLocal(grid, feature.lat, feature.lon);
  return {
    key: feature.key,
    name: feature.name,
    tags: feature.tags,
    weight: weighted ? feature.weight : 1,
    levels: feature.levels,
    anchor: { lat: feature.lat, lon: feature.lon },
    x,
    y,
    points: [[x, y]],
  };
}

function lineItem(feature: OsmLine, grid: LocationGrid, bbox: BBox): Item | undefined {
  const inside = lineInside(feature.parts, grid, bbox);
  if (!inside) return undefined;
  const { x, y } = toLocal(grid, inside.middle.lat, inside.middle.lon);
  return {
    key: feature.key,
    name: feature.name,
    tags: feature.tags,
    weight: 1,
    levels: undefined,
    anchor: inside.middle,
    x,
    y,
    points: inside.points.map((point) => local(grid, point)),
  };
}

// ---------- cells ----------

/**
 * Cells of the index, by row, then col (doc-3 §3.7): with at least min_buildings buildings inside the bbox, or
 * with a point demand object. A line brings no cell in: an empty cell on a street or a bridge has no premises
 * to rent, though the line still counts for the cells around it.
 */
function includedCells(grid: LocationGrid, bbox: BBox, buildings: readonly LatLon[], layers: readonly Layer[], minBuildings: number): Cell[] {
  const size = grid.rows * grid.cols;
  const built = new Int32Array(size);
  for (const { lat, lon } of buildings) {
    const at = inBox(bbox, lat, lon) ? cellAt(grid, lat, lon) : null;
    if (at) built[at.row * grid.cols + at.col] = built[at.row * grid.cols + at.col]! + 1;
  }
  const demand = new Uint8Array(size);
  for (const layer of layers) {
    if (layer.model !== 'decay' || layer.criterion.geometry === 'line') continue;
    for (const { x, y } of layer.items) {
      const row = Math.floor(y / grid.cellMeters);
      const col = Math.floor(x / grid.cellMeters);
      if (row >= 0 && row < grid.rows && col >= 0 && col < grid.cols) demand[row * grid.cols + col] = 1;
    }
  }
  const cells: Cell[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const k = row * grid.cols + col;
      if (built[k]! >= minBuildings || demand[k] === 1) cells.push({ row, col });
    }
  }
  return cells;
}

/** e = Σ s·f(d) over the cap nearest objects closer than decay.zero (doc-3 §3.2). */
function exposureOf(layer: DecayLayer, around: readonly Neighbour[]): number {
  const { full, zero } = layer.criterion.decay;
  const cap = layer.criterion.cap ?? Infinity;
  let exposure = 0;
  for (let k = 0; k < around.length && k < cap; k++) {
    const { item, distance } = around[k]!;
    if (distance >= zero) break;
    exposure += layer.items[item]!.weight * decay(distance, full, zero);
  }
  return exposure;
}

/**
 * The fact of a decay criterion (doc-3 §3.8). nearest: the nearest object within fact.max, named or not —
 * a place (near ≥ 0), −2 without a name, −1 when there is none; dist in whole metres. count: objects within the
 * radius and those with at least `floors` mapped floors.
 */
function decayFacts(layer: DecayLayer, around: readonly Neighbour[], values: FactValues, i: number, c: number, places: Places): void {
  const { fact } = layer.criterion;
  const { items } = layer;
  if (fact.type === 'count') {
    values.n[i] = within(around, fact.radius);
    const { floors } = fact;
    if (floors !== undefined) values.m[i] = within(around, fact.radius, (item) => (items[item]!.levels ?? 0) >= floors);
    return;
  }
  const first = around[0];
  const nearest = first && first.distance <= fact.max ? items[first.item] : undefined;
  if (first && nearest) {
    values.near[i] = nearest.name === undefined ? UNNAMED : placeOf(places, c, nearest, nearest.name);
    // Rounded to whole metres, yet never beyond fact.max.
    values.dist[i] = Math.min(Math.round(first.distance), Math.floor(fact.max));
  } else {
    values.near[i] = NONE;
    values.dist[i] = 0;
  }
  if (fact.radius !== undefined) values.n[i] = within(around, fact.radius);
}

/** Coffee shops (n) and other cafes (m) within the radius (doc-3 §3.5). */
function competitorFacts(layer: SaturationLayer, around: readonly Neighbour[], values: FactValues, i: number): void {
  const { radius } = layer.criterion.fact;
  values.n[i] = within(around, radius, (item) => layer.direct[item]!);
  values.m[i] = within(around, radius, (item) => !layer.direct[item]);
}

/** How many of the neighbours (nearest first) are within the radius and pass the test. */
function within(around: readonly Neighbour[], radius: number, test: (item: number) => boolean = () => true): number {
  let count = 0;
  for (const { item, distance } of around) {
    if (distance > radius) break;
    if (test(item)) count++;
  }
  return count;
}

function placeOf(places: Places, criterion: number, item: Item, name: string): number {
  // The same OSM object may serve two criteria: a place belongs to one.
  const key = `${criterion} ${item.key}`;
  const known = places.index.get(key);
  if (known !== undefined) return known;
  places.list.push([criterion, name, round6(item.anchor.lat), round6(item.anchor.lon)]);
  places.index.set(key, places.list.length - 1);
  return places.list.length - 1;
}

/** A tag rule of `direct`: key=value — the value exactly, key~value — a substring; case-insensitive. */
function tagRule(rule: string): (tags: Readonly<Record<string, string>>) => boolean {
  const at = rule.search(/[=~]/);
  const key = rule.slice(0, at);
  const value = rule.slice(at + 1).toLowerCase();
  const exact = rule.charAt(at) === '=';
  return (tags) => {
    const tag = Object.hasOwn(tags, key) ? tags[key]?.toLowerCase() : undefined;
    return tag !== undefined && (exact ? tag === value : tag.includes(value));
  };
}

/** A coffee shop by its name (name:ru or name) or its brand; the pattern of the config runs only here, offline. */
function namedLikeCoffee(item: Item, pattern: RegExp): boolean {
  return [item.name, item.tags.name, item.tags.brand].some((text) => text !== undefined && pattern.test(text));
}

// ---------- areas ----------

/** The areas of a share criterion that overlap the bbox, in local metres; the others matter nowhere here. */
function areasOf(criterion: ShareConfig, features: readonly OsmFeature[], grid: LocationGrid, bbox: BBox): Area[] {
  const areas: Area[] = [];
  for (const feature of features) {
    if (feature.kind !== 'area') throw new Error(`criterion "${criterion.id}" takes areas, got ${KIND[feature.kind]} (${feature.key})`);
    if (!overlapsBox(feature.rings, bbox)) continue;
    const rings = feature.rings.map((ring) => ring.map((point) => local(grid, point)));
    const area: Area = { rings, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const [x, y] of rings.flat()) {
      area.minX = Math.min(area.minX, x);
      area.minY = Math.min(area.minY, y);
      area.maxX = Math.max(area.maxX, x);
      area.maxY = Math.max(area.maxY, y);
    }
    areas.push(area);
  }
  return areas;
}

/** Whether an area overlaps the bbox: one of its edges runs through the bbox, or it holds the whole bbox. */
function overlapsBox(rings: ReadonlyArray<readonly LatLon[]>, bbox: BBox): boolean {
  const corner: Position = [bbox.west, bbox.south];
  return rings.some(
    (ring) =>
      ring.some((point, i) => i > 0 && clip(ring[i - 1]!, point, bbox) !== null) ||
      pointInPolygon(corner, ring.map((point): Position => [point.lon, point.lat])),
  );
}

/** For each cell of the index, the areas whose bounding box overlaps it. */
function overlaps(areas: readonly Area[], cells: readonly Cell[], grid: LocationGrid): number[][] {
  const index = new Int32Array(grid.rows * grid.cols).fill(-1);
  cells.forEach(({ row, col }, i) => (index[row * grid.cols + col] = i));
  const byCell = cells.map((): number[] => []);
  const size = grid.cellMeters;
  areas.forEach((area, a) => {
    const lastRow = Math.min(grid.rows - 1, Math.floor(area.maxY / size));
    const lastCol = Math.min(grid.cols - 1, Math.floor(area.maxX / size));
    for (let row = Math.max(0, Math.floor(area.minY / size)); row <= lastRow; row++) {
      for (let col = Math.max(0, Math.floor(area.minX / size)); col <= lastCol; col++) {
        const i = index[row * grid.cols + col]!;
        if (i >= 0) byCell[i]!.push(a);
      }
    }
  });
  return byCell;
}

/** The share of a cell inside any of the areas, on 5 × 5 points: the centres of a 5 × 5 subgrid. */
function shareOf(areas: readonly Area[], candidates: readonly number[], row: number, col: number, size: number): number {
  if (candidates.length === 0) return 0;
  let inside = 0;
  for (let j = 0; j < SAMPLES; j++) {
    for (let k = 0; k < SAMPLES; k++) {
      const sample: Position = [(col + (k + 0.5) / SAMPLES) * size, (row + (j + 0.5) / SAMPLES) * size];
      if (candidates.some((a) => areas[a]!.rings.some((ring) => pointInPolygon(sample, ring)))) inside++;
    }
  }
  return inside / (SAMPLES * SAMPLES);
}

// ---------- levels ----------

/**
 * P50 and P95 over the cells with a value above 0 (doc-3 §3.3), by linear interpolation between the closest
 * ranks (as NumPy's default): p over n ascending values is v[⌊h⌋] + (h − ⌊h⌋)·(v[⌊h⌋+1] − v[⌊h⌋]), h = (n − 1)·p.
 * Rounded to 6 significant digits; both 0 when no cell has a value.
 */
function quantiles(values: Float64Array): Quantiles {
  const positive = values.filter((value) => value > 0).sort();
  if (positive.length === 0) return { p50: 0, p95: 0 };
  return { p50: significant(percentile(positive, 0.5)), p95: significant(percentile(positive, 0.95)) };
}

function percentile(sorted: Float64Array, p: number): number {
  const h = (sorted.length - 1) * p;
  const low = Math.floor(h);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low]! + (h - low) * (sorted[high]! - sorted[low]!);
}

/**
 * Linear L = min(1, e / P95), logarithmic L = min(1, ln(1 + e/P50) / ln(1 + P95/P50)); level = round(100·L), but
 * at least 1 when e > 0: level 0 means no object within reach, which is what «Обязательно» checks.
 */
function decayLevels(exposure: Float64Array, kind: 'linear' | 'log', { p50, p95 }: Quantiles): number[] {
  if (p95 === 0) return Array.from(exposure, () => 0);
  const scale = kind === 'linear' ? (e: number) => e / p95 : (e: number) => Math.log1p(e / p50) / Math.log1p(p95 / p50);
  return Array.from(exposure, (e) => (e > 0 ? Math.max(1, Math.round(100 * Math.min(1, scale(e)))) : 0));
}

// ---------- snapshot ----------

/** A decay or share criterion as the snapshot stores it: camelCase, without what only the builder reads. */
function measuredCriterion(layer: DecayLayer | ShareLayer, norm: Quantiles): LocationCriterion {
  const head = { id: layer.criterion.id, title: layer.criterion.title };
  const common = { defaultImportance: layer.criterion.default_importance, osm: [...layer.criterion.osm] };
  if (layer.model === 'share') {
    const { criterion } = layer;
    return {
      ...head,
      role: criterion.role,
      model: criterion.model,
      ...common,
      norm: { kind: 'share', ...norm },
      excludeShare: criterion.exclude_share,
      fact: { ...criterion.fact },
      featureCount: layer.areas.length,
    };
  }
  const { criterion } = layer;
  return {
    ...head,
    role: criterion.role,
    model: criterion.model,
    ...common,
    decay: { ...criterion.decay },
    ...(criterion.cap === undefined ? {} : { cap: criterion.cap }),
    norm: { kind: criterion.norm, ...norm },
    fact: { ...criterion.fact },
    ...(criterion.title_anchor === undefined ? {} : { titleAnchor: { ...criterion.title_anchor } }),
    featureCount: layer.items.length,
  };
}

/** The saturation criterion as the snapshot stores it, with the thresholds of the verdict. */
function saturationCriterion(layer: SaturationLayer): LocationCriterion {
  const { criterion } = layer;
  const { saturation } = criterion;
  return {
    id: criterion.id,
    title: criterion.title,
    role: criterion.role,
    model: criterion.model,
    defaultImportance: criterion.default_importance,
    osm: [...criterion.osm],
    direct: { tags: [...criterion.direct.tags], namePattern: criterion.direct.name_pattern },
    saturation: {
      indirectWeight: saturation.indirect_weight,
      nicheBonus: saturation.niche_bonus,
      excludeRatio: saturation.exclude_ratio,
      saturatedRatio: saturation.saturated_ratio,
      nicheRatio: saturation.niche_ratio,
    },
    fact: { ...criterion.fact },
    featureCount: layer.items.length,
  };
}

// ---------- numbers ----------

function local(grid: LocationGrid, point: LatLon): Position {
  const { x, y } = toLocal(grid, point.lat, point.lon);
  return [x, y];
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function significant(value: number): number {
  return Number(value.toPrecision(6));
}
