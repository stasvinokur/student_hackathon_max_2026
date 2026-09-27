import { describe, expect, it } from 'vitest';
import {
  cellAt,
  cellCenter,
  cellRing,
  decay,
  formatDistance,
  formatInt,
  formatRadius,
  gridFor,
  metresPerDegree,
  pointInPolygon,
  toLocal,
  type Position,
} from './geo.js';

const KAZAN = { south: 55.6, west: 48.8, north: 55.95, east: 49.4 };
const NBSP = '\u00a0';

describe('decay', () => {
  it('gives the full weight up to the plateau radius', () => {
    expect(decay(0, 150, 700)).toBe(1);
    expect(decay(150, 150, 700)).toBe(1);
  });

  it('falls linearly between the plateau and the zero radius', () => {
    expect(decay(425, 150, 700)).toBeCloseTo(0.5, 12);
    expect(decay(590, 150, 700)).toBeCloseTo(0.2, 12);
  });

  it('is zero at and beyond the zero radius', () => {
    expect(decay(700, 150, 700)).toBe(0);
    expect(decay(5000, 150, 700)).toBe(0);
  });

  it('is a step when the plateau and the zero radius coincide', () => {
    expect(decay(300, 300, 300)).toBe(1);
    expect(decay(300.5, 300, 300)).toBe(0);
  });
});

describe('metresPerDegree', () => {
  it('matches the local projection of doc-3 at the latitude of Kazan within 0.5 %', () => {
    const { mPerDegLat, mPerDegLon } = metresPerDegree(55.775);
    expect(Math.abs(mPerDegLat / 111_338 - 1)).toBeLessThan(0.005);
    expect(Math.abs(mPerDegLon / 62_754 - 1)).toBeLessThan(0.005);
  });

  it('shrinks the longitude degree towards the pole', () => {
    expect(metresPerDegree(0).mPerDegLon).toBeGreaterThan(metresPerDegree(60).mPerDegLon * 1.9);
  });
});

describe('gridFor', () => {
  it('covers the Kazan bbox with 130 × 126 cells of 300 m', () => {
    const grid = gridFor(KAZAN, 300);
    expect(grid).toMatchObject({ origin: { lat: 55.6, lon: 48.8 }, cellMeters: 300, rows: 130, cols: 126 });
    expect(Math.abs(grid.mPerDegLat / 111_338 - 1)).toBeLessThan(0.005);
    expect(Math.abs(grid.mPerDegLon / 62_754 - 1)).toBeLessThan(0.005);
  });

  it('rounds metres per degree to whole metres so the snapshot stays stable', () => {
    const grid = gridFor(KAZAN, 300);
    expect(Number.isInteger(grid.mPerDegLat)).toBe(true);
    expect(Number.isInteger(grid.mPerDegLon)).toBe(true);
  });

  it('reaches the far edges of the bbox', () => {
    const grid = gridFor(KAZAN, 500);
    expect(grid.rows * grid.cellMeters).toBeGreaterThanOrEqual((KAZAN.north - KAZAN.south) * grid.mPerDegLat);
    expect(grid.cols * grid.cellMeters).toBeGreaterThanOrEqual((KAZAN.east - KAZAN.west) * grid.mPerDegLon);
  });
});

describe('grid cells', () => {
  const grid = gridFor(KAZAN, 300);

  it('measures local metres east and north of the origin', () => {
    const { x, y } = toLocal(grid, 55.6 + 3000 / grid.mPerDegLat, 48.8 + 600 / grid.mPerDegLon);
    expect(x).toBeCloseTo(600, 6);
    expect(y).toBeCloseTo(3000, 6);
  });

  it('maps a point to its cell and back to a centre within half a cell', () => {
    const kremlyovskaya = { lat: 55.7887, lon: 49.1221 };
    const cell = cellAt(grid, kremlyovskaya.lat, kremlyovskaya.lon);
    expect(cell).not.toBeNull();
    const centre = cellCenter(grid, cell!.row, cell!.col);
    const a = toLocal(grid, kremlyovskaya.lat, kremlyovskaya.lon);
    const b = toLocal(grid, centre.lat, centre.lon);
    expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(150);
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(150);
  });

  it('numbers rows from the south and columns from the west', () => {
    expect(cellAt(grid, 55.6001, 48.8001)).toEqual({ row: 0, col: 0 });
    expect(cellAt(grid, 55.6 + 650 / grid.mPerDegLat, 48.8 + 310 / grid.mPerDegLon)).toEqual({ row: 2, col: 1 });
  });

  it('returns null outside the grid', () => {
    expect(cellAt(grid, 55.5, 49)).toBeNull();
    expect(cellAt(grid, 55.7, 49.5)).toBeNull();
    expect(cellAt(grid, 56.1, 49)).toBeNull();
  });

  it('builds a closed counter-clockwise ring for GeoJSON', () => {
    const ring = cellRing(grid, 0, 0);
    const east = 48.8 + 300 / grid.mPerDegLon;
    const north = 55.6 + 300 / grid.mPerDegLat;
    expect(ring).toEqual([
      [48.8, 55.6],
      [east, 55.6],
      [east, north],
      [48.8, north],
      [48.8, 55.6],
    ]);
  });
});

describe('pointInPolygon', () => {
  const square: Position[] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const concave: Position[] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]];

  it('tells points inside from points outside', () => {
    expect(pointInPolygon([5, 5], square)).toBe(true);
    expect(pointInPolygon([15, 5], square)).toBe(false);
    expect(pointInPolygon([5, -1], square)).toBe(false);
  });

  it('handles concave rings', () => {
    expect(pointInPolygon([2, 8], concave)).toBe(true);
    expect(pointInPolygon([8, 8], concave)).toBe(false);
  });

  it('accepts a ring without the closing point', () => {
    expect(pointInPolygon([5, 5], square.slice(0, 4))).toBe(true);
  });
});

describe('formatDistance', () => {
  it('says "до 50 м" for very short distances', () => {
    expect(formatDistance(0)).toBe(`до${NBSP}50${NBSP}м`);
    expect(formatDistance(49)).toBe(`до${NBSP}50${NBSP}м`);
  });

  it('rounds metres to tens', () => {
    expect(formatDistance(50)).toBe(`50${NBSP}м`);
    expect(formatDistance(344)).toBe(`340${NBSP}м`);
    expect(formatDistance(345)).toBe(`350${NBSP}м`);
    expect(formatDistance(994)).toBe(`990${NBSP}м`);
  });

  it('switches to kilometres with one decimal and a comma', () => {
    expect(formatDistance(995)).toBe(`1${NBSP}км`);
    expect(formatDistance(1000)).toBe(`1${NBSP}км`);
    expect(formatDistance(1200)).toBe(`1,2${NBSP}км`);
    expect(formatDistance(1549)).toBe(`1,5${NBSP}км`);
    expect(formatDistance(12_345)).toBe(`12,3${NBSP}км`);
  });
});

describe('formatRadius', () => {
  it('prints a distance of the methodology exactly: whole metres, kilometres with up to two decimals', () => {
    expect([30, 37.5, 125, 999, 999.6, 1000, 1250, 1500, 12_345].map(formatRadius)).toEqual([
      `30${NBSP}м`,
      `38${NBSP}м`,
      `125${NBSP}м`,
      `999${NBSP}м`,
      `1${NBSP}км`,
      `1${NBSP}км`,
      `1,25${NBSP}км`,
      `1,5${NBSP}км`,
      `12,35${NBSP}км`,
    ]);
  });
});

describe('formatInt', () => {
  it('groups thousands with non-breaking spaces', () => {
    expect(formatInt(7)).toBe('7');
    expect(formatInt(312)).toBe('312');
    expect(formatInt(5266)).toBe(`5${NBSP}266`);
    expect(formatInt(1_234_567)).toBe(`1${NBSP}234${NBSP}567`);
  });

  it('rounds to a whole number', () => {
    expect(formatInt(2.6)).toBe('3');
  });
});
