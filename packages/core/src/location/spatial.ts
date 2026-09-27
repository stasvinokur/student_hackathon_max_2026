import { inBox } from '../rules/region.js';
import type { BBox } from '../rules/schema.js';
import type { LatLon, LocationGrid, Position } from './geo.js';

// Spatial helpers of the offline builder (doc-3 §4.4): the part of a line inside the bbox, buckets for the
// search of neighbours, merging of close objects and lending of names. Distances are in the local metres
// of the grid.

/** Neighbouring points of a line are at most this far apart, metres (doc-3 §3.1). */
const LINE_STEP = 25;
/** Side of a bucket of the neighbour search, metres (doc-3 §4.4). */
const BUCKET = 500;

// ---------- lines ----------

export interface LineInside {
  /** Points at most 25 m apart along what lies inside the bbox, with every corner there. */
  points: LatLon[];
  /** The point at half the length inside the bbox: where the line stands as a place. */
  middle: LatLon;
}

/** A segment a → b of which a + t·(b − a), t0 ≤ t ≤ t1, lies inside the bbox. */
interface Piece {
  a: LatLon;
  b: LatLon;
  t0: number;
  t1: number;
  /** Length of the whole segment, metres. */
  length: number;
}

/**
 * The part of a line inside the bbox. Each segment is clipped to the bbox first and only its points inside are
 * made — exactly those a densification of the whole segment would keep — so a way that leaves the city costs
 * nothing. The parts of a line are not joined: a gap in its geometry stays a gap. Undefined when nothing is
 * inside.
 */
export function lineInside(parts: ReadonlyArray<readonly LatLon[]>, grid: LocationGrid, bbox: BBox): LineInside | undefined {
  const points: LatLon[] = [];
  const pieces: Piece[] = [];
  for (const part of parts) {
    for (let i = 0; i + 1 < part.length; i++) {
      const a = part[i]!;
      const b = part[i + 1]!;
      const range = clip(a, b, bbox);
      if (!range) continue;
      const [t0, t1] = range;
      const length = distance((b.lon - a.lon) * grid.mPerDegLon, (b.lat - a.lat) * grid.mPerDegLat);
      pieces.push({ a, b, t0, t1, length });
      // A segment of exactly k × 25 m takes k steps whatever the rounding of its coordinates.
      const steps = Math.max(1, Math.ceil(length / LINE_STEP - 1e-9));
      // A step to spare on each side, so that a point on the edge stays whichever way t0 and t1 are rounded.
      const last = Math.min(steps - 1, Math.floor(t1 * steps) + 1);
      for (let k = Math.max(0, Math.ceil(t0 * steps) - 1); k <= last; k++) {
        const point = { lat: a.lat + ((b.lat - a.lat) * k) / steps, lon: a.lon + ((b.lon - a.lon) * k) / steps };
        if (inBox(bbox, point.lat, point.lon)) points.push(point);
      }
    }
    const end = part[part.length - 1];
    if (end && inBox(bbox, end.lat, end.lon)) points.push({ lat: end.lat, lon: end.lon });
  }
  const first = points[0];
  return first ? { points, middle: halfway(pieces) ?? first } : undefined;
}

/**
 * Liang–Barsky clipping: the range [t0, t1] of a + t·(b − a) inside the bbox, its edges included, or null when
 * the segment misses it.
 */
export function clip(a: LatLon, b: LatLon, bbox: BBox): [number, number] | null {
  const dLon = b.lon - a.lon;
  const dLat = b.lat - a.lat;
  // Each edge as p·t ≤ q: west, east, south, north.
  const edges: ReadonlyArray<readonly [number, number]> = [
    [-dLon, a.lon - bbox.west],
    [dLon, bbox.east - a.lon],
    [-dLat, a.lat - bbox.south],
    [dLat, bbox.north - a.lat],
  ];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      t0 = Math.max(t0, t);
    } else {
      if (t < t0) return null;
      t1 = Math.min(t1, t);
    }
  }
  return [t0, t1];
}

/** The point at half the length of the pieces inside the bbox; undefined when they have no length. */
function halfway(pieces: readonly Piece[]): LatLon | undefined {
  const total = pieces.reduce((sum, piece) => sum + (piece.t1 - piece.t0) * piece.length, 0);
  if (!(total > 0)) return undefined;
  let rest = total / 2;
  let last: Piece | undefined;
  for (const piece of pieces) {
    const inside = (piece.t1 - piece.t0) * piece.length;
    if (inside <= 0) continue;
    if (rest <= inside) return pointOf(piece, piece.t0 + rest / piece.length);
    rest -= inside;
    last = piece;
  }
  // Rounding left a sliver past the last piece: its end inside.
  return last && pointOf(last, last.t1);
}

function pointOf({ a, b }: Piece, t: number): LatLon {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

// ---------- the search of neighbours ----------

/** Ids of points in square buckets of 500 m, keyed by·65536 + bx (doc-3 §4.4). */
type Buckets = Map<number, number[]>;

/** The points of a criterion's objects in buckets. */
export interface Search {
  /** Points of all the objects and the object each belongs to. */
  px: Float64Array;
  py: Float64Array;
  owner: Int32Array;
  buckets: Buckets;
  /** The farthest distance a column of the criterion needs, metres. */
  reach: number;
  /** Scratch of neighbours(): the least distance to each object found so far, Infinity when none. */
  best: Float64Array;
}

export interface Neighbour {
  /** Index of the object. */
  item: number;
  distance: number;
}

export function searchOf(items: ReadonlyArray<{ points: readonly Position[] }>, reach: number): Search {
  const total = items.reduce((sum, item) => sum + item.points.length, 0);
  const px = new Float64Array(total);
  const py = new Float64Array(total);
  const owner = new Int32Array(total);
  const buckets: Buckets = new Map();
  let p = 0;
  items.forEach((item, i) => {
    for (const [x, y] of item.points) {
      px[p] = x;
      py[p] = y;
      owner[p] = i;
      addTo(buckets, p, x, y);
      p++;
    }
  });
  return { px, py, owner, buckets, reach, best: new Float64Array(items.length).fill(Infinity) };
}

/**
 * Objects within the reach of a criterion from (x, y), the nearest first, ties by index (objects come in key
 * order). The distance to a line is the distance to its nearest point.
 */
export function neighbours(search: Search, x: number, y: number): Neighbour[] {
  const { px, py, owner, best, reach } = search;
  const found: number[] = [];
  forEachNear(search.buckets, x, y, reach, (p) => {
    const d = distance(px[p]! - x, py[p]! - y);
    if (d > reach) return;
    const item = owner[p]!;
    if (best[item] === Infinity) found.push(item);
    if (d < best[item]!) best[item] = d;
  });
  const around = found.map((item) => ({ item, distance: best[item]! }));
  for (const item of found) best[item] = Infinity;
  return around.sort((a, b) => a.distance - b.distance || a.item - b.item);
}

function addTo(buckets: Buckets, id: number, x: number, y: number): void {
  const key = bucketKey(Math.floor(x / BUCKET), Math.floor(y / BUCKET));
  const list = buckets.get(key);
  if (list) list.push(id);
  else buckets.set(key, [id]);
}

/** Calls visit with every id in the buckets that reach within `radius` of (x, y); the caller checks distances. */
function forEachNear(buckets: Buckets, x: number, y: number, radius: number, visit: (id: number) => void): void {
  const lastX = Math.floor((x + radius) / BUCKET);
  const lastY = Math.floor((y + radius) / BUCKET);
  for (let by = Math.floor((y - radius) / BUCKET); by <= lastY; by++) {
    for (let bx = Math.floor((x - radius) / BUCKET); bx <= lastX; bx++) {
      const list = buckets.get(bucketKey(bx, by));
      if (list) for (const id of list) visit(id);
    }
  }
}

/** Buckets far apart may share a key: that adds candidates, it never loses one. */
function bucketKey(bx: number, by: number): number {
  return by * 65536 + bx;
}

// ---------- merging and names ----------

/** What merging and lending of names need of an object: where it stands and its name. */
export interface Named {
  x: number;
  y: number;
  name: string | undefined;
}

/**
 * Merges objects closer than `range` (a stop mapped as several nodes): in key order an object joins the first
 * cluster whose first object is closer than `range`, otherwise it starts a cluster. A cluster stands where its
 * first object does and keeps the first name found among its objects. The objects given stay as they are:
 * a cluster that takes a name is a copy of its first object.
 */
export function merge<T extends Named>(items: readonly T[], range: number): T[] {
  const clusters: T[] = [];
  const buckets: Buckets = new Map();
  for (const item of items) {
    let first = -1;
    forEachNear(buckets, item.x, item.y, range, (c) => {
      const cluster = clusters[c]!;
      if ((first === -1 || c < first) && distance(cluster.x - item.x, cluster.y - item.y) < range) first = c;
    });
    const cluster = clusters[first];
    if (!cluster) {
      addTo(buckets, clusters.length, item.x, item.y);
      clusters.push(item);
    } else if (cluster.name === undefined && item.name !== undefined) {
      clusters[first] = { ...cluster, name: item.name };
    }
  }
  return clusters;
}

/**
 * An object without a name takes the name of the nearest object with one within `range` (ties by key), as a
 * metro entrance takes its station's; a borrowed name is not lent further. The objects given stay as they are:
 * one that borrows a name comes back as a copy.
 */
export function borrowNames<T extends Named>(items: readonly T[], range: number): T[] {
  const named: Buckets = new Map();
  items.forEach((item, i) => {
    if (item.name !== undefined) addTo(named, i, item.x, item.y);
  });
  return items.map((item) => {
    if (item.name !== undefined) return item;
    let lender = -1;
    let least = range;
    forEachNear(named, item.x, item.y, range, (j) => {
      const d = distance(items[j]!.x - item.x, items[j]!.y - item.y);
      if (d < least || (d === least && (lender === -1 || j < lender))) {
        lender = j;
        least = d;
      }
    });
    const name = items[lender]?.name;
    return name === undefined ? item : { ...item, name };
  });
}

/**
 * Length of a vector. Math.sqrt is exactly rounded, so distances are the same on any engine; the logarithmic norm
 * and footprint areas still go through Math.log1p and Math.cos, which may differ in the last bit — harmless while
 * one Node makes every snapshot.
 */
function distance(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy);
}
