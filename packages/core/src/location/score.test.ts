import { describe, expect, it } from 'vitest';
import { tinyLocationIndex as ix } from './fixtures.js';
import { parseLocationIndex } from './parse.js';
import type { Importance, LocationIndex, SaturationCriterion } from './schema.js';
import { percentileScores, saturation, scoreLocations, type LocationSettings } from './score.js';

const NBSP = '\u00a0';

// Cells of the fixture: 0 wasteland, 1 and 2 office twins, 3 weak demand, 4 niche, 5 saturated,
// 6 the best, 7 relies on the metro (see fixtures.ts).
const DEFAULT_SCORES = [0, 43, 43, 14, 86, 29, 100, 71];

function variant(mutate: (copy: LocationIndex) => void): LocationIndex {
  const copy = structuredClone(ix);
  mutate(copy);
  return copy;
}

interface CellSpec {
  metro?: number;
  office?: number;
  industrial?: number;
  /** Coffee shops and other cafes around. */
  cafes?: number;
  others?: number;
}

/** A one-row snapshot with the criteria of the fixture and the given levels and cafes. */
function indexOf(cells: readonly CellSpec[]): LocationIndex {
  const column = (pick: (cell: CellSpec) => number | undefined) => cells.map((cell) => pick(cell) ?? 0);
  return variant((copy) => {
    copy.grid = { ...copy.grid, rows: 1, cols: cells.length };
    copy.cells = {
      row: column(() => 0),
      col: cells.map((_, i) => i),
      level: { metro: column((c) => c.metro), office: column((c) => c.office), industrial: column((c) => c.industrial) },
      fact: {
        metro: { near: column(() => -1), dist: column(() => 0) },
        office: { n: column(() => 0) },
        competitors: { n: column((c) => c.cafes), m: column((c) => c.others) },
      },
    };
  });
}

/**
 * Pairs (a, b) where a has at least b's level of a demand criterion and is not below b, yet falls below b
 * when that criterion weighs more; other criteria keep their default importance.
 */
function monotonicityViolations(index: LocationIndex, id: string): string[] {
  const steps: Importance[] = ['off', 'low', 'medium', 'high'];
  const level = index.cells.level[id]!;
  const violations: string[] = [];
  for (let s = 1; s < steps.length; s++) {
    const before = scoreLocations(index, { [id]: steps[s - 1]! });
    const after = scoreLocations(index, { [id]: steps[s]! });
    for (let a = 0; a < level.length; a++) {
      for (let b = 0; b < level.length; b++) {
        if (level[a]! < level[b]! || before.raw[a]! < before.raw[b]!) continue;
        const fell = after.raw[a]! < after.raw[b]! - 1e-9 || (after.raw[a]! > after.raw[b]! + 1e-9 && after.scores[a]! < after.scores[b]!);
        if (fell) violations.push(`${id} ${steps[s - 1]} → ${steps[s]}: cell ${a} fell below cell ${b}`);
      }
    }
  }
  return violations;
}

function competitorsOf(index: LocationIndex): SaturationCriterion {
  const criterion = index.criteria.find((c) => c.model === 'saturation');
  if (criterion?.model !== 'saturation') throw new Error('no saturation criterion');
  return criterion;
}

/** Cells ordered from the best score to the worst, excluded cells left out. */
function ranking(scores: Array<number | null>): number[] {
  return scores
    .map((score, cell) => ({ score, cell }))
    .filter((x): x is { score: number; cell: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.cell - b.cell)
    .map((x) => x.cell);
}

describe('percentileScores', () => {
  it('gives 0 to the lowest candidate and 100 to the highest', () => {
    expect(percentileScores([5, 1, 3], [1, 1, 1])).toEqual([100, 0, 50]);
  });

  it('gives equal raw values the same score', () => {
    expect(percentileScores([2, 2, 1, 3], [1, 1, 1, 1])).toEqual([33, 33, 0, 100]);
  });

  it('ranks candidates only', () => {
    expect(percentileScores([5, 1, 3, 10], [1, 1, 1, 0])).toEqual([100, 0, 50, null]);
  });

  it('gives 100 to a single candidate', () => {
    expect(percentileScores([7, 9], [1, 0])).toEqual([100, null]);
  });
});

describe('scoreLocations', () => {
  it('scores the fixture with the default importance', () => {
    const result = scoreLocations(ix);
    expect(result.scores).toEqual(DEFAULT_SCORES);
    expect(ranking(result.scores)).toEqual([6, 4, 7, 1, 2, 5, 3, 0]);
    expect(result.candidates).toBe(8);
    expect(result.warnings).toEqual([]);
    expect(result.importance).toEqual(['high', 'high', 'medium', 'medium']);
  });

  it('computes demand, penalties and raw by doc-3 §3.4', () => {
    const result = scoreLocations(ix);
    expect([...result.demand]).toEqual([0, 300, 300, 60, 300, 300, 540, 360]);
    const expected = [-20, 50, 50, 40 / 6, 400 / 6, (300 - 100 * Math.log2(3)) / 6, 90, 60];
    expected.forEach((raw, cell) => expect(result.raw[cell]).toBeCloseTo(raw, 9));
  });

  it('drops a cell that relied on a switched-off criterion', () => {
    const result = scoreLocations(ix, { metro: 'off' });
    expect(result.scores).toEqual([0, 86, 86, 29, 57, 14, 71, 43]);
    expect(result.scores[7]).toBeLessThan(DEFAULT_SCORES[7]!);
  });

  it('never lets a cell fall below one with a lower level when that criterion weighs more', () => {
    // The review's counterexample to deciles by the user's weights: with the metro switched on, cell 0 used
    // to leave the decile of cafe-rich quiet cells (a niche bonus) for one of cafe-free cells (a penalty).
    const reviewCase = indexOf([
      { metro: 60, cafes: 2 },
      { cafes: 8 },
      { cafes: 8 },
      { cafes: 8 },
      { office: 20 },
      { office: 20 },
      { office: 20 },
    ]);
    const noise = (i: number, k: number) => (((i + 1) * 2_654_435_761 * (k + 3)) % 4_294_967_296) / 4_294_967_296;
    const random = indexOf(
      Array.from({ length: 60 }, (_, i) => ({
        metro: noise(i, 0) < 0.5 ? 0 : Math.floor(noise(i, 1) * 101),
        office: Math.floor(noise(i, 2) * 101),
        industrial: noise(i, 3) < 0.8 ? 0 : Math.floor(noise(i, 4) * 101),
        cafes: Math.floor(noise(i, 5) * 6),
        others: Math.floor(noise(i, 6) * 8),
      })),
    );
    expect(parseLocationIndex(random).ok).toBe(true);
    for (const index of [ix, reviewCase, random]) {
      for (const id of ['metro', 'office']) expect(monotonicityViolations(index, id)).toEqual([]);
    }
  });

  it('keeps the usual competition of a place whatever the user weighs', () => {
    const usual = scoreLocations(ix).competition;
    const settings: LocationSettings[] = [{ metro: 'off' }, { office: 'low' }, { metro: 'required', office: 'off' }];
    for (const s of settings) expect(scoreLocations(ix, s).competition).toEqual(usual);
  });

  it('puts every cell into one demand decile when no demand criterion is on by default', () => {
    const quiet = variant((copy) => {
      for (const criterion of copy.criteria) if (criterion.model === 'decay') criterion.defaultImportance = 'off';
    });
    const result = scoreLocations(quiet, { metro: 'high' });
    expect(result.warnings).toEqual([]);
    expect([...result.competition!.decile]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(result.competition!.expected[0]).toBe(1); // median of 0, 0, 0.5, 1, 1, 2, 3.5, 5
    expect([...result.competition!.s].every(Number.isFinite)).toBe(true);
    expect([...result.raw].every(Number.isFinite)).toBe(true);
  });

  it('gives the worst candidate 0, the best 100 and equal cells equal scores', () => {
    const { scores } = scoreLocations(ix);
    expect(Math.min(...(scores as number[]))).toBe(0);
    expect(Math.max(...(scores as number[]))).toBe(100);
    expect(scores[1]).toBe(scores[2]);
  });

  it('excludes cells without a required demand object and ranks the rest among themselves', () => {
    const result = scoreLocations(ix, { metro: 'required' });
    expect(result.scores).toEqual([null, null, null, null, 67, 0, 100, 33]);
    expect(result.candidates).toBe(4);
    expect([...result.excludedBy]).toEqual([0, 0, 0, 0, -1, -1, -1, -1]);
  });

  it('excludes cells where the required share reaches the limit', () => {
    const result = scoreLocations(ix, { industrial: 'required' });
    expect(result.scores).toEqual([null, 33, 33, 0, 83, 17, 100, 67]);
    expect(result.excludedBy[0]).toBe(3);
  });

  it('excludes saturated cells when competitors are required', () => {
    const result = scoreLocations(ix, { competitors: 'required' });
    expect(result.scores).toEqual([0, 33, 33, 17, 83, null, 100, 67]);
    expect(result.excludedBy[5]).toBe(2);
  });

  it('excludes a share or a competition ratio exactly at the limit', () => {
    // doc-3 §3.6 keeps a share below 50 % and a ratio below 2.
    const atLimit = variant((copy) => {
      copy.cells.level.industrial![3] = 50;
      copy.cells.fact.competitors!.n![5] = 2;
      copy.cells.fact.competitors!.m![5] = 2;
    });
    expect(scoreLocations(atLimit).competition!.ratio[5]).toBe(2);
    expect(scoreLocations(atLimit, { industrial: 'required' }).excludedBy[3]).toBe(3);
    expect(scoreLocations(atLimit, { competitors: 'required' }).excludedBy[5]).toBe(2);

    const belowLimit = variant((copy) => (copy.cells.level.industrial![3] = 49));
    expect(scoreLocations(belowLimit, { industrial: 'required' }).excludedBy[3]).toBe(-1);
  });

  it('treats settings that are not an object as no settings', () => {
    // What JSON.parse makes of a missing or broken local storage entry.
    expect(scoreLocations(ix, null).scores).toEqual(DEFAULT_SCORES);
    for (const settings of ['high', ['metro'], 42, true]) {
      expect(scoreLocations(ix, settings as unknown as LocationSettings).scores).toEqual(DEFAULT_SCORES);
    }
  });

  it('ignores unknown criteria and invalid importance in the settings', () => {
    const settings = { parking: 'high', metro: 'very-high' } as unknown as Record<string, Importance>;
    expect(scoreLocations(ix, settings).scores).toEqual(DEFAULT_SCORES);
  });

  it('penalises a saturated cell and rewards a niche in the fixture', () => {
    const { competition } = scoreLocations(ix);
    expect(competition).not.toBeNull();
    expect([...competition!.local]).toEqual([0, 1, 1, 0.5, 0, 5, 3.5, 2]);
    expect([...competition!.decile]).toEqual([0, 2, 2, 1, 2, 2, 8, 7]);
    expect(competition!.expected).toEqual([0, 0.5, 1, 0, 0, 0, 0, 2, 3.5, 0]);
    expect(competition!.ratio[4]).toBe(0.5);
    expect(competition!.s[4]).toBe(-0.5);
    expect(competition!.ratio[5]).toBe(3);
    expect(competition!.s[5]).toBeCloseTo(Math.log2(3) / 2, 12);
  });

  it('computes competition the same way whatever the importance of competitors', () => {
    const off = scoreLocations(ix, { competitors: 'off' });
    expect(off.competition).toEqual(scoreLocations(ix).competition);
    expect(off.competition).toEqual(scoreLocations(ix, { competitors: 'high' }).competition);
    // Switched off, competition no longer moves raw: only the industrial share is subtracted.
    [...off.raw].forEach((raw, cell) => {
      expect(raw).toBeCloseTo((off.demand[cell]! - 2 * ix.cells.level.industrial![cell]!) / 6, 9);
    });
  });

  it('takes the usual competition over all cells, not only candidates', () => {
    expect(scoreLocations(ix, { metro: 'required' }).competition).toEqual(scoreLocations(ix).competition);
  });

  it('has no competition without a saturation criterion', () => {
    const withoutCafes = variant((copy) => {
      copy.criteria.splice(2, 1);
      delete copy.cells.fact.competitors;
    });
    expect(parseLocationIndex(withoutCafes).ok).toBe(true);
    const result = scoreLocations(withoutCafes);
    expect(result.competition).toBeNull();
    expect(result.raw[4]).toBeCloseTo(50, 9);
  });

  it('warns and scores nothing when every demand criterion is off', () => {
    const result = scoreLocations(ix, { metro: 'off', office: 'off' });
    expect(result.warnings).toEqual(['no_demand_criteria']);
    expect(result.scores).toEqual([null, null, null, null, null, null, null, null]);
    expect(result.top).toEqual([]);
  });

  it('warns when no cell passes the required criteria', () => {
    const noMetro = variant((copy) => {
      copy.cells.level.metro = [0, 0, 0, 0, 0, 0, 0, 0];
    });
    const result = scoreLocations(noMetro, { metro: 'required' });
    expect(result.warnings).toEqual(['no_candidates']);
    expect(result.candidates).toBe(0);
    expect(result.scores.every((score) => score === null)).toBe(true);
    expect(result.top).toEqual([]);
  });
});

describe('saturation', () => {
  /** Ten cells of equal demand: eight with 6 coffee shops, one with 30, one with none. */
  function crowded(nicheBonus = 0.5) {
    const index = indexOf([6, 6, 6, 6, 6, 6, 6, 6, 30, 0].map((cafes) => ({ office: 40, cafes })));
    const criterion = competitorsOf(index);
    criterion.saturation.nicheBonus = nicheBonus;
    return saturation(index, criterion);
  }

  it('caps the penalty at 1 when local competition is far above the usual', () => {
    const result = crowded();
    expect(result.expected[0]).toBe(6);
    expect(result.ratio[8]).toBeCloseTo(31 / 7, 12);
    expect(result.s[8]).toBe(1);
    expect(result.s[0]).toBe(0);
  });

  it('gives the niche bonus of the config where competition is usually high and there is none', () => {
    expect(crowded().s[9]).toBe(-0.5);
    expect(crowded(0.3).s[9]).toBe(-0.3);
  });

  it('compares a cell with cells of similar demand', () => {
    // Quiet streets have no cafes, busy ones have 8: the same 4 cafes are many for the first, few for the second.
    const quiet = [0, 0, 0, 0, 0, 0, 0, 0, 0, 4].map((cafes) => ({ office: 5, cafes }));
    const busy = [8, 8, 8, 8, 8, 8, 8, 8, 8, 4].map((cafes) => ({ metro: 100, office: 90, cafes }));
    const index = indexOf([...quiet, ...busy]);
    const result = saturation(index, competitorsOf(index));
    expect([...result.decile]).toEqual([...new Array<number>(10).fill(0), ...new Array<number>(10).fill(5)]);
    expect(result.s[9]).toBeGreaterThan(0);
    expect(result.s[19]).toBeLessThan(0);
  });

  it('measures similar demand by the default importance of the methodology', () => {
    // Offices weigh 1 by default here and the metro 3: a metro level of 30 is as much demand as 90 of offices.
    const index = indexOf([
      { metro: 30, cafes: 0 },
      { office: 90, cafes: 6 },
      { metro: 90, office: 90, cafes: 1 },
    ]);
    index.criteria.find((c) => c.id === 'office')!.defaultImportance = 'low';
    const result = saturation(index, competitorsOf(index));
    expect([...result.decile]).toEqual([0, 0, 6]);
    expect(result.expected[0]).toBe(3);
  });
});

describe('top places', () => {
  const coordinates = (lat: string, lon: string) => `${lat}°${NBSP}с.${NBSP}ш., ${lon}°${NBSP}в.${NBSP}д.`;

  it('keeps the best places at least minSpacingCells apart', () => {
    const { top } = scoreLocations(ix);
    expect(top.map((place) => place.cell)).toEqual([6, 1, 3]);
    for (const a of top) {
      for (const b of top) {
        if (a === b) continue;
        const rows = Math.abs(ix.cells.row[a.cell]! - ix.cells.row[b.cell]!);
        const cols = Math.abs(ix.cells.col[a.cell]! - ix.cells.col[b.cell]!);
        expect(Math.max(rows, cols)).toBeGreaterThanOrEqual(ix.top.minSpacingCells);
      }
    }
  });

  it('puts the place with more demand first when raw ties', () => {
    // Raw 50 both: cell 0 has less demand and no industry, cell 1 more demand and an industrial zone.
    const tie = indexOf([{ metro: 100 }, { metro: 100, office: 40, industrial: 60 }]);
    const result = scoreLocations(tie, {}, { minSpacingCells: 0 });
    expect(result.raw[0]).toBe(result.raw[1]);
    expect(result.demand[1]).toBeGreaterThan(result.demand[0]!);
    expect(result.top.map((place) => [place.cell, place.rank])).toEqual([
      [1, 1],
      [0, 1],
    ]);
  });

  it('takes the size and spacing from the options', () => {
    expect(scoreLocations(ix, {}, { minSpacingCells: 3 }).top.map((place) => place.cell)).toEqual([6, 1]);
    expect(scoreLocations(ix, {}, { minSpacingCells: 0 }).top.map((place) => place.cell)).toEqual([6, 4, 7, 1, 2, 5, 3, 0]);
    expect(scoreLocations(ix, {}, { topN: 2 }).top.map((place) => place.cell)).toEqual([6, 1]);
  });

  it('names each place and shows its two strongest facts', () => {
    expect(scoreLocations(ix).top).toEqual([
      {
        cell: 6,
        rank: 1,
        score: 100,
        title: 'У метро «Кремлёвская»',
        highlights: [`Метро «Кремлёвская» — 150${NBSP}м`, `Офисов и бизнес-центров в 400${NBSP}м: 12`],
      },
      // No metro within the 700 m of the anchor: these two are named by the coordinates of their centres.
      { cell: 1, rank: 4, score: 43, title: coordinates('55,787', '49,104'), highlights: [`Офисов и бизнес-центров в 400${NBSP}м: 18`] },
      { cell: 3, rank: 7, score: 14, title: coordinates('55,790', '49,113'), highlights: [`Офисов и бизнес-центров в 400${NBSP}м: 2`] },
    ]);
  });
});

// ---------- performance ----------

/** 70 × 76 = 5 320 cells (Kazan has 5 266) and 10 criteria, as in doc-3 §3.1. */
function cityLikeIndex(): LocationIndex {
  const [metro, office, competitors, industrial] = ix.criteria;
  const rows = 70;
  const cols = 76;
  const count = rows * cols;
  const row: number[] = [];
  const col: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      row.push(r);
      col.push(c);
    }
  }
  // Deterministic pseudo-random levels: a multiplicative hash of the cell and the criterion.
  const noise = (i: number, k: number) => ((i + 1) * 2_654_435_761 * (k + 3)) % 4_294_967_296;
  const level = (k: number, max: number) => Array.from({ length: count }, (_, i) => Math.floor((noise(i, k) / 4_294_967_296) * (max + 1)));

  const demandIds = Array.from({ length: 8 }, (_, k) => `demand-${k}`);
  const copy = structuredClone(ix);
  copy.grid = { ...copy.grid, rows, cols };
  copy.places = [];
  copy.criteria = [
    ...demandIds.map((id, k) => ({ ...structuredClone(k % 2 === 0 ? metro! : office!), id })),
    structuredClone(competitors!),
    structuredClone(industrial!),
  ];
  copy.cells = {
    row,
    col,
    level: { ...Object.fromEntries(demandIds.map((id, k) => [id, level(k, 100)])), industrial: level(9, 1).map((x) => x * 40) },
    fact: {
      ...Object.fromEntries(
        demandIds.map((id, k) =>
          k % 2 === 0 ? [id, { near: new Array<number>(count).fill(-1), dist: new Array<number>(count).fill(0) }] : [id, { n: level(k + 20, 30) }],
        ),
      ),
      competitors: { n: level(30, 4), m: level(31, 8) },
    },
  };
  return copy;
}

describe('performance', () => {
  // The target is 5 ms (about 2 ms on a laptop). The test allows 25 ms so that parallel `pnpm -r test`,
  // coverage or a slow machine do not make it flaky. It still catches a slowdown of an order of magnitude,
  // such as an explanation built for every cell (≈ 130 ms); a bare quadratic loop over the cells takes
  // ≈ 14 ms on a laptop and could slip through.
  it('rescores a city-sized snapshot in milliseconds', () => {
    const city = cityLikeIndex();
    expect(parseLocationIndex(city).ok).toBe(true);
    const settings = { 'demand-0': 'required', industrial: 'high' } as const;
    scoreLocations(city, settings); // warm-up

    let best = Infinity;
    for (let run = 0; run < 7; run++) {
      const start = performance.now();
      const result = scoreLocations(city, run % 2 === 0 ? settings : {});
      best = Math.min(best, performance.now() - start);
      expect(result.top.length).toBeGreaterThan(0);
    }
    expect(best).toBeLessThan(25);
  });
});
