import { describe, expect, it } from 'vitest';
import { metresPerDegree } from './geo.js';
import {
  buildingCentres,
  buildingsCountQuery,
  buildingsQuery,
  featuresFromOverpass,
  isOsmTime,
  overpassCountQuery,
  overpassOsmBase,
  overpassQuery,
  type OsmFeature,
} from './osm.js';
import { LocationCriterionConfigSchema, type LocationCriterionConfig } from './schema.js';

const KAZAN = { south: 55.6, west: 48.8, north: 55.95, east: 49.4 };
const T = '2026-09-23T19:28:21Z';

const criterion = (raw: object): LocationCriterionConfig => LocationCriterionConfigSchema.parse(raw);
const decay = { role: 'demand', model: 'decay', default_importance: 'high', decay: { full: 150, zero: 700 }, norm: 'linear', min_features: 1 };
const nearest = { type: 'nearest', max: 1000, text: '{name} — {dist}', unnamed: 'Объект — {dist}', none: 'Дальше {max}' };

const metro = criterion({
  ...decay,
  id: 'metro',
  title: 'Метро',
  osm: ['node["railway"="subway_entrance"]', 'node["railway"="station"]["station"="subway"]'],
  fact: nearest,
});
const university = criterion({ ...decay, id: 'university', title: 'Вузы', osm: ['nwr["amenity"~"^(university|college)$"]'], fact: nearest });
const pedestrian = criterion({ ...decay, id: 'pedestrian', title: 'Пешеходные улицы', osm: ['way["highway"="pedestrian"]'], geometry: 'line', fact: nearest });
const residential = criterion({
  ...decay,
  id: 'residential',
  title: 'Многоквартирные дома',
  osm: ['way["building"~"^(apartments|residential|dormitory)$"]'],
  weight: { kind: 'area_levels', default_levels: 5 },
  fact: { type: 'count', radius: 400, floors: 9, text: 'Домов в {radius}: {n}, от 9 этажей: {m}' },
});
const industrial = criterion({
  id: 'industrial',
  title: 'Промзоны',
  role: 'penalty',
  model: 'share',
  default_importance: 'medium',
  osm: ['way["landuse"="industrial"]', 'rel["landuse"="industrial"]'],
  exclude_share: 0.5,
  fact: { type: 'share', text: 'Промзона — {pct} % квадрата' },
  min_features: 1,
});
const competitors = criterion({
  id: 'competitors',
  title: 'Кофейни и кафе рядом',
  role: 'penalty',
  model: 'saturation',
  default_importance: 'medium',
  osm: ['nwr["amenity"="cafe"]', 'nwr["shop"="coffee"]'],
  direct: { tags: ['shop=coffee'], name_pattern: 'кофе' },
  saturation: { indirect_weight: 0.5, niche_bonus: 0.5, exclude_ratio: 2 },
  fact: { type: 'competitors', radius: 300, text: 'Кофеен в {radius}: {n}, других кафе: {m}' },
  min_features: 1,
});

/** An Overpass answer as the interpreter sends it. */
const answer = (...elements: object[]) => ({
  version: 0.6,
  generator: 'Overpass API 0.7.62.7 375dc00a',
  osm3s: { timestamp_osm_base: T, copyright: 'The data included in this document is from www.openstreetmap.org.' },
  elements,
});

const at = (lat: number, lon: number) => ({ lat, lon });

describe('overpassQuery', () => {
  it('asks for the centres of the objects of a criterion within the bbox', () => {
    expect(overpassQuery(metro, KAZAN)).toBe(
      '[out:json][timeout:180][bbox:55.6,48.8,55.95,49.4];' +
        '(node["railway"="subway_entrance"];node["railway"="station"]["station"="subway"];);out tags center qt;',
    );
    expect(overpassQuery(competitors, KAZAN)).toBe(
      '[out:json][timeout:180][bbox:55.6,48.8,55.95,49.4];(nwr["amenity"="cafe"];nwr["shop"="coffee"];);out tags center qt;',
    );
  });

  it('pins every layer to one OSM snapshot and takes the timeout from the options', () => {
    expect(overpassQuery(university, KAZAN, { date: T, timeoutSeconds: 60 })).toBe(
      '[out:json][timeout:60][bbox:55.6,48.8,55.95,49.4][date:"2026-09-23T19:28:21Z"];(nwr["amenity"~"^(university|college)$"];);out tags center qt;',
    );
  });

  it('asks for the full geometry of lines, areas and weighted footprints, with relation members', () => {
    // `out tags geom` would print no members of a relation, and so no multipolygon.
    expect(overpassQuery(pedestrian, KAZAN)).toBe('[out:json][timeout:180][bbox:55.6,48.8,55.95,49.4];(way["highway"="pedestrian"];);out geom qt;');
    expect(overpassQuery(industrial, KAZAN, { date: T })).toBe(
      '[out:json][timeout:180][bbox:55.6,48.8,55.95,49.4][date:"2026-09-23T19:28:21Z"];(way["landuse"="industrial"];rel["landuse"="industrial"];);out geom qt;',
    );
    expect(overpassQuery(residential, KAZAN)).toBe(
      '[out:json][timeout:180][bbox:55.6,48.8,55.95,49.4];(way["building"~"^(apartments|residential|dormitory)$"];);out geom qt;',
    );
  });

  it('accepts only an OSM snapshot time as the date and a whole number of seconds as the timeout', () => {
    for (const date of ['2026-09-23', 'yesterday', `${T}"];node;out;("`]) {
      expect(() => overpassQuery(metro, KAZAN, { date }), date).toThrow(RangeError);
    }
    for (const timeoutSeconds of [0, 1.5, -180]) {
      expect(() => overpassQuery(metro, KAZAN, { timeoutSeconds }), String(timeoutSeconds)).toThrow(RangeError);
    }
  });
});

describe('buildingsQuery', () => {
  it('asks for the centres of all buildings, ids only', () => {
    expect(buildingsQuery(KAZAN)).toBe('[out:json][timeout:180][bbox:55.6,48.8,55.95,49.4];way["building"];out ids center qt;');
    expect(buildingsQuery(KAZAN, { date: T, timeoutSeconds: 300 })).toBe(
      '[out:json][timeout:300][bbox:55.6,48.8,55.95,49.4][date:"2026-09-23T19:28:21Z"];way["building"];out ids center qt;',
    );
  });
});

describe('overpassCountQuery', () => {
  it('counts the objects of every selector of a criterion, then of all of them together', () => {
    expect(overpassCountQuery(metro, KAZAN, { date: T })).toBe(
      '[out:json][timeout:180][bbox:55.6,48.8,55.95,49.4][date:"2026-09-23T19:28:21Z"];' +
        'node["railway"="subway_entrance"];out count;node["railway"="station"]["station"="subway"];out count;' +
        '(node["railway"="subway_entrance"];node["railway"="station"]["station"="subway"];);out count;',
    );
  });

  it('counts a single selector once', () => {
    expect(overpassCountQuery(university, KAZAN, { timeoutSeconds: 60 })).toBe(
      '[out:json][timeout:60][bbox:55.6,48.8,55.95,49.4];nwr["amenity"~"^(university|college)$"];out count;',
    );
  });

  it('counts the buildings of the mask', () => {
    expect(buildingsCountQuery(KAZAN, { date: T })).toBe(
      '[out:json][timeout:180][bbox:55.6,48.8,55.95,49.4][date:"2026-09-23T19:28:21Z"];way["building"];out count;',
    );
  });
});

describe('isOsmTime', () => {
  it('accepts a time as Overpass writes it and nothing else', () => {
    expect(isOsmTime(T)).toBe(true);
    for (const text of ['2026-09-23', '2026-09-23T19:28:21.000Z', '2026-09-23T19:28:21+03:00', ` ${T}`, `${T}"];out;`]) {
      expect(isOsmTime(text), text).toBe(false);
    }
  });
});

describe('overpassOsmBase', () => {
  it('reads the time of the OSM data behind an answer', () => {
    expect(overpassOsmBase(answer())).toBe(T);
  });

  it('gives null when an answer has no usable time', () => {
    for (const json of [null, 'text', {}, { osm3s: {} }, { osm3s: { timestamp_osm_base: 'yesterday' } }, { osm3s: { timestamp_osm_base: 42 } }]) {
      expect(overpassOsmBase(json), JSON.stringify(json)).toBeNull();
    }
  });
});

describe('featuresFromOverpass', () => {
  it('turns nodes and the centres of ways and relations into points', () => {
    const json = answer(
      { type: 'node', id: 5273697015, lat: 55.7954108, lon: 49.1058422, tags: { railway: 'subway_entrance', ref: '1' } },
      { type: 'way', id: 25, center: at(55.7907, 49.1215), nodes: [1, 2, 3], tags: { amenity: 'university', name: 'КФУ' } },
      { type: 'relation', id: 7, center: at(55.8, 49.13), tags: { amenity: 'college' } },
    );
    expect(featuresFromOverpass(json, university)).toEqual<OsmFeature[]>([
      { key: 'n5273697015', name: undefined, tags: { railway: 'subway_entrance', ref: '1' }, kind: 'point', lat: 55.7954108, lon: 49.1058422, weight: 1, levels: undefined },
      { key: 'w25', name: 'КФУ', tags: { amenity: 'university', name: 'КФУ' }, kind: 'point', lat: 55.7907, lon: 49.1215, weight: 1, levels: undefined },
      { key: 'r7', name: undefined, tags: { amenity: 'college' }, kind: 'point', lat: 55.8, lon: 49.13, weight: 1, levels: undefined },
    ]);
  });

  it('leaves out an element without a position', () => {
    expect(featuresFromOverpass(answer({ type: 'way', id: 1, tags: { amenity: 'cafe' } }, { type: 'node', id: 2 }), competitors)).toEqual([]);
  });

  it('prefers the Russian name and ignores blank ones', () => {
    const names = (tags: Record<string, string>) => featuresFromOverpass(answer({ type: 'node', id: 1, lat: 55.79, lon: 49.1, tags }), metro)[0]!.name;
    expect(names({ name: 'Kazan Federal University', 'name:ru': 'Казанский федеральный университет' })).toBe('Казанский федеральный университет');
    expect(names({ name: '  Кольцо  ' })).toBe('Кольцо');
    expect(names({ 'name:ru': ' ', name: 'Кольцо' })).toBe('Кольцо');
    expect(names({ name: '   ' })).toBeUndefined();
    expect(names({ 'name:tt': 'Кремль' })).toBeUndefined();
  });

  it('cleans names of control and direction marks, runs of spaces and excess length', () => {
    const names = (tags: Record<string, string>) => featuresFromOverpass(answer({ type: 'node', id: 1, lat: 55.79, lon: 49.1, tags }), metro)[0]!.name;
    expect(names({ name: 'Кофейня\u200e «Утро»\n' })).toBe('Кофейня «Утро»');
    expect(names({ name: '\u202eКольцо\u202c' })).toBe('Кольцо');
    expect(names({ name: 'ТЦ\t\u0007\u2067Кольцо\u2069' })).toBe('ТЦ Кольцо');
    expect(names({ name: '\u061cКольцо' })).toBe('Кольцо');
    expect(names({ 'name:ru': '\u2066\u200f\u2069', name: 'Кольцо' })).toBe('Кольцо');
    expect(names({ name: '\u200f\r\n' })).toBeUndefined();
    // At most 120 characters, cut after a whole word, with an ellipsis.
    expect(names({ name: 'Слово '.repeat(30) })).toBe(`${'Слово '.repeat(20).trim()}…`);
    expect(names({ name: `Кофейня ${'ж'.repeat(150)}` })).toBe('Кофейня…');
    expect(names({ name: 'Ж'.repeat(200) })).toBe(`${'Ж'.repeat(119)}…`);
    expect(names({ name: 'Ж'.repeat(120) })).toBe('Ж'.repeat(120));
  });

  it('removes invisible characters that change no direction, but keeps the joiners', () => {
    const names = (tags: Record<string, string>) => featuresFromOverpass(answer({ type: 'node', id: 1, lat: 55.79, lon: 49.1, tags }), metro)[0]!.name;
    // Zero width space, word joiner, soft hyphen, byte order mark.
    for (const hidden of ['\u200b', '\u2060', '\u00ad', '\ufeff']) {
      expect(names({ name: `Кофе${hidden}шоп` }), hidden.codePointAt(0)!.toString(16)).toBe('Кофешоп');
    }
    expect(names({ name: '\ufeffКофешоп' })).toBe('Кофешоп');
    // Zero width non-joiner and joiner shape letters and emoji: they stay.
    expect(names({ name: 'Кофе\u200cшоп\u200d' })).toBe('Кофе\u200cшоп\u200d');
  });

  it('sorts features by element type, then by numeric id', () => {
    const node = (id: number) => ({ type: 'node', id, lat: 55.79, lon: 49.1 });
    const way = (type: string, id: number) => ({ type, id, center: at(55.79, 49.1) });
    const json = answer(way('way', 10), node(2), way('relation', 1), node(10), way('way', 9));
    expect(featuresFromOverpass(json, university).map((f) => f.key)).toEqual(['n2', 'n10', 'w9', 'w10', 'r1']);
  });

  it('throws on a malformed answer, so the caller can ask again', () => {
    const malformed = [
      null,
      'Error: runtime error',
      {},
      { elements: 'none' },
      { elements: [{ type: 'node', lat: 55.79, lon: 49.1 }] },
      { elements: [{ type: 'area', id: 3600000001 }] },
      { elements: [{ type: 'way', id: 1, geometry: [{ lat: '55.79', lon: 49.1 }] }] },
      { elements: [{ type: 'node', id: 1, lat: 95, lon: 49.1 }] },
    ];
    for (const json of malformed) {
      expect(() => featuresFromOverpass(json, metro), JSON.stringify(json)).toThrow(/malformed Overpass answer/);
    }
  });

  it('keeps the ways of a line criterion as lines', () => {
    const json = answer(
      { type: 'way', id: 386031039, geometry: [at(55.7898, 49.1067), at(55.7924, 49.114), at(55.7956, 49.1167)], tags: { highway: 'pedestrian', name: 'улица Баумана' } },
      { type: 'way', id: 3, geometry: [at(55.78, 49.1)], tags: { highway: 'pedestrian' } },
      { type: 'node', id: 4, lat: 55.78, lon: 49.1, tags: { highway: 'pedestrian' } },
    );
    expect(featuresFromOverpass(json, pedestrian)).toEqual<OsmFeature[]>([
      {
        key: 'w386031039',
        name: 'улица Баумана',
        tags: { highway: 'pedestrian', name: 'улица Баумана' },
        kind: 'line',
        parts: [[at(55.7898, 49.1067), at(55.7924, 49.114), at(55.7956, 49.1167)]],
      },
    ]);
  });

  it('splits a line where Overpass could not resolve a coordinate, rather than cut the corner', () => {
    // Overpass prints null for a node it could not resolve (it happens in queries on a date).
    const [p1, p2, p3, p4] = [at(55.78, 49.1), at(55.781, 49.1), at(55.781, 49.102), at(55.783, 49.102)];
    const way = (id: number, geometry: Array<{ lat: number; lon: number } | null>) => ({ type: 'way', id, geometry, tags: { highway: 'pedestrian' } });
    const json = answer(way(1, [p1, p2, null, p3, p4]), way(2, [p1, null, p2, p3]), way(3, [p1, null, p2]));
    expect(featuresFromOverpass(json, pedestrian).map((f) => (f.kind === 'line' ? [f.key, f.parts] : [f.key]))).toEqual([
      ['w1', [[p1, p2], [p3, p4]]],
      ['w2', [[p2, p3]]], // a lone point is no part of a line
    ]);
  });
});

describe('featuresFromOverpass: areas', () => {
  // A square of four corners and a multipolygon made of two halves of its outline.
  const [a, b, c, d] = [at(55.8, 49.1), at(55.8, 49.11), at(55.81, 49.11), at(55.81, 49.1)];

  it('takes a closed way as an area and leaves out an open one', () => {
    const json = answer(
      { type: 'way', id: 1, geometry: [a, b, c, d, a], tags: { landuse: 'industrial', name: 'Промзона' } },
      { type: 'way', id: 2, geometry: [a, b, c], tags: { landuse: 'industrial' } },
      { type: 'node', id: 3, lat: 55.8, lon: 49.1, tags: { landuse: 'industrial' } },
    );
    expect(featuresFromOverpass(json, industrial)).toEqual<OsmFeature[]>([
      { key: 'w1', name: 'Промзона', tags: { landuse: 'industrial', name: 'Промзона' }, kind: 'area', rings: [[a, b, c, d, a]] },
    ]);
  });

  it('assembles the outer ways of a multipolygon into rings', () => {
    const [g, h, i] = [at(55.82, 49.12), at(55.82, 49.13), at(55.83, 49.12)];
    const way = (role: string, geometry: object[]) => ({ type: 'way', ref: 1, role, geometry });
    const json = answer({
      type: 'relation',
      id: 123,
      bounds: { minlat: 55.8, minlon: 49.1, maxlat: 55.83, maxlon: 49.13 },
      members: [
        way('outer', [a, b, c]),
        way('inner', [at(55.803, 49.103), at(55.803, 49.105), at(55.805, 49.105), at(55.803, 49.103)]),
        { type: 'node', ref: 5, role: 'label', lat: 55.805, lon: 49.105 },
        way('outer', [a, d, c]), // the other half, drawn the other way round
        way('', [g, h, i, g]), // an empty role counts as outer
        way('outer', [at(55.9, 49.2), at(55.91, 49.2)]), // a piece that closes nothing
      ],
      tags: { type: 'multipolygon', landuse: 'industrial' },
    });
    expect(featuresFromOverpass(json, industrial)).toEqual<OsmFeature[]>([
      { key: 'r123', name: undefined, tags: { type: 'multipolygon', landuse: 'industrial' }, kind: 'area', rings: [[a, b, c, d, a], [g, h, i, g]] },
    ]);
  });

  it('leaves out a relation without a closed outer ring', () => {
    const json = answer({ type: 'relation', id: 1, members: [{ type: 'way', ref: 1, role: 'outer', geometry: [a, b, c] }], tags: { type: 'multipolygon' } });
    expect(featuresFromOverpass(json, industrial)).toEqual([]);
  });

  it('assembles only multipolygons, and only from their outer ways', () => {
    const [g, h, i] = [at(55.82, 49.12), at(55.82, 49.13), at(55.83, 49.12)];
    const square = (role: string) => ({ type: 'way', ref: 1, role, geometry: [a, b, c, d, a] });
    const relation = (id: number, tags: Record<string, string>, members: object[]) => ({ type: 'relation', id, members, tags });
    const json = answer(
      // A closed ring as subarea, outline or inner is not the area itself.
      relation(1, { type: 'multipolygon', landuse: 'industrial' }, [square('subarea'), square('outline'), square('inner'), { ...square('outer'), geometry: [g, h, i, g] }]),
      relation(2, { type: 'boundary', landuse: 'industrial' }, [square('outer')]),
      relation(3, { landuse: 'industrial' }, [square('outer')]),
    );
    expect(featuresFromOverpass(json, industrial)).toEqual<OsmFeature[]>([
      { key: 'r1', name: undefined, tags: { type: 'multipolygon', landuse: 'industrial' }, kind: 'area', rings: [[g, h, i, g]] },
    ]);
  });
});

describe('featuresFromOverpass: weighted footprints', () => {
  /** A rectangle of 0.0002° of latitude by 0.0004° of longitude, closed. */
  const rectangle = (south: number, west: number) => [
    at(south, west),
    at(south, west + 0.0004),
    at(south + 0.0002, west + 0.0004),
    at(south + 0.0002, west),
    at(south, west),
  ];
  const { mPerDegLat, mPerDegLon } = metresPerDegree(55.7901);
  const AREA = 0.0002 * mPerDegLat * 0.0004 * mPerDegLon; // ≈ 559 m²
  const house = (id: number, tags: Record<string, string>, geometry: object[] = rectangle(55.79, 49.1)) => ({ type: 'way', id, geometry, tags });
  const point = (feature: OsmFeature | undefined) => {
    if (feature?.kind !== 'point') throw new Error('expected a point');
    return feature;
  };

  it('weighs a building by its footprint area times its floors, placed at its centre', () => {
    const [nine] = featuresFromOverpass(answer(house(1, { building: 'apartments', 'building:levels': '9' })), residential);
    expect(point(nine).weight / (AREA * 9)).toBeCloseTo(1, 4);
    expect(point(nine)).toMatchObject({ key: 'w1', levels: 9 });
    expect(point(nine).lat).toBeCloseTo(55.7901, 9);
    expect(point(nine).lon).toBeCloseTo(49.1002, 9);
  });

  it('reads building:levels of up to three digits from 1 to 150 floors, otherwise takes the default', () => {
    const values = [undefined, '9', '9.5', '150', '1', '1e308', '99999', '1e3', '0x10', '151', '0.5', '0', ' 9', '9;12', 'many'];
    const json = answer(
      ...values.map((levels, i) => house(i + 1, levels === undefined ? { building: 'apartments' } : { building: 'apartments', 'building:levels': levels })),
    );
    const features = featuresFromOverpass(json, residential).map(point);
    expect(features.map((f) => f.levels)).toEqual([undefined, 9, 9.5, 150, 1, ...new Array<undefined>(10).fill(undefined)]);
    for (const feature of features) {
      expect(feature.weight / (AREA * (feature.levels ?? 5)), feature.key).toBeCloseTo(1, 4);
    }
  });

  it('places a footprint at the centroid of its area, not at the mean of its corners', () => {
    // Extra corners along the southern edge pull the mean south; the area stays a rectangle.
    const [south, west] = [55.79, 49.1];
    const crowded = [at(south, west), at(south, west + 0.0001), at(south, west + 0.0002), at(south, west + 0.0003), ...rectangle(south, west).slice(1)];
    const [feature] = featuresFromOverpass(answer(house(1, { building: 'residential' }, crowded)), residential);
    expect(point(feature).lat).toBeCloseTo(55.7901, 9);
    expect(point(feature).weight / (AREA * 5)).toBeCloseTo(1, 4);
  });

  it('assembles a multipolygon building and leaves out what has no footprint', () => {
    const [a, b, c, d] = rectangle(55.79, 49.1);
    const json = answer(
      {
        type: 'relation',
        id: 9,
        members: [
          { type: 'way', ref: 1, role: 'outer', geometry: [a, b, c] },
          { type: 'way', ref: 2, role: 'outer', geometry: [c, d, a] },
        ],
        tags: { type: 'multipolygon', building: 'dormitory', 'building:levels': '4' },
      },
      { type: 'node', id: 1, lat: 55.79, lon: 49.1, tags: { building: 'apartments' } },
      house(2, { building: 'apartments' }, rectangle(55.79, 49.1).slice(0, 4)),
    );
    const features = featuresFromOverpass(json, residential);
    expect(features.map((f) => f.key)).toEqual(['r9']);
    expect(point(features[0]).weight / (AREA * 4)).toBeCloseTo(1, 4);
    expect(point(features[0]).lon).toBeCloseTo(49.1002, 9);
  });
});

describe('buildingCentres', () => {
  it('takes the centres of ways and the positions of nodes', () => {
    const json = answer(
      { type: 'way', id: 1, center: at(55.79, 49.1) },
      { type: 'way', id: 2 },
      { type: 'node', id: 3, lat: 55.78, lon: 49.2 },
      { type: 'relation', id: 4, center: at(55.8, 49.3) },
    );
    expect(buildingCentres(json)).toEqual([at(55.79, 49.1), at(55.78, 49.2), at(55.8, 49.3)]);
  });

  it('throws on a malformed answer', () => {
    expect(() => buildingCentres({ elements: [{ type: 'way', id: 1, center: { lat: 55.79 } }] })).toThrow(/malformed Overpass answer/);
  });
});
