import { describe, expect, it } from 'vitest';
import { RulesPackSchema, type RulesPack } from '../rules/schema.js';
import { explainCell } from './explain.js';
import { tinyLocationIndex } from './fixtures.js';
import { parseLocationCriteria, parseLocationIndex } from './parse.js';
import { compileNamePattern, type LocationIndex } from './schema.js';
import { scoreLocations } from './score.js';

const pack = RulesPackSchema.parse({
  manifest: {
    id: 'kazan-coffee',
    version: '1.0.0',
    title: 'Кофейня, Казань',
    region: { code: 'kazan', name: 'Казань', bbox: { south: 55.6, west: 48.8, north: 55.95, east: 49.4 } },
    industry: 'coffee',
    checked_at: '2026-09-18',
    cities: ['kazan'],
  },
  actions: [
    { id: 'lease-premises', title: 'Арендовать помещение', lane: 'critical', duration_days: 14, why: 'w', do_now: 'd', done_when: 'x', kind: 'recommendation' },
  ],
});

/** A copy of the fixture with one defect. */
function variant(mutate: (ix: LocationIndex) => void): LocationIndex {
  const ix = structuredClone(tinyLocationIndex);
  mutate(ix);
  return ix;
}

function issuesOf(raw: unknown, withPack?: RulesPack) {
  const result = parseLocationIndex(raw, withPack);
  if (result.ok) throw new Error('expected the snapshot to be rejected');
  return result.issues;
}

const pathsOf = (raw: unknown, withPack?: RulesPack) => issuesOf(raw, withPack).map((issue) => issue.path);

describe('parseLocationIndex', () => {
  it('accepts the tiny fixture', () => {
    const result = parseLocationIndex(tinyLocationIndex);
    expect(result).toEqual({ ok: true, value: tinyLocationIndex });
  });

  it('accepts a snapshot that belongs to the given pack', () => {
    expect(parseLocationIndex(tinyLocationIndex, pack).ok).toBe(true);
  });

  it('reports schema errors with a readable path', () => {
    const raw = variant((ix) => {
      ix.version = 'v1';
      ix.criteria[0]!.osm[0] = 'node[railway=subway';
      ix.cells.level.metro![2] = 101;
      ix.places[0]![1] = '';
    });
    expect(pathsOf(raw)).toEqual(expect.arrayContaining(['version', 'criteria[0].osm[0]', 'cells.level.metro[2]', 'places[0][1]']));
  });

  it('rejects a criterion whose role contradicts its model', () => {
    expect(pathsOf(variant((ix) => Object.assign(ix.criteria[0]!, { role: 'penalty' })))).toEqual(['criteria[0].role']);
  });

  it('requires one value per cell in every column', () => {
    const raw = variant((ix) => {
      ix.cells.col.pop();
      ix.cells.level.office!.push(0);
      ix.cells.fact.metro!.dist!.pop();
    });
    expect(issuesOf(raw)).toEqual([
      { path: 'cells.col', message: 'expected 8 values, one per cell, got 7' },
      { path: 'cells.level.office', message: 'expected 8 values, one per cell, got 9' },
      { path: 'cells.fact.metro.dist', message: 'expected 8 values, one per cell, got 7' },
    ]);
  });

  it('requires a level column for every decay and share criterion and nothing else', () => {
    const raw = variant((ix) => {
      delete ix.cells.level.industrial;
      ix.cells.level.competitors = [0, 0, 0, 0, 0, 0, 0, 0];
      ix.cells.level.parking = [0, 0, 0, 0, 0, 0, 0, 0];
    });
    expect(issuesOf(raw)).toEqual([
      { path: 'cells.level.industrial', message: 'missing level column of criterion "industrial"' },
      { path: 'cells.level.competitors', message: 'criterion "competitors" has no level: saturation is computed from facts' },
      { path: 'cells.level.parking', message: 'unknown criterion "parking"' },
    ]);
  });

  it('requires fact columns that match the fact type', () => {
    const raw = variant((ix) => {
      delete ix.cells.fact.metro!.dist;
      ix.cells.fact.office!.near = [-1, -1, -1, -1, -1, -1, -1, -1];
      delete ix.cells.fact.competitors;
      ix.cells.fact.industrial = { n: [0, 0, 0, 0, 0, 0, 0, 0] };
      ix.cells.fact.parking = { n: [0, 0, 0, 0, 0, 0, 0, 0] };
    });
    expect(issuesOf(raw)).toEqual([
      { path: 'cells.fact.metro.dist', message: 'missing column: a nearest fact needs near, dist' },
      { path: 'cells.fact.office.near', message: 'unexpected column: a count fact needs n' },
      { path: 'cells.fact.competitors', message: 'missing fact columns of criterion "competitors": n, m' },
      { path: 'cells.fact.industrial', message: 'a share fact has no columns' },
      { path: 'cells.fact.parking', message: 'unknown criterion "parking"' },
    ]);
  });

  it('rejects near indexes that do not point to a place of the same criterion', () => {
    expect(issuesOf(variant((ix) => (ix.cells.fact.metro!.near![2] = 5)))).toEqual([
      { path: 'cells.fact.metro.near[2]', message: 'place 5 does not exist (places: 1)' },
    ]);

    const foreign = variant((ix) => {
      ix.criteria.push({ ...ix.criteria[0]!, id: 'mall', title: 'ТЦ' });
      ix.cells.level.mall = [0, 0, 0, 0, 0, 0, 0, 0];
      ix.cells.fact.mall = { near: [-1, -1, -1, -1, -1, -1, -1, 0], dist: [0, 0, 0, 0, 0, 0, 0, 150] };
    });
    expect(issuesOf(foreign)).toEqual([
      { path: 'cells.fact.mall.near[7]', message: 'place 0 belongs to criterion "metro"' },
    ]);
  });

  it('keeps cells inside the grid', () => {
    const raw = variant((ix) => {
      ix.cells.row[7] = 4;
      ix.cells.col[3] = 9;
    });
    expect(issuesOf(raw)).toEqual([
      { path: 'cells.row[7]', message: 'row 4 is outside the grid (rows: 4)' },
      { path: 'cells.col[3]', message: 'col 9 is outside the grid (cols: 4)' },
    ]);
  });

  it('requires cells sorted by row, then col, without duplicates', () => {
    expect(issuesOf(variant((ix) => (ix.cells.row[4] = 0)))).toEqual([
      { path: 'cells.row[4]', message: 'cell (0, 1) comes after (1, 3): cells must be sorted by row, then col' },
    ]);
    expect(issuesOf(variant((ix) => (ix.cells.col[2] = 1)))).toEqual([
      { path: 'cells.col[2]', message: 'cell (0, 1) is listed twice' },
    ]);
  });

  it('reports only the first bad value of a column, with the total', () => {
    const raw = variant((ix) => {
      ix.cells.fact.metro!.near = [7, 7, 7, 0, 0, 0, 0, 0];
    });
    expect(issuesOf(raw)).toEqual([{ path: 'cells.fact.metro.near[0]', message: 'place 7 does not exist (places: 1); 3 cells in total' }]);
  });

  it('allows at most one saturation criterion', () => {
    const raw = variant((ix) => {
      ix.criteria.push({ ...ix.criteria[2]!, id: 'bakeries' });
      ix.cells.fact.bakeries = structuredClone(ix.cells.fact.competitors!);
    });
    expect(issuesOf(raw)).toEqual([
      { path: 'criteria[bakeries].model', message: 'only one saturation criterion is allowed, "competitors" is already one' },
    ]);
  });

  it('rejects duplicate criterion ids', () => {
    expect(issuesOf(variant((ix) => ix.criteria.push(structuredClone(ix.criteria[1]!))))).toEqual([
      { path: 'criteria[office].id', message: 'duplicate criterion id "office"' },
    ]);
  });

  it('requires at least one demand criterion', () => {
    const raw = variant((ix) => {
      ix.criteria.splice(0, 2);
      ix.places = [];
      delete ix.cells.level.metro;
      delete ix.cells.level.office;
      delete ix.cells.fact.metro;
      delete ix.cells.fact.office;
    });
    expect(issuesOf(raw)).toEqual([{ path: 'criteria', message: 'at least one demand criterion is required' }]);
  });

  it('checks title anchors', () => {
    const onCount = variant((ix) => Object.assign(ix.criteria[1]!, { titleAnchor: { priority: 2, within: 300, text: 'Офисы' } }));
    expect(issuesOf(onCount)).toEqual([
      { path: 'criteria[office].titleAnchor', message: 'a title anchor needs a fact of type nearest' },
    ]);

    const tooFar = variant((ix) => Object.assign(ix.criteria[0]!, { titleAnchor: { priority: 1, within: 2000, text: 'У метро «{name}»' } }));
    expect(issuesOf(tooFar)).toEqual([
      { path: 'criteria[metro].titleAnchor.within', message: 'must not exceed fact.max (1000): farther objects are not in the snapshot' },
    ]);
  });

  it('rejects unknown placeholders in templates', () => {
    const raw = variant((ix) => {
      Object.assign(ix.criteria[0]!.fact, {
        text: 'Метро «{nmae}» — {dist}',
        unnamed: 'Вход в метро «{name}» — {dist}',
        none: 'Метро «{name}» дальше {max}',
      });
      Object.assign(ix.criteria[3]!.fact, { text: 'Промзона — {pct} % квадрата, {n} объектов' });
    });
    expect(issuesOf(raw)).toEqual([
      { path: 'criteria[metro].fact.text', message: 'unknown placeholder {nmae}; allowed: {name}, {dist}, {max}' },
      { path: 'criteria[metro].fact.unnamed', message: 'unknown placeholder {name}; allowed: {dist}, {max}' },
      { path: 'criteria[metro].fact.none', message: 'unknown placeholder {name}; allowed: {max}' },
      { path: 'criteria[industrial].fact.text', message: 'unknown placeholder {n}; allowed: {pct}' },
    ]);
  });

  it('requires a text for the nearest object without a name', () => {
    const raw = variant((ix) => delete (ix.criteria[0]!.fact as { unnamed?: string }).unnamed);
    expect(pathsOf(raw)).toEqual(['criteria[0].fact.unnamed']);
  });

  it('rejects places of criteria without a nearest fact', () => {
    expect(issuesOf(variant((ix) => (ix.places[0]![0] = 9)))).toEqual([
      { path: 'places[0]', message: 'criterion index 9 does not exist (criteria: 4)' },
    ]);
    expect(issuesOf(variant((ix) => ix.places.push([1, 'Бизнес-центр', 55.79, 49.1])))).toEqual([
      { path: 'places[1]', message: 'criterion "office" has no nearest fact, so it has no places' },
    ]);
  });

  it('requires the version to be the OSM snapshot time and the config hash', () => {
    expect(issuesOf(variant((ix) => (ix.version = '20260923T192821Z-00000000')))).toEqual([
      { path: 'version', message: 'version must be "20260923T192821Z-3f9a1c2b": source.osmBase and the first 8 hex digits of source.configSha256' },
    ]);
  });

  it('handles a criterion named like a key of Object.prototype', () => {
    // Without own(), cells.fact.constructor would be Object and the share fact would seem to have columns.
    const key: string = 'constructor';
    const renamed = variant((ix) => {
      ix.criteria[3]!.id = key;
      ix.cells.level[key] = ix.cells.level.industrial!;
      delete ix.cells.level.industrial;
    });
    const parsed = parseLocationIndex(renamed);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    const result = scoreLocations(parsed.value);
    expect(result.scores).toEqual(scoreLocations(tinyLocationIndex).scores);
    expect(explainCell(parsed.value, result, 0).factors.find((f) => f.id === key)).toMatchObject({
      level: 60,
      fact: 'Промзона — 60\u00a0% квадрата',
    });
  });

  it('requires the verdict thresholds of competition in order: niche < saturated ≤ exclude', () => {
    const competitors = (ix: LocationIndex) => {
      const criterion = ix.criteria[2]!;
      if (criterion.model !== 'saturation') throw new Error('competitors is a saturation criterion');
      return criterion.saturation;
    };
    const missing = variant((ix) => delete (competitors(ix) as Partial<ReturnType<typeof competitors>>).saturatedRatio);
    expect(pathsOf(missing)).toEqual(['criteria[2].saturation.saturatedRatio']);
    const outOfOrder = { path: 'criteria[2].saturation', message: 'saturation must keep nicheRatio < saturatedRatio ≤ excludeRatio' };
    expect(issuesOf(variant((ix) => Object.assign(competitors(ix), { saturatedRatio: 1, nicheRatio: 1 })))).toEqual([outOfOrder]);
    // Otherwise «Исключать» would drop a cell whose verdict still reads «как обычно».
    expect(issuesOf(variant((ix) => Object.assign(competitors(ix), { excludeRatio: 1.2 })))).toEqual([outOfOrder]);
  });

  it('rejects a snapshot without cells', () => {
    const empty = variant((ix) => {
      ix.cells = { row: [], col: [], level: { metro: [], office: [], industrial: [] }, fact: { metro: { near: [], dist: [] }, office: { n: [] }, competitors: { n: [], m: [] } } };
    });
    expect(pathsOf(empty)).toEqual(['cells.row']);
  });

  it('keeps a nearest fact within its reach', () => {
    expect(issuesOf(variant((ix) => (ix.cells.fact.metro!.dist![1] = 1200)))).toEqual([
      { path: 'cells.fact.metro.dist[1]', message: 'dist 1200 is beyond fact.max (1000)' },
    ]);
    expect(issuesOf(variant((ix) => (ix.cells.fact.metro!.dist![0] = 40)))).toEqual([
      { path: 'cells.fact.metro.dist[0]', message: 'dist must be 0 when near is -1, got 40' },
    ]);
    // An object without a name is still an object within reach.
    const unnamedTooFar = variant((ix) => {
      ix.cells.fact.metro!.near![3] = -2;
      ix.cells.fact.metro!.dist![3] = 1001;
    });
    expect(issuesOf(unnamedTooFar)).toEqual([{ path: 'cells.fact.metro.dist[3]', message: 'dist 1001 is beyond fact.max (1000)' }]);
  });

  it('marks the nearest object without a name by -2 and nothing lower', () => {
    const unnamed = variant((ix) => {
      ix.cells.fact.metro!.near![1] = -2;
      ix.cells.fact.metro!.dist![1] = 0;
    });
    expect(parseLocationIndex(unnamed).ok).toBe(true);
    expect(pathsOf(variant((ix) => (ix.cells.fact.metro!.near![1] = -3)))).toEqual(['cells.fact.metro.near[1]']);
  });

  it('requires P50 not above P95', () => {
    expect(issuesOf(variant((ix) => Object.assign(ix.criteria[0]!, { norm: { kind: 'linear', p50: 2, p95: 1 } })))).toEqual([
      { path: 'criteria[0].norm', message: 'norm.p50 must not exceed norm.p95' },
    ]);
  });

  it('rejects a repeated linked action', () => {
    expect(issuesOf(variant((ix) => (ix.linkedActions = ['lease-premises', 'lease-premises'])))).toEqual([
      { path: 'linkedActions', message: 'duplicate action "lease-premises" in linkedActions' },
    ]);
  });

  it('limits the number of criteria and the size of the grid', () => {
    const office = tinyLocationIndex.criteria[1]!;
    expect(pathsOf(variant((ix) => ix.criteria.push(...Array.from({ length: 61 }, () => structuredClone(office)))))).toEqual(['criteria']);
    expect(pathsOf(variant((ix) => (ix.grid.rows = 4097)))).toEqual(['grid.rows']);
    expect(pathsOf(variant((ix) => (ix.grid.cols = 5000)))).toEqual(['grid.cols']);
  });

  it('keeps places inside the region of the pack', () => {
    const outside = variant((ix) => (ix.places[0]![2] = 55.5));
    expect(parseLocationIndex(outside).ok).toBe(true);
    expect(issuesOf(outside, pack)).toEqual([
      { path: 'places[0]', message: 'place "Кремлёвская" (55.5, 49.106065) is outside the region bbox of pack "kazan-coffee"' },
    ]);
  });

  it('checks the snapshot against its rules pack', () => {
    const other = RulesPackSchema.parse({ ...pack, manifest: { ...pack.manifest, id: 'other-pack' } });
    expect(issuesOf(tinyLocationIndex, other)).toEqual([
      { path: 'pack', message: 'snapshot of pack "kazan-coffee" does not belong to pack "other-pack"' },
    ]);

    const raw = variant((ix) => {
      ix.linkedActions = ['lease-premises', 'find-premises'];
      ix.grid.origin = { lat: 55.5, lon: 49.1 };
    });
    expect(issuesOf(raw, pack)).toEqual([
      { path: 'linkedActions', message: 'unknown action "find-premises" in linkedActions' },
      { path: 'grid.origin', message: 'grid origin 55.5, 49.1 is outside the region bbox of pack "kazan-coffee"' },
    ]);
  });
});

// ---------- methodology config ----------

/** The config fragment of doc-3 §4.2, as parsed from YAML. */
const docFragment = {
  format: 'otkryvay.location-criteria/1',
  title: 'Где открыть кофейню в Казани',
  disclaimer: 'Модельная оценка по открытым данным OpenStreetMap: помогает выбрать районы для поиска помещения.',
  linked_actions: ['lease-premises'],
  grid: { cell_meters: 300, min_buildings: 3 },
  top: { size: 20, min_spacing_cells: 2 },
  criteria: [
    {
      id: 'metro',
      title: 'Метро',
      role: 'demand',
      model: 'decay',
      default_importance: 'high',
      osm: ['node["railway"="subway_entrance"]', 'node["railway"="station"]["station"="subway"]'],
      // Entrances are mapped without a name: they take the name of their station.
      borrow_name_within: 400,
      decay: { full: 150, zero: 700 },
      cap: 1,
      norm: 'linear',
      fact: { type: 'nearest', max: 1500, text: 'Метро «{name}» — {dist}', unnamed: 'Вход в метро — {dist}', none: 'Метро дальше {max}' },
      title_anchor: { priority: 1, within: 700, text: 'У метро «{name}»' },
      min_features: 50,
    },
    {
      id: 'competitors',
      title: 'Кофейни и кафе рядом',
      role: 'penalty',
      model: 'saturation',
      default_importance: 'medium',
      osm: ['nwr["amenity"="cafe"]', 'nwr["shop"="coffee"]'],
      direct: { tags: ['cuisine~coffee_shop', 'shop=coffee'], name_pattern: '(кофе|кофейн|coffee|espresso|эспрессо)' },
      saturation: { indirect_weight: 0.5, niche_bonus: 0.5, exclude_ratio: 2 },
      fact: { type: 'competitors', radius: 300, text: 'Кофеен в {radius}: {n}, других кафе: {m}' },
      min_features: 500,
    },
    {
      id: 'industrial',
      title: 'Промзоны',
      role: 'penalty',
      model: 'share',
      geometry: 'area',
      default_importance: 'medium',
      osm: ['way["landuse"="industrial"]', 'rel["landuse"="industrial"]'],
      exclude_share: 0.5,
      fact: { type: 'share', text: 'Промзона — {pct} % квадрата', none: 'Промзон нет' },
      min_features: 200,
    },
  ],
};

/** The criteria of doc-3 §3.1 that the fragment leaves out. */
const moreCriteria = [
  {
    id: 'transit',
    title: 'Остановки транспорта',
    role: 'demand',
    model: 'decay',
    default_importance: 'medium',
    osm: ['node["highway"="bus_stop"]', 'node["railway"="tram_stop"]', 'node["public_transport"="platform"]'],
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
    title_anchor: { priority: 5, within: 800, text: 'Остановка «{name}»' },
    min_features: 1000,
  },
  {
    id: 'university',
    title: 'Вузы и колледжи',
    role: 'demand',
    model: 'decay',
    default_importance: 'high',
    osm: ['nwr["amenity"~"^(university|college)$"]'],
    decay: { full: 200, zero: 800 },
    cap: 3,
    norm: 'linear',
    fact: { type: 'nearest', max: 1000, text: '{name} — {dist}', unnamed: 'Вуз — {dist}', none: 'Вузов ближе {max} нет' },
    title_anchor: { priority: 4, within: 400, text: '{name}' },
    min_features: 50,
  },
  {
    id: 'office',
    title: 'Офисы и бизнес-центры',
    role: 'demand',
    model: 'decay',
    default_importance: 'high',
    osm: ['nwr["office"]', 'way["building"="office"]'],
    decay: { full: 150, zero: 500 },
    cap: 40,
    norm: 'log',
    fact: { type: 'count', radius: 400, text: 'Офисов и бизнес-центров в {radius}: {n}' },
    min_features: 500,
  },
  {
    id: 'mall',
    title: 'Торговые центры',
    role: 'demand',
    model: 'decay',
    default_importance: 'medium',
    osm: ['nwr["shop"="mall"]'],
    decay: { full: 100, zero: 500 },
    cap: 2,
    norm: 'linear',
    fact: { type: 'nearest', max: 800, text: 'ТЦ «{name}» — {dist}', unnamed: 'ТЦ — {dist}', none: 'ТЦ ближе {max} нет' },
    title_anchor: { priority: 3, within: 300, text: 'Рядом с ТЦ «{name}»' },
    min_features: 30,
  },
  {
    id: 'pedestrian',
    title: 'Пешеходные улицы',
    role: 'demand',
    model: 'decay',
    default_importance: 'medium',
    osm: ['way["highway"="pedestrian"]'],
    geometry: 'line',
    decay: { full: 50, zero: 300 },
    cap: 1,
    norm: 'linear',
    fact: { type: 'nearest', max: 500, text: '{name} — {dist}', unnamed: 'Пешеходная улица — {dist}', none: 'Пешеходных улиц ближе {max} нет' },
    title_anchor: { priority: 2, within: 150, text: '{name}' },
    min_features: 10,
  },
  {
    id: 'tourism',
    title: 'Достопримечательности и музеи',
    role: 'demand',
    model: 'decay',
    default_importance: 'low',
    osm: ['nwr["tourism"~"^(attraction|museum|gallery|viewpoint)$"]'],
    decay: { full: 150, zero: 500 },
    cap: 5,
    norm: 'log',
    fact: { type: 'count', radius: 400, text: 'Туристических мест в {radius}: {n}', none: 'Туристических мест в {radius} нет' },
    min_features: 50,
  },
  {
    id: 'residential',
    title: 'Многоквартирные дома',
    role: 'demand',
    model: 'decay',
    default_importance: 'medium',
    osm: ['way["building"~"^(apartments|residential|dormitory)$"]'],
    weight: { kind: 'area_levels', default_levels: 5 },
    decay: { full: 200, zero: 500 },
    norm: 'log',
    fact: { type: 'count', radius: 400, floors: 9, text: 'Многоквартирных домов в {radius}: {n} (от 9 этажей: {m})' },
    min_features: 3000,
  },
];

function configIssuesOf(raw: unknown) {
  const result = parseLocationCriteria(raw);
  if (result.ok) throw new Error('expected the config to be rejected');
  return result.issues;
}

describe('parseLocationCriteria', () => {
  it('accepts the config fragment of doc-3 §4.2', () => {
    const result = parseLocationCriteria(docFragment);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.criteria.map((c) => c.id)).toEqual(['metro', 'competitors', 'industrial']);
  });

  it('describes all ten criteria of doc-3 §3.1', () => {
    const result = parseLocationCriteria({ ...docFragment, criteria: [...docFragment.criteria, ...moreCriteria] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.criteria).toHaveLength(10);
  });

  it('reports schema errors with a readable path', () => {
    const raw = structuredClone(docFragment);
    raw.criteria[0]!.osm = ['node["railway"="subway_entrance"]', 'node["railway"="station"];out;'];
    raw.criteria[0]!.decay = { full: 800, zero: 700 };
    raw.criteria[1]!.direct = { tags: ['shop=coffee'], name_pattern: '(кофе' };
    Object.assign(raw.criteria[2]!, { colour: 'grey' });
    expect(configIssuesOf(raw).map((issue) => issue.path)).toEqual([
      'criteria[0].osm[1]',
      'criteria[0].decay',
      'criteria[1].direct.name_pattern',
      'criteria[2]',
    ]);
  });

  it('fills the verdict thresholds of competition by default and keeps them in order', () => {
    const result = parseLocationCriteria(docFragment);
    if (!result.ok) throw new Error('the fragment of doc-3 is valid');
    expect(result.value.criteria[1]).toMatchObject({ saturation: { saturated_ratio: 1.5, niche_ratio: 0.5 } });

    const withSaturation = (saturation: object) => {
      const config = structuredClone(docFragment);
      Object.assign(config.criteria[1]!, { saturation: { indirect_weight: 0.5, niche_bonus: 0.5, ...saturation } });
      return config;
    };
    const outOfOrder = { path: 'criteria[1].saturation', message: 'saturation must keep niche_ratio < saturated_ratio ≤ exclude_ratio' };
    expect(configIssuesOf(withSaturation({ exclude_ratio: 2, saturated_ratio: 1, niche_ratio: 1 }))).toEqual([outOfOrder]);
    // The default saturated_ratio of 1.5 is above an exclude_ratio of 1.2.
    expect(configIssuesOf(withSaturation({ exclude_ratio: 1.2 }))).toEqual([outOfOrder]);
  });

  it('limits the name pattern of coffee shops and compiles it in one place', () => {
    const long = structuredClone(docFragment);
    Object.assign(long.criteria[1]!, { direct: { tags: ['shop=coffee'], name_pattern: `(${'кофе|'.repeat(40)}coffee)` } });
    expect(configIssuesOf(long).map((issue) => issue.path)).toEqual(['criteria[1].direct.name_pattern']);

    const pattern = compileNamePattern('(кофе|coffee)');
    expect(pattern.flags).toBe('iu');
    expect(pattern.test('КОФЕЙНЯ «Утро»')).toBe(true);
    expect(() => compileNamePattern('(кофе')).toThrow(SyntaxError);
  });

  it('rejects a repeated linked action and too many criteria', () => {
    expect(configIssuesOf({ ...docFragment, linked_actions: ['lease-premises', 'lease-premises'] })).toEqual([
      { path: 'linked_actions', message: 'duplicate action "lease-premises" in linked_actions' },
    ]);
    const many = Array.from({ length: 65 }, (_, i) => ({ ...docFragment.criteria[0]!, id: `metro-${i}` }));
    expect(configIssuesOf({ ...docFragment, criteria: many }).map((issue) => issue.path)).toEqual(['criteria']);
  });

  it('applies the same semantic checks as the snapshot', () => {
    const office = moreCriteria.find((c) => c.id === 'office')!;
    const raw = {
      ...docFragment,
      criteria: [
        ...docFragment.criteria,
        { ...office, title_anchor: { priority: 2, within: 300, text: 'Офисы' } },
        { ...office, fact: { type: 'count', radius: 400, text: 'Офисов в {radius}: {m}' } },
      ],
    };
    expect(configIssuesOf(raw)).toEqual([
      { path: 'criteria[office].id', message: 'duplicate criterion id "office"' },
      { path: 'criteria[office].title_anchor', message: 'a title anchor needs a fact of type nearest' },
      { path: 'criteria[office].fact.text', message: 'unknown placeholder {m}; allowed: {n}, {radius}' },
    ]);
  });

  it('requires a text for the nearest object without a name and checks it', () => {
    const transit = () => structuredClone(moreCriteria.find((c) => c.id === 'transit')!) as unknown as { fact: Record<string, unknown> };
    const silent = transit();
    delete silent.fact.unnamed;
    expect(configIssuesOf({ ...docFragment, criteria: [silent] }).map((issue) => issue.path)).toEqual(['criteria[0].fact.unnamed']);
    const naming = transit();
    naming.fact.unnamed = 'Ближайшая «{name}» — {dist}';
    expect(configIssuesOf({ ...docFragment, criteria: [naming] })).toEqual([
      { path: 'criteria[transit].fact.unnamed', message: 'unknown placeholder {name}; allowed: {dist}, {max}, {n}, {radius}' },
    ]);
  });

  it('merges only point objects without a weight and weighs only footprints, not lines', () => {
    const pedestrian = moreCriteria.find((c) => c.id === 'pedestrian')!;
    const residential = moreCriteria.find((c) => c.id === 'residential')!;
    const merged = 'merge_within merges point objects: it cannot go with geometry: line or weight';
    expect(configIssuesOf({ ...docFragment, criteria: [{ ...pedestrian, merge_within: 30 }] })).toEqual([
      { path: 'criteria[0].merge_within', message: merged },
    ]);
    expect(configIssuesOf({ ...docFragment, criteria: [{ ...residential, merge_within: 30 }] })).toEqual([
      { path: 'criteria[0].merge_within', message: merged },
    ]);
    expect(configIssuesOf({ ...docFragment, criteria: [{ ...residential, geometry: 'line' }] })).toEqual([
      { path: 'criteria[0].weight', message: 'weight weighs building footprints: it cannot go with geometry: line' },
    ]);
  });

  it('bounds the grid and every distance of the methodology', () => {
    const cells = (cell_meters: number) => configIssuesOf({ ...docFragment, grid: { cell_meters, min_buildings: 3 } }).map((issue) => issue.path);
    expect(cells(49)).toEqual(['grid.cell_meters']);
    expect(cells(5001)).toEqual(['grid.cell_meters']);
    expect(parseLocationCriteria({ ...docFragment, grid: { cell_meters: 50, min_buildings: 3 } }).ok).toBe(true);

    const [metro] = docFragment.criteria;
    const far = {
      ...metro!,
      decay: { full: 5001, zero: 5001 },
      merge_within: 5001,
      borrow_name_within: 5001,
      fact: { ...metro!.fact, max: 6000, radius: 5001 },
      title_anchor: { ...metro!.title_anchor, within: 5001 },
    };
    expect(configIssuesOf({ ...docFragment, criteria: [far] }).map((issue) => issue.path)).toEqual([
      'criteria[0].merge_within',
      'criteria[0].borrow_name_within',
      'criteria[0].decay.full',
      'criteria[0].decay.zero',
      'criteria[0].fact.max',
      'criteria[0].fact.radius',
      'criteria[0].title_anchor.within',
    ]);
    // The snapshot keeps the same bounds.
    expect(pathsOf(variant((ix) => Object.assign(ix.criteria[0]!.fact, { max: 6000 })))).toEqual(['criteria[0].fact.max']);
  });

  it('takes the least number of buildings of the built-up mask, a whole number from 1, for the builder only', () => {
    const mask = (min_features: unknown) => ({ ...docFragment, grid: { cell_meters: 300, min_buildings: 3, min_features } });
    expect(parseLocationCriteria(mask(75_000)).ok).toBe(true);
    expect(parseLocationCriteria(docFragment).ok).toBe(true); // optional
    for (const bad of [0, -1, 1.5, '75000']) {
      expect(configIssuesOf(mask(bad)).map((issue) => issue.path), String(bad)).toEqual(['grid.min_features']);
    }
  });

  it('takes the distance within which an unnamed object borrows a name, for decay criteria only', () => {
    const withBorrowing = (criterion: object) => ({ ...docFragment, criteria: [criterion] });
    const [metro, competitors] = docFragment.criteria;
    expect(parseLocationCriteria(withBorrowing(metro!)).ok).toBe(true);
    expect(configIssuesOf(withBorrowing({ ...metro!, borrow_name_within: 0 })).map((issue) => issue.path)).toEqual([
      'criteria[0].borrow_name_within',
    ]);
    expect(configIssuesOf(withBorrowing({ ...competitors!, borrow_name_within: 400 })).map((issue) => issue.path)).toEqual(['criteria[0]']);
  });
});
