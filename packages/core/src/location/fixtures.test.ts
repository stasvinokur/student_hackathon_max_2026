import { describe, expect, it } from 'vitest';
import { tinyLocationIndex as ix } from './fixtures.js';
import { cellCenter, decay, gridFor, toLocal } from './geo.js';

// The mini-app draws this fixture on a map, so its facts must agree with its geometry.

/** Objects without a name are not places, so the fixture comment lists them and so does this test. */
const UNNAMED_OBJECTS = [{ criterion: 'metro', lat: 55.7963, lon: 49.1154 }];

function distanceTo(cell: number, lat: number, lon: number): number {
  const centre = cellCenter(ix.grid, ix.cells.row[cell]!, ix.cells.col[cell]!);
  const a = toLocal(ix.grid, centre.lat, centre.lon);
  const b = toLocal(ix.grid, lat, lon);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('tinyLocationIndex', () => {
  it('uses the grid gridFor makes for its bbox', () => {
    expect(gridFor({ south: 55.786, west: 49.0965, north: 55.7967, east: 49.1155 }, 300)).toEqual(ix.grid);
  });

  it('stores the distance to the nearest object of each nearest fact, named or not', () => {
    ix.criteria.forEach((criterion, c) => {
      if (criterion.fact.type !== 'nearest') return;
      const { max } = criterion.fact;
      const { near, dist } = ix.cells.fact[criterion.id]!;
      // near: the index of a place, or -2 for an object without a name.
      const objects = [
        ...ix.places.flatMap(([kind, , lat, lon], p) => (kind === c ? [{ near: p, lat, lon }] : [])),
        ...UNNAMED_OBJECTS.filter((o) => o.criterion === criterion.id).map(({ lat, lon }) => ({ near: -2, lat, lon })),
      ];
      for (let cell = 0; cell < ix.cells.row.length; cell++) {
        const nearest = objects.map((o) => ({ ...o, d: distanceTo(cell, o.lat, o.lon) })).sort((a, b) => a.d - b.d)[0];
        if (nearest === undefined || nearest.d > max) {
          expect([near![cell], dist![cell]], `cell ${cell}: nothing within ${max} m`).toEqual([-1, 0]);
        } else {
          expect(near![cell], `cell ${cell}`).toBe(nearest.near);
          expect(Math.abs(dist![cell]! - nearest.d), `cell ${cell}`).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  it('has a named nearest object, an unnamed one and none among its cells', () => {
    expect([...new Set(ix.cells.fact.metro!.near)].sort((a, b) => a - b)).toEqual([-2, -1, 0]);
  });

  it('has metro levels that follow the decay of the stored distance', () => {
    const metro = ix.criteria[0]!;
    // cap 1 and a linear norm with P95 = 1: the level is 100 × decay(distance to the nearest object), and at
    // least 1 while that object is within reach, as the builder makes it.
    expect(metro).toMatchObject({ id: 'metro', model: 'decay', cap: 1, norm: { kind: 'linear', p95: 1 } });
    if (metro.model !== 'decay') return;
    const { near, dist } = ix.cells.fact.metro!;
    ix.cells.level.metro!.forEach((level, cell) => {
      const falloff = near![cell] === -1 ? 0 : decay(dist![cell]!, metro.decay.full, metro.decay.zero);
      expect(level, `cell ${cell}`).toBe(falloff > 0 ? Math.max(1, Math.round(100 * falloff)) : 0);
    });
  });

  it('is deeply frozen, so tests cannot change it for each other', () => {
    expect(Object.isFrozen(ix)).toBe(true);
    expect(Object.isFrozen(ix.criteria[0]!.fact)).toBe(true);
    expect(Object.isFrozen(ix.places[0])).toBe(true);
    expect(() => {
      ix.cells.row[0] = 3;
    }).toThrow(TypeError);
  });
});
