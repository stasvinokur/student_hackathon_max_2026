import { z } from 'zod';
import type { BBox } from '../rules/schema.js';
import { formatPath } from '../rules/validate.js';
import { metresPerDegree, type LatLon } from './geo.js';
import type { LocationCriterionConfig } from './schema.js';

// OpenStreetMap through the Overpass API, without the network (doc-3 §4.3): the query of a criterion and
// the objects of an answer. The offline builder's CLI sends the queries and hands the answers over.

export interface OverpassQueryOptions {
  /** OSM snapshot time (osm3s.timestamp_osm_base of the first answer): every layer is taken at it. */
  date?: string | undefined;
  /** Server-side timeout of the query, seconds; 180 by default. */
  timeoutSeconds?: number | undefined;
}

/** How Overpass writes the time of its data: 2026-09-23T19:28:21Z. */
const OSM_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DEFAULT_TIMEOUT_SECONDS = 180;

/**
 * The objects of a criterion within the bbox (doc-3 §4.3). Points need only centres (`out tags center`:
 * nodes keep their coordinates); lines, areas and weighted footprints need the full geometry, which
 * `out geom` gives with the members of relations — with `out tags geom` Overpass leaves members out,
 * and multipolygons with them. The selectors come from a validated config: tag filters only.
 */
export function overpassQuery(criterion: LocationCriterionConfig, bbox: BBox, opts: OverpassQueryOptions = {}): string {
  const selectors = criterion.osm.map((selector) => `${selector};`).join('');
  return `${settings(bbox, opts)}(${selectors});out ${needsGeometry(criterion) ? 'geom' : 'tags center'} qt;`;
}

/** Centres of all buildings in the bbox, ids only: the built-up mask (doc-3 §3.7). */
export function buildingsQuery(bbox: BBox, opts: OverpassQueryOptions = {}): string {
  return `${settings(bbox, opts)}way["building"];out ids center qt;`;
}

/**
 * The objects of a criterion counted, not fetched (`out count`), to check a layer against what is known of the city:
 * a count per selector, then — with several selectors — one of all of them together, as overpassQuery unites them.
 */
export function overpassCountQuery(criterion: LocationCriterionConfig, bbox: BBox, opts: OverpassQueryOptions = {}): string {
  const { osm } = criterion;
  const each = osm.map((selector) => `${selector};out count;`).join('');
  const together = osm.length > 1 ? `(${osm.map((selector) => `${selector};`).join('')});out count;` : '';
  return `${settings(bbox, opts)}${each}${together}`;
}

/** The buildings of the built-up mask counted (`out count`). */
export function buildingsCountQuery(bbox: BBox, opts: OverpassQueryOptions = {}): string {
  return `${settings(bbox, opts)}way["building"];out count;`;
}

/** Whether a text is a time as Overpass writes it: 2026-09-23T19:28:21Z (osm3s.timestamp_osm_base, [date]). */
export function isOsmTime(text: string): boolean {
  return OSM_TIME.test(text);
}

const OsmBaseSchema = z.object({ osm3s: z.object({ timestamp_osm_base: z.string().regex(OSM_TIME) }) });

/** The time of the OSM data behind an answer, or null when the answer has none. */
export function overpassOsmBase(json: unknown): string | null {
  const parsed = OsmBaseSchema.safeParse(json);
  return parsed.success ? parsed.data.osm3s.timestamp_osm_base : null;
}

/** The settings that open a query: JSON, the timeout, the bbox of every statement and the snapshot date. */
function settings(bbox: BBox, { date, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS }: OverpassQueryOptions): string {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw new RangeError(`the Overpass timeout must be a whole number of seconds, got ${timeoutSeconds}`);
  }
  // The date goes into the query as is, so nothing but a snapshot time may pass.
  if (date !== undefined && !OSM_TIME.test(date)) {
    throw new RangeError(`the Overpass date must be an OSM snapshot time like 2026-09-23T19:28:21Z, got "${date}"`);
  }
  const box = [bbox.south, bbox.west, bbox.north, bbox.east].join(',');
  return `[out:json][timeout:${timeoutSeconds}][bbox:${box}]${date === undefined ? '' : `[date:"${date}"]`};`;
}

function needsGeometry(criterion: LocationCriterionConfig): boolean {
  switch (criterion.model) {
    case 'decay':
      return criterion.geometry === 'line' || criterion.weight !== undefined;
    case 'share':
      return true;
    case 'saturation':
      return false;
  }
}

// ---------- features ----------

interface OsmFeatureBase {
  /** The OSM element: n123, w123 or r123. */
  key: string;
  /** name:ru, else name, trimmed; undefined when neither has text. */
  name: string | undefined;
  /** All tags of the element. */
  tags: Readonly<Record<string, string>>;
}

/** A node, the centre of a way or relation, or the area centroid of a building footprint. */
export interface OsmPoint extends OsmFeatureBase {
  kind: 'point';
  lat: number;
  lon: number;
  /** For `weight: area_levels`: footprint area, m², × floors (building:levels, else default_levels); otherwise 1. */
  weight: number;
  /** building:levels when it is a number of floors, 1–150: a floors fact counts only floors that are mapped. */
  levels: number | undefined;
}

/** A way of a `geometry: line` criterion, in parts: where Overpass could not resolve a node, the line breaks. */
export interface OsmLine extends OsmFeatureBase {
  kind: 'line';
  parts: ReadonlyArray<readonly LatLon[]>;
}

/** An area of a share criterion: its outer rings, each closed (the first point repeated at the end). */
export interface OsmArea extends OsmFeatureBase {
  kind: 'area';
  rings: ReadonlyArray<readonly LatLon[]>;
}

export type OsmFeature = OsmPoint | OsmLine | OsmArea;

/**
 * The objects of a criterion in an answer to overpassQuery, sorted by key, in the form the criterion needs:
 * - share criteria — areas: closed ways and multipolygons (outer rings only, see joinRings);
 * - `geometry: line` — ways as lines, broken where Overpass could not resolve a coordinate;
 * - `weight: area_levels` — footprints (closed ways, multipolygons) as points at their area centroid, weighted;
 * - otherwise — points: nodes, centres of ways and relations.
 * An element that cannot give that geometry is left out. Throws on a malformed answer.
 */
export function featuresFromOverpass(json: unknown, criterion: LocationCriterionConfig): OsmFeature[] {
  const features: OsmFeature[] = [];
  for (const element of elementsOf(json)) {
    const feature = featureOf(element, criterion);
    if (feature) features.push(feature);
  }
  return features.sort((a, b) => compareKeys(a.key, b.key));
}

/** Centres of the buildings in an answer to buildingsQuery; throws on a malformed answer. */
export function buildingCentres(json: unknown): LatLon[] {
  const centres: LatLon[] = [];
  for (const element of elementsOf(json)) {
    const position = element.type === 'node' ? nodePosition(element) : element.center;
    if (position) centres.push({ lat: position.lat, lon: position.lon });
  }
  return centres;
}

const TYPE_ORDER: Readonly<Record<string, number>> = { n: 0, w: 1, r: 2 };

/** OSM keys in a stable order: nodes, ways, relations, each by numeric id. */
export function compareKeys(a: string, b: string): number {
  const byType = (TYPE_ORDER[a.charAt(0)] ?? 3) - (TYPE_ORDER[b.charAt(0)] ?? 3);
  if (byType !== 0) return byType;
  const byId = Number(a.slice(1)) - Number(b.slice(1));
  if (byId !== 0 && !Number.isNaN(byId)) return byId;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------- the answer ----------

const Coordinate = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
/** Overpass prints null for a coordinate it could not resolve (see partsOf and coordinates). */
const Geometry = z.array(Coordinate.nullable());
const ElementType = z.enum(['node', 'way', 'relation']);

const ElementSchema = z.object({
  type: ElementType,
  id: z.number().int().positive(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  center: Coordinate.optional(),
  geometry: Geometry.optional(),
  members: z.array(z.object({ type: ElementType, role: z.string().optional(), geometry: Geometry.optional() })).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

/** Only what the builder reads is checked; anything else (bounds, node ids, remarks) may be there. */
const AnswerSchema = z.object({ elements: z.array(ElementSchema) });

type OverpassElement = z.infer<typeof ElementSchema>;

const KEY_PREFIX = { node: 'n', way: 'w', relation: 'r' } as const;

function elementsOf(json: unknown): OverpassElement[] {
  const parsed = AnswerSchema.safeParse(json);
  if (parsed.success) return parsed.data.elements;
  const issue = parsed.error.issues[0];
  const where = issue ? formatPath(issue.path) || 'the answer' : 'the answer';
  throw new Error(`malformed Overpass answer: ${where}: ${issue?.message ?? 'invalid'}`);
}

function featureOf(element: OverpassElement, criterion: LocationCriterionConfig): OsmFeature | undefined {
  const tags = element.tags ?? {};
  const base = { key: `${KEY_PREFIX[element.type]}${element.id}`, name: nameOf(tags), tags };
  if (criterion.model === 'share') {
    const rings = ringsOf(element);
    return rings.length > 0 ? { ...base, kind: 'area', rings } : undefined;
  }
  if (criterion.model === 'decay' && criterion.geometry === 'line') {
    const parts = element.type === 'way' ? partsOf(element.geometry) : [];
    return parts.length > 0 ? { ...base, kind: 'line', parts } : undefined;
  }
  const levels = levelsOf(tags);
  if (criterion.model === 'decay' && criterion.weight) {
    const footprint = footprintOf(ringsOf(element));
    if (!footprint) return undefined;
    const weight = footprint.area * (levels ?? criterion.weight.default_levels);
    return { ...base, kind: 'point', lat: footprint.lat, lon: footprint.lon, weight, levels };
  }
  const position = element.type === 'node' ? nodePosition(element) : element.center;
  return position ? { ...base, kind: 'point', lat: position.lat, lon: position.lon, weight: 1, levels } : undefined;
}

function nodePosition(element: OverpassElement): LatLon | undefined {
  return element.lat === undefined || element.lon === undefined ? undefined : { lat: element.lat, lon: element.lon };
}

function nameOf(tags: Readonly<Record<string, string>>): string | undefined {
  for (const key of ['name:ru', 'name']) {
    const name = cleanName(tags[key] ?? '');
    if (name) return name;
  }
  return undefined;
}

/** Control characters and marks of the direction of writing: they would garble a title such as «У метро «…»». */
const INVISIBLE = /[\p{Cc}\p{Bidi_Control}]/gu;
/**
 * Invisible characters that change no direction — zero width space, word joiner, soft hyphen, byte order mark —
 * are dropped: «Кофе\u200bшоп» is «Кофешоп». Zero width non-joiner and joiner stay: they shape letters and emoji.
 */
const HIDDEN = /[\u200b\u2060\u00ad\ufeff]/gu;
const MAX_NAME = 120;

/**
 * A name fit for a title: hidden characters dropped, control characters and direction marks turned into spaces,
 * spaces single, at most 120 characters.
 */
function cleanName(raw: string): string {
  const name = raw.replace(HIDDEN, '').replace(INVISIBLE, ' ').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(name);
  if (chars.length <= MAX_NAME) return name;
  // Keep the whole words that leave room for the ellipsis; a single overlong word is cut as it is.
  const head = chars.slice(0, MAX_NAME - 1).join('');
  const end = chars[MAX_NAME - 1] === ' ' ? head.length : head.lastIndexOf(' ');
  return `${(end > 0 ? head.slice(0, end) : head).trimEnd()}…`;
}

/** building:levels as a number of floors: 1–150, up to three digits (9, 9.5); anything else counts as not mapped. */
const LEVELS = /^\d{1,3}(\.\d+)?$/;
const MAX_LEVELS = 150;

function levelsOf(tags: Readonly<Record<string, string>>): number | undefined {
  const value = tags['building:levels'];
  if (value === undefined || !LEVELS.test(value)) return undefined;
  const levels = Number(value);
  return levels >= 1 && levels <= MAX_LEVELS ? levels : undefined;
}

/**
 * The corners of a ring without the ones Overpass could not resolve: an approximation of the outline, where a
 * missing corner is cut off.
 */
function coordinates(geometry: ReadonlyArray<LatLon | null> | undefined): LatLon[] {
  return (geometry ?? []).filter((point): point is LatLon => point !== null);
}

/** A line split where a coordinate is missing, so that no chord cuts a corner; a part needs two points. */
function partsOf(geometry: ReadonlyArray<LatLon | null> | undefined): LatLon[][] {
  const parts: LatLon[][] = [];
  let part: LatLon[] = [];
  for (const point of [...(geometry ?? []), null]) {
    if (point) {
      part.push(point);
      continue;
    }
    if (part.length >= 2) parts.push(part);
    part = [];
  }
  return parts;
}

// ---------- areas ----------

/**
 * Closed outer rings of an element: a closed way is one; the outer ways of a multipolygon are joined into
 * rings. Other relations (boundaries, sites, 3D buildings) are not areas here.
 */
function ringsOf(element: OverpassElement): LatLon[][] {
  switch (element.type) {
    case 'node':
      return [];
    case 'way': {
      const ring = coordinates(element.geometry);
      return isRing(ring) ? [ring] : [];
    }
    case 'relation': {
      if (element.tags?.type !== 'multipolygon') return [];
      // Outer ways have the role outer, or none in old multipolygons; inner, subarea, outline and others are not the area.
      const outer = (element.members ?? []).filter((m) => m.type === 'way' && (m.role === 'outer' || !m.role));
      return joinRings(outer.map((m) => coordinates(m.geometry)));
    }
  }
}

/**
 * Joins ways end to end into closed rings, reversing a way where needed, in the order of the members;
 * a chain that does not close is dropped. Simplification: inner rings are ignored, so a hole (a courtyard,
 * a pond inside an industrial zone) counts as part of the area.
 */
function joinRings(parts: readonly LatLon[][]): LatLon[][] {
  const rings: LatLon[][] = [];
  const used = parts.map((part) => part.length === 0);
  for (let start = 0; start < parts.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const chain = [...parts[start]!];
    while (!isClosed(chain)) {
      const end = chain[chain.length - 1]!;
      const next = parts.findIndex((part, i) => !used[i] && !isClosed(part) && (same(part[0]!, end) || same(part[part.length - 1]!, end)));
      if (next === -1) break;
      used[next] = true;
      const part = parts[next]!;
      chain.push(...(same(part[0]!, end) ? part.slice(1) : part.slice(0, -1).reverse()));
    }
    if (isRing(chain)) rings.push(chain);
  }
  return rings;
}

function same(a: LatLon, b: LatLon): boolean {
  return a.lat === b.lat && a.lon === b.lon;
}

function isClosed(points: readonly LatLon[]): boolean {
  return points.length > 1 && same(points[0]!, points[points.length - 1]!);
}

/** A polygon ring: closed, with at least three corners. */
function isRing(points: readonly LatLon[]): boolean {
  return points.length >= 4 && isClosed(points);
}

/**
 * Area, m², and area centroid of rings (shoelace formula in a local projection at their first point);
 * undefined when they enclose no area.
 */
function footprintOf(rings: ReadonlyArray<readonly LatLon[]>): { area: number; lat: number; lon: number } | undefined {
  const origin = rings[0]?.[0];
  if (!origin) return undefined;
  const { mPerDegLat, mPerDegLon } = metresPerDegree(origin.lat);
  let area = 0;
  let x = 0;
  let y = 0;
  for (const ring of rings) {
    let twice = 0; // twice the signed area of the ring
    let sx = 0;
    let sy = 0;
    for (let i = 0; i + 1 < ring.length; i++) {
      const x0 = (ring[i]!.lon - origin.lon) * mPerDegLon;
      const y0 = (ring[i]!.lat - origin.lat) * mPerDegLat;
      const x1 = (ring[i + 1]!.lon - origin.lon) * mPerDegLon;
      const y1 = (ring[i + 1]!.lat - origin.lat) * mPerDegLat;
      const cross = x0 * y1 - x1 * y0;
      twice += cross;
      sx += (x0 + x1) * cross;
      sy += (y0 + y1) * cross;
    }
    if (twice === 0) continue;
    const ringArea = Math.abs(twice) / 2;
    area += ringArea;
    // The centroid of a ring is (sx, sy) / (3 · twice); rings add up weighted by their areas.
    x += (sx / (3 * twice)) * ringArea;
    y += (sy / (3 * twice)) * ringArea;
  }
  return area > 0 ? { area, lat: origin.lat + y / area / mPerDegLat, lon: origin.lon + x / area / mPerDegLon } : undefined;
}
