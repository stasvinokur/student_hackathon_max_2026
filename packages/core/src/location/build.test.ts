import { describe, expect, it } from 'vitest';
import { inBox } from '../rules/region.js';
import { RulesPackSchema } from '../rules/schema.js';
import { buildLocationIndex, type BuildLocationIndexInput } from './build.js';
import { explainCell, placeTitle } from './explain.js';
import { gridFor, type LatLon } from './geo.js';
import type { OsmFeature } from './osm.js';
import { parseLocationCriteria, parseLocationIndex } from './parse.js';
import type { LocationIndex } from './schema.js';
import { scoreLocations } from './score.js';

// A synthetic city of 5 × 5 cells of 300 m. Objects are placed in metres east (x) and north (y) of its
// south-west corner, so that every distance in a test can be read off the numbers.

const BBOX = { south: 55.78, west: 49.1, north: 55.7934, east: 49.1238 }; // ≈ 1 492 × 1 493 m
const GRID = gridFor(BBOX, 300);
const NBSP = '\u00a0';

/** A point x metres east and y metres north of the south-west corner of the city. */
function at(x: number, y: number): LatLon {
  return { lat: BBOX.south + y / GRID.mPerDegLat, lon: BBOX.west + x / GRID.mPerDegLon };
}

/** A point dx metres east and dy metres north of the centre of a cell. */
function near(row: number, col: number, dx = 0, dy = 0): LatLon {
  return at((col + 0.5) * 300 + dx, (row + 0.5) * 300 + dy);
}

/** A closed rectangle from (x0, y0) to (x1, y1), metres. */
function rectangle(x0: number, y0: number, x1: number, y1: number): LatLon[] {
  return [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)];
}

function point(key: string, where: LatLon, tags: Record<string, string> = {}, footprint: { weight?: number; levels?: number } = {}): OsmFeature {
  return { key, name: tags.name, tags, kind: 'point', lat: where.lat, lon: where.lon, weight: footprint.weight ?? 1, levels: footprint.levels };
}

function line(key: string, name: string | undefined, ...parts: LatLon[][]): OsmFeature {
  return { key, name, tags: name === undefined ? {} : { name }, kind: 'line', parts };
}

function area(key: string, ...rings: LatLon[][]): OsmFeature {
  return { key, name: undefined, tags: {}, kind: 'area', rings };
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const placeAt = (where: LatLon) => [round6(where.lat), round6(where.lon)];

// ---------- the methodology ----------

const demand = { role: 'demand', model: 'decay', default_importance: 'high', min_features: 1 };

const METRO = {
  ...demand,
  id: 'metro',
  title: 'Метро',
  osm: ['node["railway"="subway_entrance"]', 'node["railway"="station"]["station"="subway"]'],
  decay: { full: 150, zero: 700 },
  cap: 1,
  norm: 'linear',
  fact: { type: 'nearest', max: 1000, text: 'Метро «{name}» — {dist}', unnamed: 'Вход в метро — {dist}', none: 'Метро дальше {max}' },
  title_anchor: { priority: 1, within: 700, text: 'У метро «{name}»' },
};

/** Offices reach 140 m: an office within 140 m of a cell centre counts for that cell only. */
const OFFICE = {
  ...demand,
  id: 'office',
  title: 'Офисы',
  osm: ['nwr["office"]'],
  decay: { full: 50, zero: 140 },
  norm: 'linear',
  fact: { type: 'count', radius: 140, text: 'Офисов в {radius}: {n}', none: 'Офисов в {radius} нет' },
};

const TRANSIT = {
  ...demand,
  id: 'transit',
  title: 'Остановки',
  osm: ['node["highway"="bus_stop"]'],
  merge_within: 30,
  decay: { full: 100, zero: 500 },
  cap: 6,
  norm: 'log',
  fact: {
    type: 'nearest',
    max: 800,
    radius: 300,
    text: 'Остановок в {radius}: {n}, ближайшая «{name}» — {dist}',
    unnamed: 'Остановок в {radius}: {n}, ближайшая — {dist}',
    none: 'Остановок в {radius}: {n}',
  },
};

const MALL = {
  ...demand,
  id: 'mall',
  title: 'Торговые центры',
  osm: ['nwr["shop"="mall"]'],
  decay: { full: 100, zero: 500 },
  cap: 2,
  norm: 'linear',
  fact: { type: 'nearest', max: 800, text: 'ТЦ «{name}» — {dist}', unnamed: 'ТЦ — {dist}', none: 'ТЦ ближе {max} нет' },
};

const PEDESTRIAN = {
  ...demand,
  id: 'pedestrian',
  title: 'Пешеходные улицы',
  osm: ['way["highway"="pedestrian"]'],
  geometry: 'line',
  decay: { full: 50, zero: 300 },
  cap: 1,
  norm: 'linear',
  fact: { type: 'nearest', max: 500, text: '{name} — {dist}', unnamed: 'Пешеходная улица — {dist}', none: 'Пешеходных улиц ближе {max} нет' },
  title_anchor: { priority: 2, within: 150, text: '{name}' },
};

/** Apartment blocks, weighted by floor area; like offices, they reach 140 m. */
const RESIDENTIAL = {
  ...demand,
  id: 'residential',
  title: 'Многоквартирные дома',
  osm: ['way["building"="apartments"]'],
  weight: { kind: 'area_levels', default_levels: 5 },
  decay: { full: 50, zero: 140 },
  norm: 'linear',
  fact: { type: 'count', radius: 140, floors: 9, text: 'Домов в {radius}: {n}, от 9 этажей: {m}' },
};

const COMPETITORS = {
  id: 'competitors',
  title: 'Кофейни и кафе рядом',
  role: 'penalty',
  model: 'saturation',
  default_importance: 'medium',
  osm: ['nwr["amenity"="cafe"]', 'nwr["shop"="coffee"]'],
  direct: { tags: ['cuisine~coffee_shop', 'shop=coffee'], name_pattern: '(кофе|кофейн|coffee|espresso|эспрессо)' },
  saturation: { indirect_weight: 0.5, niche_bonus: 0.5, exclude_ratio: 2 },
  fact: { type: 'competitors', radius: 300, text: 'Кофеен в {radius}: {n}, других кафе: {m}', none: 'Кофеен и кафе в {radius} нет' },
  min_features: 1,
};

const INDUSTRIAL = {
  id: 'industrial',
  title: 'Промзоны',
  role: 'penalty',
  model: 'share',
  geometry: 'area',
  default_importance: 'medium',
  osm: ['way["landuse"="industrial"]', 'rel["landuse"="industrial"]'],
  exclude_share: 0.5,
  fact: { type: 'share', text: 'Промзона — {pct} % квадрата', none: 'Промзон нет' },
  min_features: 1,
};

const SHA = '3f9a1c2b'.repeat(8);
const SOURCE = {
  osmBase: '2026-09-23T19:28:21Z',
  extractedAt: '2026-09-23T19:41:07Z',
  endpoint: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  method: 'https://github.com/trade-stasvinokur/student_hackathon_max_2026/tree/main/apps/api/src/scripts/location-index',
};

interface CityOptions {
  buildings?: LatLon[];
  /** 0 by default: every cell of the city is in the index, and cell (row, col) has the index row × 5 + col. */
  minBuildings?: number;
}

function inputOf(criteria: object[], layers: Record<string, OsmFeature[]>, { buildings = [], minBuildings = 0 }: CityOptions = {}): BuildLocationIndexInput {
  const config = parseLocationCriteria({
    format: 'otkryvay.location-criteria/1',
    title: 'Где открыть кофейню',
    disclaimer: 'Модельная оценка по открытым данным OpenStreetMap.',
    linked_actions: ['lease-premises'],
    grid: { cell_meters: 300, min_buildings: minBuildings },
    top: { size: 5, min_spacing_cells: 1 },
    criteria,
  });
  if (!config.ok) throw new Error(`invalid test config: ${JSON.stringify(config.issues)}`);
  return { pack: 'kazan-coffee', bbox: BBOX, config: config.value, configSha256: SHA, layers, buildings, source: SOURCE };
}

const build = (criteria: object[], layers: Record<string, OsmFeature[]>, options?: CityOptions): LocationIndex =>
  buildLocationIndex(inputOf(criteria, layers, options));

/** Index of a cell when every cell of the city is in the index. */
const cell = (row: number, col: number) => row * 5 + col;

/** The non-zero values of a cell column by "row,col". */
function nonZero(ix: LocationIndex, values: readonly number[]): Record<string, number> {
  const found: Record<string, number> = {};
  values.forEach((value, i) => {
    if (value !== 0) found[`${ix.cells.row[i]},${ix.cells.col[i]}`] = value;
  });
  return found;
}

/** The fact sentence of a criterion in a cell, as the card shows it. */
function factAt(ix: LocationIndex, id: string, row: number, col: number): string {
  return explainCell(ix, scoreLocations(ix), cell(row, col)).factors.find((factor) => factor.id === id)!.fact;
}

// ---------- a city with every kind of criterion ----------

/** Three buildings around the centre of a cell. */
const block = (row: number, col: number) => [near(row, col, -20), near(row, col), near(row, col, 20)];

function cityInput(): BuildLocationIndexInput {
  return inputOf(
    [{ ...METRO, borrow_name_within: 400 }, TRANSIT, PEDESTRIAN, RESIDENTIAL, COMPETITORS, INDUSTRIAL],
    {
      metro: [
        point('n1', near(4, 4), { railway: 'station', name: 'Кремлёвская' }),
        point('n2', near(3, 4, 0, -40), { railway: 'subway_entrance' }),
        // Two entrances at one point: only their keys decide which one names the cells around.
        point('n3', near(0, 0), { railway: 'subway_entrance', name: 'Северный вход' }),
        point('n4', near(0, 0), { railway: 'subway_entrance', name: 'Южный вход' }),
      ],
      transit: [
        point('n10', near(2, 2)),
        point('n11', near(2, 2, 20), { name: 'Площадь Тукая' }),
        point('n12', near(2, 2, 40)),
        point('n13', near(1, 3), { name: 'ЦУМ' }),
      ],
      pedestrian: [line('w1', 'улица Баумана', [at(100, 800), at(1400, 800)])],
      residential: [
        point('w10', near(3, 1), { building: 'apartments' }, { weight: 800, levels: 9 }),
        point('w11', near(3, 1, 30), { building: 'apartments' }, { weight: 400 }),
        point('w12', near(3, 1, 30), { building: 'apartments' }, { weight: 600, levels: 12 }),
      ],
      competitors: [
        point('n20', near(2, 2, 60), { amenity: 'cafe', name: 'Кофейня «Утро»' }),
        point('n21', near(2, 3), { amenity: 'cafe', name: 'Чайхана' }),
        point('w22', near(1, 1), { shop: 'coffee' }),
      ],
      industrial: [area('w30', rectangle(300, 300, 750, 600))],
    },
    { buildings: [...block(0, 1), ...block(1, 1), ...block(3, 1), ...block(3, 2), ...block(0, 3)], minBuildings: 3 },
  );
}

const PACK = RulesPackSchema.parse({
  manifest: {
    id: 'kazan-coffee',
    version: '1.0.0',
    title: 'Кофейня, Казань',
    region: { code: 'kazan', name: 'Казань', bbox: BBOX },
    industry: 'coffee',
    checked_at: '2026-09-18',
    cities: ['kazan'],
  },
  actions: [
    { id: 'lease-premises', title: 'Арендовать помещение', lane: 'critical', duration_days: 14, why: 'w', do_now: 'd', done_when: 'x', kind: 'recommendation' },
  ],
});

// ---------- tests ----------

describe('buildLocationIndex', () => {
  it('makes a snapshot of the methodology over the grid of the bbox', () => {
    const ix = build([METRO], { metro: [point('n1', near(2, 2), { name: 'Кремлёвская' })] });
    expect(ix).toMatchObject({
      format: 'otkryvay.location-index/1',
      pack: 'kazan-coffee',
      version: '20260923T192821Z-3f9a1c2b',
      title: 'Где открыть кофейню',
      disclaimer: 'Модельная оценка по открытым данным OpenStreetMap.',
      dataStatus: 'prepared_snapshot',
      linkedActions: ['lease-premises'],
      top: { size: 5, minSpacingCells: 1 },
      grid: GRID,
    });
    expect(ix.grid).toMatchObject({ rows: 5, cols: 5 });
    expect(ix.source).toEqual({
      name: 'OpenStreetMap',
      licence: 'ODbL-1.0',
      licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
      attribution: '© участники OpenStreetMap',
      attributionUrl: 'https://www.openstreetmap.org/copyright',
      ...SOURCE,
      configSha256: SHA,
    });
  });

  it('copies the criteria in the form of the snapshot, without what only the builder reads', () => {
    const ix = buildLocationIndex(cityInput());
    const norm = (kind: string) => ({ kind, p50: expect.any(Number), p95: expect.any(Number) });
    expect(ix.criteria).toStrictEqual([
      {
        id: 'metro',
        title: 'Метро',
        role: 'demand',
        model: 'decay',
        defaultImportance: 'high',
        osm: METRO.osm,
        decay: { full: 150, zero: 700 },
        cap: 1,
        norm: norm('linear'),
        fact: METRO.fact,
        titleAnchor: METRO.title_anchor,
        featureCount: 4,
      },
      {
        id: 'transit',
        title: 'Остановки',
        role: 'demand',
        model: 'decay',
        defaultImportance: 'high',
        osm: TRANSIT.osm,
        decay: { full: 100, zero: 500 },
        cap: 6,
        norm: norm('log'),
        fact: TRANSIT.fact,
        featureCount: 3, // n10 and n11 are one stop
      },
      {
        id: 'pedestrian',
        title: 'Пешеходные улицы',
        role: 'demand',
        model: 'decay',
        defaultImportance: 'high',
        osm: PEDESTRIAN.osm,
        decay: { full: 50, zero: 300 },
        cap: 1,
        norm: norm('linear'),
        fact: PEDESTRIAN.fact,
        titleAnchor: PEDESTRIAN.title_anchor,
        featureCount: 1,
      },
      {
        id: 'residential',
        title: 'Многоквартирные дома',
        role: 'demand',
        model: 'decay',
        defaultImportance: 'high',
        osm: RESIDENTIAL.osm,
        decay: { full: 50, zero: 140 },
        norm: norm('linear'),
        fact: RESIDENTIAL.fact,
        featureCount: 3,
      },
      {
        id: 'competitors',
        title: 'Кофейни и кафе рядом',
        role: 'penalty',
        model: 'saturation',
        defaultImportance: 'medium',
        osm: COMPETITORS.osm,
        direct: { tags: ['cuisine~coffee_shop', 'shop=coffee'], namePattern: '(кофе|кофейн|coffee|espresso|эспрессо)' },
        // The thresholds of the verdict come with their defaults.
        saturation: { indirectWeight: 0.5, nicheBonus: 0.5, excludeRatio: 2, saturatedRatio: 1.5, nicheRatio: 0.5 },
        fact: COMPETITORS.fact,
        featureCount: 3,
      },
      {
        id: 'industrial',
        title: 'Промзоны',
        role: 'penalty',
        model: 'share',
        defaultImportance: 'medium',
        osm: INDUSTRIAL.osm,
        norm: norm('share'),
        excludeShare: 0.5,
        fact: INDUSTRIAL.fact,
        featureCount: 1,
      },
    ]);
  });

  it('takes a cell with enough buildings or a demand object, sorted by row, then col', () => {
    const buildings = [
      near(0, 0, -20),
      near(0, 0, 20), // two buildings in (0, 0): not enough
      ...block(0, 1),
      ...block(2, 1),
      // Three buildings in the last column of the grid, but east of the bbox.
      at(1497, 100),
      at(1497, 150),
      at(1497, 200),
      { lat: 55.7, lon: 49 }, // far outside the city
    ];
    const ix = build(
      [METRO, COMPETITORS, INDUSTRIAL],
      {
        metro: [point('n1', near(0, 2), { name: 'Кремлёвская' })],
        // Penalties do not bring a cell into the index.
        competitors: [point('n2', near(1, 1), { amenity: 'cafe' })],
        industrial: [area('w3', rectangle(900, 900, 1200, 1200))],
      },
      { buildings, minBuildings: 3 },
    );
    expect(ix.cells.row.map((row, i) => [row, ix.cells.col[i]])).toEqual([
      [0, 1],
      [0, 2],
      [2, 1],
    ]);
  });

  it('takes a cell for its buildings or a point demand object, not for a line crossing it', () => {
    // A pedestrian street along y = 800 m crosses row 2, where only (2, 1) has buildings: an empty cell on
    // a street or a bridge has no premises to rent.
    const street = line('w1', 'улица Баумана', [at(100, 800), at(1400, 800)]);
    const ix = build([PEDESTRIAN], { pedestrian: [street] }, { buildings: block(2, 1), minBuildings: 3 });
    expect(ix.cells.row.map((row, i) => [row, ix.cells.col[i]])).toEqual([[2, 1]]);
    // The street still counts for the cells of the index: it passes 50 m from the centre of (2, 1).
    expect([ix.cells.fact.pedestrian!.dist![0], ix.cells.level.pedestrian![0]]).toEqual([50, 100]);
  });

  it('gives a level of at least 1 to every cell with any exposure', () => {
    // Ten offices at the centre of (4, 4) make P95 ≈ 9.5; an office 137.3 m from the centre of (0, 0) adds
    // 0.03, which would round to level 0, yet it is within reach — what «Обязательно» asks for.
    const offices = [...Array.from({ length: 10 }, (_, i) => point(`n${i + 1}`, near(4, 4, i))), point('n20', near(0, 0, 137.3))];
    const ix = build([OFFICE], { office: offices });
    expect(nonZero(ix, ix.cells.level.office!)).toEqual({ '0,0': 1, '4,4': 100 });
  });

  it('turns exposure into levels by P50 and P95 of the cells that have any', () => {
    // Offices at cell centres: exposure 1 in (0, 0), 2 in (2, 2), 4 in (4, 4), 0 in the other 22 cells.
    const offices = [
      point('n1', near(0, 0)),
      point('n2', near(2, 2)),
      point('n3', near(2, 2, 10)),
      point('n4', near(4, 4)),
      point('n5', near(4, 4, 10)),
      point('n6', near(4, 4, -10)),
      point('n7', near(4, 4, 0, 10)),
    ];
    // Over 1, 2 and 4 only: P50 = 2, P95 = 2 + 0.9 × (4 − 2) = 3.8.
    const linear = build([OFFICE], { office: offices });
    expect(linear.criteria[0]).toMatchObject({ norm: { kind: 'linear', p50: 2, p95: 3.8 } });
    expect(nonZero(linear, linear.cells.level.office!)).toEqual({ '0,0': 26, '2,2': 53, '4,4': 100 }); // e / 3.8
    const log = build([{ ...OFFICE, norm: 'log' }], { office: offices });
    expect(log.criteria[0]).toMatchObject({ norm: { kind: 'log', p50: 2, p95: 3.8 } });
    expect(nonZero(log, log.cells.level.office!)).toEqual({ '0,0': 38, '2,2': 65, '4,4': 100 }); // ln(1 + e/2) / ln(2.9)
  });

  it('leaves every level at 0 when no cell is within reach', () => {
    // An office at the corner of four cells is 212 m from their centres, beyond its 140 m.
    const ix = build([OFFICE], { office: [point('n1', at(600, 600))] });
    expect(ix.criteria[0]).toMatchObject({ norm: { kind: 'linear', p50: 0, p95: 0 } });
    expect(nonZero(ix, ix.cells.level.office!)).toEqual({});
    expect(nonZero(ix, ix.cells.fact.office!.n!)).toEqual({});
  });

  it('adds up only the cap nearest objects', () => {
    // Offices 0, 20 and 95 m from the centre of (2, 2) add 1, 1 and 0.5; it is the only cell they reach,
    // so its exposure is both P50 and P95.
    const offices = [point('n1', near(2, 2)), point('n2', near(2, 2, 20)), point('n3', near(2, 2, 0, 95))];
    const capped = build([{ ...OFFICE, cap: 2 }], { office: offices });
    expect(capped.criteria[0]).toMatchObject({ norm: { p50: 2, p95: 2 } });
    expect(build([OFFICE], { office: offices }).criteria[0]).toMatchObject({ norm: { p50: 2.5, p95: 2.5 } });
    // The count of the fact does not depend on the cap.
    expect(capped.cells.fact.office!.n![cell(2, 2)]).toBe(3);
  });

  it('breaks a tie of distances by the key', () => {
    const houses = [point('w2', near(2, 2, 30), {}, { weight: 300 }), point('w1', near(2, 2, 30), {}, { weight: 100 })];
    expect(build([{ ...RESIDENTIAL, cap: 1 }], { residential: houses }).criteria[0]).toMatchObject({ norm: { p95: 100 } });
  });

  it('weighs a building by its floor area and counts those with enough mapped floors', () => {
    const houses = [
      point('w1', near(2, 2), {}, { weight: 1000, levels: 12 }),
      point('w2', near(2, 2, 20), {}, { weight: 500, levels: 9 }),
      point('w3', near(2, 2, 0, 20), {}, { weight: 500, levels: 5 }),
      point('w4', near(2, 2, -20), {}, { weight: 500 }), // floors not mapped
    ];
    const ix = build([RESIDENTIAL], { residential: houses });
    expect(ix.criteria[0]).toMatchObject({ norm: { p95: 2500 } });
    expect(factAt(ix, 'residential', 2, 2)).toBe(`Домов в 140${NBSP}м: 4, от 9 этажей: 2`);
    // Without `weight: area_levels` every object counts once.
    expect(build([OFFICE], { office: houses }).criteria[0]).toMatchObject({ norm: { p95: 4 } });
  });

  it('merges stops closer than merge_within', () => {
    const stops = (apart: number) => [point('n1', near(2, 2)), point('n2', near(2, 2, apart))];
    const merged = build([TRANSIT], { transit: stops(20) });
    expect(merged.criteria[0]!.featureCount).toBe(1);
    expect(merged.cells.fact.transit!.n![cell(2, 2)]).toBe(1);
    const apart = build([TRANSIT], { transit: stops(40) });
    expect(apart.criteria[0]!.featureCount).toBe(2);
    expect(apart.cells.fact.transit!.n![cell(2, 2)]).toBe(2);
  });

  it('merges in key order into the first cluster in reach, which keeps its first object and the first name', () => {
    // n2 is 20 m from n1 and joins it; n3 is 20 m from n2 but 40 m from n1, so it starts a cluster.
    const stops = [point('n3', near(2, 2, 40)), point('n2', near(2, 2, 20), { name: 'Площадь Тукая' }), point('n1', near(2, 2))];
    const ix = build([TRANSIT], { transit: stops });
    expect(ix.criteria[0]!.featureCount).toBe(2);
    expect(ix.cells.fact.transit!.near![cell(2, 2)]).toBe(0);
    expect(ix.places).toEqual([[0, 'Площадь Тукая', ...placeAt(near(2, 2))]]);

    // n3 is 25 m from both n1 and n2, which are 50 m apart: it joins the cluster of n1 and names it.
    const between = build([TRANSIT], {
      transit: [point('n1', near(2, 2)), point('n2', near(2, 2, 50), { name: 'ЦУМ' }), point('n3', near(2, 2, 25), { name: 'Кольцо' })],
    });
    expect(between.criteria[0]!.featureCount).toBe(2);
    expect(between.places[between.cells.fact.transit!.near![cell(2, 2)]!]).toEqual([0, 'Кольцо', ...placeAt(near(2, 2))]);

    // Two named stops 20 m apart: the cluster keeps the name of the first.
    const named = build([TRANSIT], { transit: [point('n2', near(2, 2, 20), { name: 'Вторая' }), point('n1', near(2, 2), { name: 'Первая' })] });
    expect(named.places).toEqual([[0, 'Первая', ...placeAt(near(2, 2))]]);
  });

  it('names an entrance after the nearest station within borrow_name_within', () => {
    const layer = [
      point('n1', near(4, 4), { railway: 'station', name: 'Кремлёвская' }), // 300 m from n3
      point('n2', near(3, 3, -50), { railway: 'station', name: 'Площадь Тукая' }), // 350 m from n3
      point('n3', near(3, 4), { railway: 'subway_entrance' }),
      point('n4', near(0, 0), { railway: 'subway_entrance' }), // no station within 400 m
    ];
    const ix = build([{ ...METRO, borrow_name_within: 400 }], { metro: layer });
    expect(factAt(ix, 'metro', 3, 4)).toBe(`Метро «Кремлёвская» — до${NBSP}50${NBSP}м`);
    expect(factAt(ix, 'metro', 0, 0)).toBe(`Вход в метро — до${NBSP}50${NBSP}м`);
    // The distance is measured to the entrance, so the place is the entrance.
    expect(ix.places).toContainEqual([0, 'Кремлёвская', ...placeAt(near(3, 4))]);

    const unborrowed = build([METRO], { metro: layer });
    expect(factAt(unborrowed, 'metro', 3, 4)).toBe(`Вход в метро — до${NBSP}50${NBSP}м`);
  });

  it('measures the distance to a line along its whole length', () => {
    // A street of 1.3 km along y = 800 m: the centre of (2, 2) is 50 m from its middle, 650 m from its ends.
    const ix = build([PEDESTRIAN], { pedestrian: [line('w1', 'улица Баумана', [at(100, 800), at(1400, 800)])] });
    expect(ix.cells.fact.pedestrian!.dist![cell(2, 2)]).toBe(50);
    expect(ix.criteria[0]!.featureCount).toBe(1);
    // The street is one place, at its middle.
    expect(ix.places).toEqual([[0, 'улица Баумана', ...placeAt(at(750, 800))]]);
    expect(placeTitle(ix, cell(2, 2))).toBe('улица Баумана');
  });

  it('keeps the points of a line at most 25 m apart', () => {
    // From x = 125 m, points every 25 m hit x = 750, 50 m from the centre of (2, 2); every 50 m they would miss it.
    const ix = build([PEDESTRIAN], { pedestrian: [line('w1', 'улица Баумана', [at(125, 800), at(1375, 800)])] });
    expect(ix.cells.fact.pedestrian!.dist![cell(2, 2)]).toBe(50);
  });

  it('places a line at half its length, however its corners are spread', () => {
    // Corners every 10 m for 400 m, then 900 m straight: half of 1 300 m is x = 750, not the middle corner.
    const street = [...Array.from({ length: 41 }, (_, i) => at(100 + 10 * i, 800)), at(1400, 800)];
    const ix = build([PEDESTRIAN], { pedestrian: [line('w1', 'улица Баумана', street)] });
    expect(ix.places).toEqual([[0, 'улица Баумана', ...placeAt(at(750, 800))]]);
  });

  it('does not bridge the gap between the parts of a line', () => {
    // The corner (900, 600) could not be resolved: a chord from (600, 600) to (900, 900) would pass through the
    // centre of (2, 2); the parts end 212 m from it.
    const street = line('w1', 'улица Баумана', [at(100, 600), at(600, 600)], [at(900, 900), at(900, 1400)]);
    const ix = build([PEDESTRIAN], { pedestrian: [street] });
    expect(ix.cells.fact.pedestrian!.dist![cell(2, 2)]).toBe(212);
  });

  it('walks only the part of a line inside the bbox, however far the line goes', () => {
    // A way to a point no map has, a million degrees east (featuresFromOverpass would refuse it, so the feature
    // is made here): points every 25 m along all of it would be billions and take far longer than the test
    // may; clipped to the city, it is its 1.4 km inside.
    const street = line('w1', 'улица Баумана', [at(100, 800), { lat: at(0, 800).lat, lon: 1e6 }]);
    const ix = build([PEDESTRIAN], { pedestrian: [street] });
    expect(ix.cells.fact.pedestrian!.dist![cell(2, 2)]).toBe(50);
  });

  it('measures the share of a cell under areas on a 5 × 5 sample', () => {
    const zones = [
      area('w1', rectangle(300, 300, 750, 600)), // all of (1, 1) and the western half of (1, 2)
      area('r2', rectangle(880, 880, 1220, 1220), rectangle(1210, 10, 1490, 290)), // (3, 3) and (0, 4)
    ];
    const ix = build([OFFICE, INDUSTRIAL], { office: [point('n1', near(2, 2))], industrial: zones });
    const level = ix.cells.level.industrial!;
    expect(level[cell(1, 1)]).toBe(100);
    expect(level[cell(1, 2)]).toBeGreaterThanOrEqual(40);
    expect(level[cell(1, 2)]).toBeLessThanOrEqual(60);
    expect([level[cell(3, 3)], level[cell(0, 4)]]).toEqual([100, 100]);
    expect(level.filter((share) => share > 0)).toHaveLength(4);
    expect(ix.criteria[1]).toMatchObject({ norm: { kind: 'share', p50: 1, p95: 1 }, featureCount: 2 });
    expect(factAt(ix, 'industrial', 1, 1)).toBe(`Промзона — 100${NBSP}% квадрата`);
  });

  it('samples a cell on 5 × 5 points', () => {
    // A zone over the western third of (1, 2), x from 600 to 700 m: 2 of 5 sample columns, where 4 × 4 would give 1 of 4.
    const ix = build([OFFICE, INDUSTRIAL], { office: [point('n1', near(2, 2))], industrial: [area('w1', rectangle(600, 300, 700, 600))] });
    expect(ix.cells.level.industrial![cell(1, 2)]).toBe(40);
  });

  it('takes only the areas that overlap the bbox', () => {
    const office = { office: [point('n1', near(2, 2))] };
    const inside = area('w1', rectangle(300, 300, 600, 600));
    const south = area('w2', rectangle(300, -600, 600, -300)); // entirely south of the city
    const east = area('w3', rectangle(1495, 100, 1499, 200)); // in the last column of the grid, east of the bbox
    const ix = build([OFFICE, INDUSTRIAL], { ...office, industrial: [inside, south, east] });
    expect(ix.criteria[1]!.featureCount).toBe(1);
    // An area around the whole city overlaps it without an edge inside.
    const around = build([OFFICE, INDUSTRIAL], { ...office, industrial: [area('r4', rectangle(-1000, -1000, 3000, 3000))] });
    expect(around.criteria[1]!.featureCount).toBe(1);
    expect(around.cells.level.industrial!.every((share) => share === 100)).toBe(true);
  });

  it('counts coffee shops and other cafes within the radius', () => {
    const cafes = [
      point('n1', near(2, 2, 50), { amenity: 'cafe', cuisine: 'coffee_shop;donut' }), // coffee shop by a tag
      point('n2', near(2, 2, 100), { shop: 'Coffee' }), // by a tag, whatever the case
      point('n3', near(2, 2, 0, 150), { amenity: 'cafe', name: 'Кофейня «Утро»' }), // by the name
      point('n4', near(2, 2, -200), { amenity: 'cafe', name: 'Лайк', brand: 'Coffee Like' }), // by the brand
      point('n5', near(2, 2, 0, -250), { amenity: 'cafe', name: 'Чайхана' }),
      point('n6', near(2, 2, 100, 100), { amenity: 'cafe', cuisine: 'coffee' }), // not a coffee_shop
      point('n7', near(2, 2, 0, 290), { amenity: 'cafe', shop: 'coffee_beans' }), // shop=coffee is exact
      point('n8', near(2, 2, 350), { shop: 'coffee' }), // beyond 300 m
    ];
    const ix = build([OFFICE, COMPETITORS], { office: [point('n0', near(2, 2))], competitors: cafes });
    const { n, m } = ix.cells.fact.competitors!;
    expect([n![cell(2, 2)], m![cell(2, 2)]]).toEqual([4, 3]);
    expect(factAt(ix, 'competitors', 2, 2)).toBe(`Кофеен в 300${NBSP}м: 4, других кафе: 3`);
  });

  it('counts no cafe outside the bbox', () => {
    // 100 m east and 200 m south of the centre of (0, 0): the second is outside the city.
    const cafes = [point('n1', near(0, 0, 100), { amenity: 'cafe' }), point('n2', near(0, 0, 0, -200), { amenity: 'cafe' })];
    const ix = build([OFFICE, COMPETITORS], { office: [point('n0', near(2, 2))], competitors: cafes });
    expect(ix.cells.fact.competitors!.m![cell(0, 0)]).toBe(1);
    expect(ix.criteria[1]!.featureCount).toBe(1);
  });

  it('points a nearest fact to a place, to an object without a name or to nothing', () => {
    const ix = build([METRO], { metro: [point('n1', near(4, 4), { name: 'Кремлёвская' }), point('n2', near(0, 0))] });
    const { near: nearest, dist } = ix.cells.fact.metro!;
    const factAtCell = (row: number, col: number) => [nearest![cell(row, col)], dist![cell(row, col)]];
    expect(factAtCell(4, 4)).toEqual([0, 0]);
    expect(factAtCell(4, 3)).toEqual([0, 300]);
    expect(factAtCell(0, 0)).toEqual([-2, 0]);
    expect(factAtCell(0, 1)).toEqual([-2, 300]);
    expect(factAtCell(4, 0)).toEqual([-1, 0]); // 1.2 km from both
    // All the cells near the station point to one place.
    expect(ix.places).toEqual([[0, 'Кремлёвская', ...placeAt(near(4, 4))]]);
    expect(factAt(ix, 'metro', 4, 0)).toBe(`Метро дальше 1${NBSP}км`);
  });

  it('rounds dist to whole metres without passing a fractional fact.max', () => {
    const metro = { ...METRO, fact: { ...METRO.fact, max: 100.7 }, title_anchor: undefined };
    const ix = build([metro], { metro: [point('n1', near(2, 2, 100.6), { name: 'Кремлёвская' })] });
    expect(ix.cells.fact.metro!.dist![cell(2, 2)]).toBe(100); // 100.6 m would round to 101
    expect(parseLocationIndex(ix).ok).toBe(true);
  });

  it('keeps a place per criterion even when two layers share an OSM key', () => {
    // One node can be a station in one layer and a mall in another: each criterion points to its own place.
    const ix = build([METRO, MALL], {
      metro: [point('n1', near(4, 4), { name: 'Кремлёвская' })],
      mall: [point('n1', near(4, 4), { name: 'Кольцо' })],
    });
    expect(ix.places).toEqual([
      [0, 'Кремлёвская', ...placeAt(near(4, 4))],
      [1, 'Кольцо', ...placeAt(near(4, 4))],
    ]);
    expect(parseLocationIndex(ix).ok).toBe(true);
  });

  it('lists places in the order the cells first point to them', () => {
    // Cell (0, 0) comes first and sees only the mall; the station is the second place, though metro is the first criterion.
    const ix = build([METRO, MALL], {
      metro: [point('n1', near(4, 4), { name: 'Кремлёвская' })],
      mall: [point('n2', near(0, 0), { name: 'Кольцо' })],
    });
    expect(ix.places).toEqual([
      [1, 'Кольцо', ...placeAt(near(0, 0))],
      [0, 'Кремлёвская', ...placeAt(near(4, 4))],
    ]);
  });

  it('leaves out objects outside the bbox, so every place lies in the region', () => {
    const ix = build([METRO, PEDESTRIAN], {
      metro: [point('n1', at(150, -100), { name: 'За городом' }), point('n2', near(4, 4), { name: 'Кремлёвская' })],
      // A street from 490 m west of the city: its place is at half of the 910 m inside, (455, 150).
      pedestrian: [line('w1', 'улица за краем', [at(-490, 150), at(910, 150)])],
    });
    expect(ix.criteria[0]!.featureCount).toBe(1);
    expect(ix.cells.fact.metro!.near![cell(0, 0)]).toBe(-1);
    expect(ix.places).toEqual([
      [1, 'улица за краем', ...placeAt(at(455, 150))],
      [0, 'Кремлёвская', ...placeAt(near(4, 4))],
    ]);
    for (const [, name, lat, lon] of ix.places) expect(inBox(BBOX, lat, lon), name).toBe(true);
  });

  it('gives the same snapshot whatever the order of the input', () => {
    const input = cityInput();
    const shuffle = <T>(items: readonly T[]) => [...items].reverse().map((_, i, reversed) => reversed[(i + 2) % reversed.length]!);
    const shuffled = {
      ...input,
      layers: Object.fromEntries(Object.entries(input.layers).map(([id, features]) => [id, shuffle(features)])),
      buildings: shuffle(input.buildings),
    };
    const ix = buildLocationIndex(input);
    expect(JSON.stringify(buildLocationIndex(shuffled))).toBe(JSON.stringify(ix));
    expect(ix.places.map((place) => place[1])).toContain('Северный вход');
    expect(ix.places.map((place) => place[1])).not.toContain('Южный вход');
  });

  it('makes a snapshot that parseLocationIndex accepts, also against its rules pack', () => {
    const ix = buildLocationIndex(cityInput());
    expect(parseLocationIndex(ix)).toEqual({ ok: true, value: ix });
    const parsed = parseLocationIndex(JSON.parse(JSON.stringify(ix)), PACK);
    expect(parsed.ok ? [] : parsed.issues).toEqual([]);
  });

  it('refuses to build without the layer of a criterion or with suspiciously little data', () => {
    expect(() => build([METRO, OFFICE], { metro: [point('n1', near(2, 2))] })).toThrow('no OSM layer for criterion "office"');
    expect(() => build([{ ...METRO, min_features: 3 }], { metro: [point('n1', near(2, 2)), point('n2', near(1, 1))] })).toThrow(
      'suspiciously little data: criterion "metro" has 2 OSM objects, min_features is 3',
    );
  });

  it('refuses a built-up mask with fewer buildings than grid.min_features, which stays out of the snapshot', () => {
    const input = inputOf([METRO], { metro: [point('n1', near(2, 2))] }, { buildings: [...block(0, 1), ...block(1, 1)], minBuildings: 3 });
    const withMask = (min_features: number) => ({ ...input, config: { ...input.config, grid: { ...input.config.grid, min_features } } });
    expect(() => buildLocationIndex(withMask(7))).toThrow('suspiciously little data: the built-up mask has 6 buildings, grid.min_features is 7');
    const ix = buildLocationIndex(withMask(6));
    expect(ix.grid).toEqual(GRID);
    expect(parseLocationIndex(ix).ok).toBe(true);
  });

  it('refuses an OSM object twice in one layer', () => {
    const twice = [point('n1', near(2, 2), { name: 'Кремлёвская' }), point('n1', near(1, 1), { name: 'Площадь Тукая' })];
    expect(() => build([METRO], { metro: twice })).toThrow('duplicate OSM object n1 in layer "metro"');
  });

  it('refuses features of another kind than the criterion takes', () => {
    const office = { office: [point('n1', near(2, 2))] };
    expect(() => build([OFFICE], { office: [area('w1', rectangle(0, 0, 100, 100))] })).toThrow('criterion "office" takes points, got an area (w1)');
    expect(() => build([OFFICE], { office: [line('w2', undefined, [at(0, 0), at(100, 0)])] })).toThrow('criterion "office" takes points, got a line (w2)');
    expect(() => build([OFFICE, PEDESTRIAN], { ...office, pedestrian: [point('n3', near(1, 1))] })).toThrow(
      'criterion "pedestrian" takes lines, got a point (n3)',
    );
    expect(() => build([OFFICE, INDUSTRIAL], { ...office, industrial: [point('n2', near(1, 1))] })).toThrow(
      'criterion "industrial" takes areas, got a point (n2)',
    );
  });

  it('refuses a footprint weight that is not a positive number', () => {
    for (const weight of [Infinity, Number.NaN, 0, -5]) {
      expect(() => build([RESIDENTIAL], { residential: [point('w7', near(2, 2), {}, { weight })] }), String(weight)).toThrow(
        `OSM object w7 in layer "residential" weighs ${weight}: footprint area × floors must be a positive number`,
      );
    }
  });

  it('refuses a grid of more than 4096 cells a side before making it', () => {
    const bbox = { south: 40, west: 30, north: 70, east: 60 };
    const { rows, cols } = gridFor(bbox, 300);
    expect(() => buildLocationIndex({ ...inputOf([METRO], { metro: [point('n1', near(2, 2))] }), bbox })).toThrow(
      `the grid of ${rows} × ${cols} cells is larger than 4096 a side: take larger cells or a smaller bbox`,
    );
  });

  it('refuses a snapshot without cells', () => {
    // No buildings, and the only demand object lies outside the bbox.
    expect(() => build([METRO], { metro: [point('n1', at(150, -100))] }, { minBuildings: 3 })).toThrow(
      'no cell made it into the index: none has 3 buildings or a point demand object',
    );
  });
});

// ---------- performance ----------

/** A city of the size of Kazan (doc-3 §2): 153 524 buildings, about 5 000 cells in the index, 13 000 objects. */
function kazanSizedInput(): BuildLocationIndexInput {
  // Deterministic pseudo-random points in a disc of 12 km: a multiplicative hash of the index and the layer.
  const noise = (i: number, k: number) => (((i + 1) * 2_654_435_761 * (k + 3)) % 4_294_967_296) / 4_294_967_296;
  const spot = (i: number, k: number): LatLon => {
    const r = 0.11 * Math.sqrt(noise(i, k));
    const angle = 2 * Math.PI * noise(i, k + 1);
    return { lat: 55.79 + r * Math.sin(angle), lon: 49.12 + (r * Math.cos(angle)) / 0.5625 };
  };
  const points = (n: number, k: number, tags: (i: number) => Record<string, string> = () => ({})) =>
    Array.from({ length: n }, (_, i) => point(`n${i}`, spot(i, k), tags(i)));
  const square = (centre: LatLon, side: number) => {
    const [dLat, dLon] = [side / 2 / 111_338, side / 2 / 62_755];
    return [
      { lat: centre.lat - dLat, lon: centre.lon - dLon },
      { lat: centre.lat - dLat, lon: centre.lon + dLon },
      { lat: centre.lat + dLat, lon: centre.lon + dLon },
      { lat: centre.lat + dLat, lon: centre.lon - dLon },
      { lat: centre.lat - dLat, lon: centre.lon - dLon },
    ];
  };
  const config = parseLocationCriteria({
    format: 'otkryvay.location-criteria/1',
    title: 'Где открыть кофейню в Казани',
    disclaimer: 'Модельная оценка.',
    grid: { cell_meters: 300, min_buildings: 3 },
    top: { size: 20, min_spacing_cells: 2 },
    criteria: [
      { ...METRO, fact: { ...METRO.fact, max: 1500 }, borrow_name_within: 400 },
      TRANSIT,
      { ...OFFICE, decay: { full: 150, zero: 500 }, cap: 40, fact: { ...OFFICE.fact, radius: 400 } },
      PEDESTRIAN,
      { ...RESIDENTIAL, decay: { full: 200, zero: 500 }, fact: { ...RESIDENTIAL.fact, radius: 400 } },
      COMPETITORS,
      INDUSTRIAL,
    ],
  });
  if (!config.ok) throw new Error(JSON.stringify(config.issues));
  return {
    pack: 'kazan-coffee',
    bbox: { south: 55.6, west: 48.8, north: 55.95, east: 49.4 },
    config: config.value,
    configSha256: SHA,
    layers: {
      metro: points(79, 1, (i) => (i < 11 ? { name: `Станция ${i}` } : {})),
      transit: points(3308, 3, (i) => (i % 3 === 0 ? {} : { name: `Остановка ${i}` })),
      office: points(1579, 5),
      pedestrian: Array.from({ length: 33 }, (_, i) => {
        const start = spot(i, 7);
        return line(`w${i}`, `Улица ${i}`, [start, { lat: start.lat + 0.003, lon: start.lon + 0.004 }, { lat: start.lat + 0.004, lon: start.lon + 0.009 }]);
      }),
      residential: Array.from({ length: 6700 }, (_, i) => point(`w${i}`, spot(i, 9), {}, { weight: 300 + 5000 * noise(i, 10), levels: 1 + (i % 16) })),
      competitors: points(948, 11, (i) => (i % 4 === 0 ? { name: 'Кофейня' } : { name: 'Кафе' })),
      industrial: Array.from({ length: 486 }, (_, i) => area(`w${i}`, square(spot(i, 13), 100 + 700 * noise(i, 14)))),
    },
    buildings: Array.from({ length: 153_524 }, (_, i) => spot(i, 15)),
    source: SOURCE,
  };
}

describe('performance', () => {
  // About 60 ms on a laptop; the limit leaves room for a slow machine and parallel test runs, and still
  // catches a search without buckets or a share without its prefilter (seconds to minutes).
  it('builds a snapshot of a city the size of Kazan in well under a second', () => {
    const input = kazanSizedInput();
    let best = Infinity;
    for (let run = 0; run < 2; run++) {
      const start = performance.now();
      const ix = buildLocationIndex(input);
      best = Math.min(best, performance.now() - start);
      expect(ix.cells.row.length).toBeGreaterThan(4000);
    }
    expect(best).toBeLessThan(1500);
  });
});
