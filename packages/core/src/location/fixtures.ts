import type { LocationIndex } from './schema.js';

/**
 * A valid snapshot of 4 × 4 cells, 8 of them in the index, for tests of the core and the mini-app.
 * Deeply frozen: take a structuredClone before changing it.
 *
 * The geometry is consistent, so the fixture can be drawn on a map: the grid is
 * gridFor({ south: 55.786, west: 49.0965, north: 55.7967, east: 49.1155 }, 300), the station stands on the
 * border of cells 6 and 7 (close to the real Кремлёвская), `dist` is the distance from a cell centre to the
 * nearest metro object, and a metro level is 100 × decay(dist) (cap 1, linear norm with P95 = 1). The metro
 * has one more object, not a place: an entrance without a name at 55.7963, 49.1154 (made up, 594 m from the
 * station, too far to take its name), the nearest object of cell 3 (near = −2). Offices, cafes and industrial
 * zones are made up, chosen so that the defaults give a clear order: a niche bonus, a saturated twin,
 * a tie, a cell that relies on the metro only. Templates use plain spaces, as a YAML author would type them.
 *
 *   cell  (row, col)  metro                   office  industrial  cafes n/m   note
 *   0     (0, 0)        0  over 1 km               0        60        0/0        industrial wasteland
 *   1     (0, 1)        0  912 m                 100         0        1/0        offices, twin of 2
 *   2     (0, 2)        0  912 m                 100         0        1/0        offices, twin of 1
 *   3     (1, 3)        0  710 m, entrance        20        10        0/1        weak demand
 *   4     (2, 1)       66  335 m                  34         0        0/0        niche: no cafes where demand is usual
 *   5     (2, 2)       66  335 m                  34         0        3/4        saturated: many cafes for its demand
 *   6     (3, 1)      100  150 m                  80         0        2/3        the best: metro and offices
 *   7     (3, 2)      100  150 m                  20         0        1/2        relies on the metro
 */
export const tinyLocationIndex: LocationIndex = deepFreeze({
  format: 'otkryvay.location-index/1',
  pack: 'kazan-coffee',
  version: '20260923T192821Z-3f9a1c2b',
  title: 'Где открыть кофейню в Казани',
  disclaimer: 'Модельная оценка по открытым данным OpenStreetMap. Тестовый снимок: 8 квадратов в центре Казани.',
  dataStatus: 'prepared_snapshot',
  linkedActions: ['lease-premises'],
  top: { size: 20, minSpacingCells: 2 },
  source: {
    name: 'OpenStreetMap',
    licence: 'ODbL-1.0',
    licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    attribution: '© участники OpenStreetMap',
    attributionUrl: 'https://www.openstreetmap.org/copyright',
    osmBase: '2026-09-23T19:28:21Z',
    extractedAt: '2026-09-23T19:41:07Z',
    endpoint: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    method: 'https://github.com/trade-stasvinokur/student_hackathon_max_2026/tree/main/apps/api/src/scripts/location-index',
    configSha256: '3f9a1c2b5d7e4f60a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718',
  },
  grid: { origin: { lat: 55.786, lon: 49.0965 }, cellMeters: 300, rows: 4, cols: 4, mPerDegLat: 111_338, mPerDegLon: 62_728 },
  criteria: [
    {
      id: 'metro',
      title: 'Метро',
      role: 'demand',
      model: 'decay',
      defaultImportance: 'high',
      osm: ['node["railway"="subway_entrance"]', 'node["railway"="station"]["station"="subway"]'],
      decay: { full: 150, zero: 700 },
      cap: 1,
      norm: { kind: 'linear', p50: 0.83, p95: 1 },
      fact: { type: 'nearest', max: 1000, text: 'Метро «{name}» — {dist}', unnamed: 'Вход в метро — {dist}', none: 'Метро дальше {max}' },
      titleAnchor: { priority: 1, within: 700, text: 'У метро «{name}»' },
      featureCount: 2,
    },
    {
      id: 'office',
      title: 'Офисы и бизнес-центры',
      role: 'demand',
      model: 'decay',
      defaultImportance: 'high',
      osm: ['nwr["office"]', 'way["building"="office"]'],
      decay: { full: 150, zero: 500 },
      cap: 40,
      norm: { kind: 'log', p50: 2.5, p95: 14 },
      fact: { type: 'count', radius: 400, text: 'Офисов и бизнес-центров в {radius}: {n}', none: 'Офисов в {radius} нет' },
      featureCount: 42,
    },
    {
      id: 'competitors',
      title: 'Кофейни и кафе рядом',
      role: 'penalty',
      model: 'saturation',
      defaultImportance: 'medium',
      osm: ['nwr["amenity"="cafe"]', 'nwr["shop"="coffee"]'],
      direct: { tags: ['cuisine~coffee_shop', 'shop=coffee'], namePattern: '(кофе|кофейн|coffee|espresso|эспрессо)' },
      saturation: { indirectWeight: 0.5, nicheBonus: 0.5, excludeRatio: 2, saturatedRatio: 1.5, nicheRatio: 0.5 },
      fact: { type: 'competitors', radius: 300, text: 'Кофеен в {radius}: {n}, других кафе: {m}', none: 'Кофеен и кафе в {radius} нет' },
      featureCount: 17,
    },
    {
      id: 'industrial',
      title: 'Промзоны',
      role: 'penalty',
      model: 'share',
      defaultImportance: 'medium',
      osm: ['way["landuse"="industrial"]', 'rel["landuse"="industrial"]'],
      norm: { kind: 'share', p50: 0.35, p95: 0.6 },
      excludeShare: 0.5,
      fact: { type: 'share', text: 'Промзона — {pct} % квадрата', none: 'Промзон нет' },
      featureCount: 2,
    },
  ],
  places: [[0, 'Кремлёвская', 55.795431, 49.106065]],
  cells: {
    row: [0, 0, 0, 1, 2, 2, 3, 3],
    col: [0, 1, 2, 3, 1, 2, 1, 2],
    level: {
      metro: [0, 0, 0, 0, 66, 66, 100, 100],
      office: [0, 100, 100, 20, 34, 34, 80, 20],
      industrial: [60, 0, 0, 10, 0, 0, 0, 0],
    },
    fact: {
      metro: { near: [-1, 0, 0, -2, 0, 0, 0, 0], dist: [0, 912, 912, 710, 335, 335, 150, 150] },
      office: { n: [0, 18, 18, 2, 5, 5, 12, 2] },
      competitors: { n: [0, 1, 1, 0, 0, 3, 2, 1], m: [0, 0, 0, 1, 0, 4, 3, 2] },
    },
  },
});

/** Freezes an object and everything it holds. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
