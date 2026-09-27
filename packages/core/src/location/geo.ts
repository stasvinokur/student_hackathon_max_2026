import type { BBox } from '../rules/schema.js';

// Geometry of the location index: a local projection around the grid, the square grid itself,
// distance decay and Russian formatting of distances and counts (doc-3 §3.2, §3.7, §3.8).

export interface LatLon {
  lat: number;
  lon: number;
}

/** [x, y]: metres in the local projection, or [lon, lat] degrees as in GeoJSON. */
export type Position = readonly [number, number];

export interface LocationGrid {
  /** South-west corner: row 0 is the southernmost row, col 0 the westernmost column. */
  origin: LatLon;
  cellMeters: number;
  rows: number;
  cols: number;
  mPerDegLat: number;
  mPerDegLon: number;
}

export const NBSP = '\u00a0';

const RAD = Math.PI / 180;
// WGS 84 ellipsoid: semi-major axis and first eccentricity squared.
const WGS84_A = 6_378_137;
const WGS84_E2 = 0.00669437999014;

/** Metres per degree of latitude and of longitude at a latitude (WGS 84 radii of curvature). */
export function metresPerDegree(lat: number): { mPerDegLat: number; mPerDegLon: number } {
  const sin = Math.sin(lat * RAD);
  const w = 1 - WGS84_E2 * sin * sin;
  return {
    mPerDegLat: ((WGS84_A * (1 - WGS84_E2)) / (w * Math.sqrt(w))) * RAD,
    mPerDegLon: (WGS84_A / Math.sqrt(w)) * Math.cos(lat * RAD) * RAD,
  };
}

/**
 * Square cells over a bbox in a local projection taken at the bbox's middle latitude: across a city
 * the distance error stays under 0.5 %. Metres per degree are rounded to whole metres, so a snapshot
 * does not depend on the last bits of Math.cos.
 */
export function gridFor(bbox: BBox, cellMeters: number): LocationGrid {
  const exact = metresPerDegree((bbox.south + bbox.north) / 2);
  const mPerDegLat = Math.round(exact.mPerDegLat);
  const mPerDegLon = Math.round(exact.mPerDegLon);
  return {
    origin: { lat: bbox.south, lon: bbox.west },
    cellMeters,
    rows: Math.ceil(((bbox.north - bbox.south) * mPerDegLat) / cellMeters),
    cols: Math.ceil(((bbox.east - bbox.west) * mPerDegLon) / cellMeters),
    mPerDegLat,
    mPerDegLon,
  };
}

/** Metres east (x) and north (y) of the grid origin. */
export function toLocal(grid: LocationGrid, lat: number, lon: number): { x: number; y: number } {
  return { x: (lon - grid.origin.lon) * grid.mPerDegLon, y: (lat - grid.origin.lat) * grid.mPerDegLat };
}

/** The cell containing a point, or null outside the grid. */
export function cellAt(grid: LocationGrid, lat: number, lon: number): { row: number; col: number } | null {
  const { x, y } = toLocal(grid, lat, lon);
  const row = Math.floor(y / grid.cellMeters);
  const col = Math.floor(x / grid.cellMeters);
  return row >= 0 && row < grid.rows && col >= 0 && col < grid.cols ? { row, col } : null;
}

export function cellCenter(grid: LocationGrid, row: number, col: number): LatLon {
  return {
    lat: grid.origin.lat + ((row + 0.5) * grid.cellMeters) / grid.mPerDegLat,
    lon: grid.origin.lon + ((col + 0.5) * grid.cellMeters) / grid.mPerDegLon,
  };
}

/** Closed counter-clockwise ring of [lon, lat] (RFC 7946 exterior ring) for a GeoJSON polygon. */
export function cellRing(grid: LocationGrid, row: number, col: number): Array<[number, number]> {
  const south = grid.origin.lat + (row * grid.cellMeters) / grid.mPerDegLat;
  const north = grid.origin.lat + ((row + 1) * grid.cellMeters) / grid.mPerDegLat;
  const west = grid.origin.lon + (col * grid.cellMeters) / grid.mPerDegLon;
  const east = grid.origin.lon + ((col + 1) * grid.cellMeters) / grid.mPerDegLon;
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/** Distance decay: 1 up to `full` metres, then linear down to 0 at `zero` (a step when they coincide). */
export function decay(distance: number, full: number, zero: number): number {
  if (distance <= full) return 1;
  if (distance >= zero) return 0;
  return (zero - distance) / (zero - full);
}

/** Even-odd ray casting. The ring may be closed or open; a point exactly on an edge may fall either way. */
export function pointInPolygon(point: Position, ring: readonly Position[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** «до 50 м» below 50 m, «350 м» rounded to 10 m, «1,2 км» from 1 km; NBSP before the unit. */
export function formatDistance(metres: number): string {
  if (metres < 50) return `до${NBSP}50${NBSP}м`;
  const tens = Math.round(metres / 10) * 10;
  if (tens < 1000) return `${tens}${NBSP}м`;
  const km = Math.round(metres / 100) / 10;
  return `${String(km).replace('.', ',')}${NBSP}км`;
}

/**
 * A distance set by the methodology (a radius, a decay threshold), printed exactly rather than rounded like
 * a measured one: whole metres below 1 km («125 м»), kilometres with up to two decimals above («1,25 км»).
 */
export function formatRadius(metres: number): string {
  const whole = Math.round(metres);
  if (whole < 1000) return `${whole}${NBSP}м`;
  return `${String(Math.round(metres / 10) / 100).replace('.', ',')}${NBSP}км`;
}

/** Whole number with NBSP between thousands: 5266 → «5 266». */
export function formatInt(n: number): string {
  const rounded = Math.round(n);
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return rounded < 0 ? `-${digits}` : digits;
}
