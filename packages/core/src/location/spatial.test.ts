import { describe, expect, it } from 'vitest';
import { inBox } from '../rules/region.js';
import { gridFor, type LatLon } from './geo.js';
import { borrowNames, lineInside, merge } from './spatial.js';

// A city of ≈ 1 492 × 1 493 m; points are placed in metres east (x) and north (y) of its south-west corner.
const BBOX = { south: 55.78, west: 49.1, north: 55.7934, east: 49.1238 };
const GRID = gridFor(BBOX, 300);

function at(x: number, y: number): LatLon {
  return { lat: BBOX.south + y / GRID.mPerDegLat, lon: BBOX.west + x / GRID.mPerDegLon };
}

/** Points every 25 m along each segment of a whole line, then those inside the bbox: the reference. */
function insideOfWhole(line: readonly LatLon[]): LatLon[] {
  const points: LatLon[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const dx = (b.lon - a.lon) * GRID.mPerDegLon;
    const dy = (b.lat - a.lat) * GRID.mPerDegLat;
    const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / 25 - 1e-9));
    for (let k = 0; k < steps; k++) points.push({ lat: a.lat + ((b.lat - a.lat) * k) / steps, lon: a.lon + ((b.lon - a.lon) * k) / steps });
  }
  const last = line[line.length - 1]!;
  points.push({ lat: last.lat, lon: last.lon });
  return points.filter((p) => inBox(BBOX, p.lat, p.lon));
}

describe('lineInside', () => {
  it('keeps exactly the points of the whole line that lie inside the bbox', () => {
    const lines = [
      [at(700, 700), at(2700, 1900)], // leaves the city through its north-east corner
      [at(-600, 300), at(2100, 1200)], // crosses the whole city
      [at(100, 100), at(-300, 500), at(400, 900), at(1800, 900), at(1000, 1400)], // in, out, in, out, in
      [at(0, 400), at(900, 400)], // starts on the western edge
    ];
    for (const line of lines) expect(lineInside([line], GRID, BBOX)?.points).toEqual(insideOfWhole(line));
  });

  it('does not walk the part of a line outside the bbox', () => {
    // 8 000 km east and back a hundred times: walking it all would make 65 million points.
    const far = { lat: 55.79, lon: 179 };
    const zigzag = Array.from({ length: 201 }, (_, i) => (i % 2 === 0 ? at(750, 800) : far));
    const inside = lineInside([zigzag], GRID, BBOX)!;
    // About 30 points a leg: the 743 m from the start to the eastern edge of the city.
    expect(inside.points.length).toBeLessThan(200 * 32);
    expect(inside.points.every((p) => inBox(BBOX, p.lat, p.lon))).toBe(true);
  });

  it('stands at half the length of the part inside the bbox', () => {
    const middle = (...parts: LatLon[][]) => {
      const point = lineInside(parts, GRID, BBOX)!.middle;
      return [Math.round((point.lon - BBOX.west) * GRID.mPerDegLon * 1e6) / 1e6, Math.round((point.lat - BBOX.south) * GRID.mPerDegLat * 1e6) / 1e6];
    };
    // Corners every 10 m for 400 m, then one straight 900 m: the middle is at 650 m of 1 300 m, not at the middle corner.
    const uneven = [...Array.from({ length: 41 }, (_, i) => at(100 + 10 * i, 800)), at(1400, 800)];
    expect(middle(uneven)).toEqual([750, 800]);
    // 490 m of the street lie west of the city: half of the 910 m inside.
    expect(middle([at(-490, 150), at(910, 150)])).toEqual([455, 150]);
    // Two parts of 200 m and 600 m: 400 m in, 200 m into the second part.
    expect(middle([at(100, 100), at(300, 100)], [at(500, 100), at(1100, 100)])).toEqual([700, 100]);
  });

  it('gives nothing for a line outside the bbox', () => {
    expect(lineInside([[at(-500, -500), at(-100, 2000)]], GRID, BBOX)).toBeUndefined();
  });
});

describe('merge and borrowNames', () => {
  /** Frozen copies: changing one throws, so a function that changes its input fails. */
  const frozen = <T extends object>(items: T[]) => items.map((item) => Object.freeze({ ...item }));

  it('merges into new clusters, leaving the objects given as they are', () => {
    const stops = frozen([
      { x: 0, y: 0, name: undefined as string | undefined },
      { x: 10, y: 0, name: 'Площадь Тукая' },
      { x: 100, y: 0, name: 'ЦУМ' },
    ]);
    expect(merge(stops, 30)).toEqual([
      { x: 0, y: 0, name: 'Площадь Тукая' },
      { x: 100, y: 0, name: 'ЦУМ' },
    ]);
    expect(stops[0]!.name).toBeUndefined();
  });

  it('lends names to copies, leaving the objects given as they are', () => {
    const metro = frozen([
      { x: 0, y: 0, name: 'Кремлёвская' as string | undefined },
      { x: 300, y: 0, name: undefined },
    ]);
    expect(borrowNames(metro, 400)).toEqual([
      { x: 0, y: 0, name: 'Кремлёвская' },
      { x: 300, y: 0, name: 'Кремлёвская' },
    ]);
    expect(metro[1]!.name).toBeUndefined();
  });
});
