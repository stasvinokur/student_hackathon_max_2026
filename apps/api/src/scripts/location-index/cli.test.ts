import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gridFor, parseLocationIndex, type LatLon } from '@otkryvay/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadRulesPack } from '../../shell/content/load.js';
import { METHOD_URL, PROBE_QUERY, runLocationIndexCli, type CliDeps } from './cli.js';
import { serializeLocationIndex } from './content.js';
import { cacheKey } from './overpass.js';

// The pipeline end to end on a city of 5 × 5 cells, with a fake network: the probe, three layers, the mask.

const T = '2026-09-23T19:28:21Z';
const NOW = Date.parse('2026-09-24T10:00:00Z');
const LATER = Date.parse('2026-09-24T15:30:00Z');
const LATEST = Date.parse('2026-09-24T18:00:00Z');
const A = 'https://a.example.org/api/interpreter';
const B = 'https://b.example.org/api/interpreter';
const BBOX = { south: 55.78, west: 49.1, north: 55.7934, east: 49.1238 };
const GRID = gridFor(BBOX, 300);

/** A point x metres east and y metres north of the south-west corner of the city. */
const at = (x: number, y: number): LatLon => ({ lat: BBOX.south + y / GRID.mPerDegLat, lon: BBOX.west + x / GRID.mPerDegLon });
/** The centre of a cell. */
const centre = (row: number, col: number) => at((col + 0.5) * 300, (row + 0.5) * 300);

const PACK_YAML = `
manifest:
  id: tiny-city
  version: 1.0.0
  title: Кофейня, маленький город
  region: { code: tiny, name: Маленький город, bbox: { south: ${BBOX.south}, west: ${BBOX.west}, north: ${BBOX.north}, east: ${BBOX.east} } }
  industry: coffee
  checked_at: 2026-09-18
  cities: [tiny]
actions:
  - id: lease-premises
    title: Найти помещение
    lane: support
    duration_days: 30
    why: Нужно помещение
    do_now: Посмотреть карту
    done_when: Договор подписан
    kind: recommendation
`;

const CRITERIA_YAML = `
format: otkryvay.location-criteria/1
title: Где открыть кофейню
disclaimer: Модельная оценка по открытым данным OpenStreetMap.
linked_actions: [lease-premises]
grid: { cell_meters: 300, min_buildings: 2, min_features: 6 }
top: { size: 3, min_spacing_cells: 1 }
criteria:
  - id: metro
    title: Метро
    role: demand
    model: decay
    default_importance: high
    osm: ['node["railway"="subway_entrance"]', 'node["railway"="station"]["station"="subway"]']
    decay: { full: 150, zero: 700 }
    cap: 1
    norm: linear
    borrow_name_within: 400
    fact: { type: nearest, max: 1000, text: 'Метро «{name}» — {dist}', unnamed: 'Вход в метро — {dist}', none: 'Метро дальше {max}' }
    title_anchor: { priority: 1, within: 700, text: 'У метро «{name}»' }
    min_features: 2
  - id: competitors
    title: Кофейни и кафе рядом
    role: penalty
    model: saturation
    default_importance: medium
    osm: ['nwr["amenity"="cafe"]', 'nwr["shop"="coffee"]']
    direct: { tags: ['cuisine~coffee_shop', 'shop=coffee'], name_pattern: '(кофе|coffee)' }
    saturation: { indirect_weight: 0.5, niche_bonus: 0.5, exclude_ratio: 2, saturated_ratio: 1.5, niche_ratio: 0.5 }
    fact: { type: competitors, radius: 300, text: 'Кофеен в {radius}: {n}, других кафе: {m}', none: 'Кофеен и кафе в {radius} нет' }
    min_features: 2
  - id: industrial
    title: Промзоны
    role: penalty
    model: share
    default_importance: medium
    osm: ['way["landuse"="industrial"]', 'rel["landuse"="industrial"]']
    exclude_share: 0.5
    fact: { type: share, text: 'Промзона — {pct} % территории', none: 'Промзон нет' }
    min_features: 1
`;

const FIXTURES_YAML = `
pack: tiny-city
points:
  - id: station
    title: Станция
    note: Станция в центре квадрата (2, 2).
    lat: ${centre(2, 2).lat}
    lon: ${centre(2, 2).lon}
    expect:
      included: true
      level: { metro: 100 }
      fact: { metro: 'Метро «Центральная»' }
      title: 'У метро «Центральная»'
      top_within_cells: 1
  - id: field
    title: Поле
    note: Ни зданий, ни метро.
    lat: ${centre(4, 0).lat}
    lon: ${centre(4, 0).lon}
    expect:
      included: false
`;

const answer = (elements: object[]) => JSON.stringify({ version: 0.6, generator: 'Overpass API', osm3s: { timestamp_osm_base: T }, elements });
const node = (id: number, where: LatLon, tags: Record<string, string>) => ({ type: 'node', id, lat: where.lat, lon: where.lon, tags });

const ANSWERS = {
  probe: answer([]),
  metro: answer([
    node(1, centre(2, 2), { railway: 'station', station: 'subway', name: 'Центральная' }),
    node(2, at(750, 700), { railway: 'subway_entrance' }),
  ]),
  competitors: answer([
    node(10, centre(2, 2), { amenity: 'cafe', name: 'Кофейня «Утро»' }),
    node(11, centre(2, 3), { amenity: 'cafe', name: 'Чайхана' }),
    { type: 'way', id: 12, center: centre(1, 1), tags: { shop: 'coffee' } },
  ]),
  industrial: answer([
    {
      type: 'way',
      id: 30,
      tags: { landuse: 'industrial' },
      geometry: [at(0, 0), at(600, 0), at(600, 300), at(0, 300), at(0, 0)],
    },
  ]),
  buildings: answer(
    [
      [0, 0],
      [1, 1],
      [2, 2],
      [2, 3],
      [3, 2],
    ].flatMap(([row, col], k) => [0, 1].map((i) => ({ type: 'way', id: 100 + 2 * k + i, center: centre(row!, col!) }))),
  ),
};

/** The answer of the fake network to a query. */
function answerTo(query: string): string {
  if (query === PROBE_QUERY) return ANSWERS.probe;
  if (query.includes('out count')) {
    const statements = query.split('out count;').length - 1;
    const count = { type: 'count', id: 0, tags: { nodes: '2', ways: '1', relations: '0', areas: '0', total: '3' } };
    return answer(Array.from({ length: statements }, () => count));
  }
  if (query.includes('"railway"')) return ANSWERS.metro;
  if (query.includes('"amenity"="cafe"')) return ANSWERS.competitors;
  if (query.includes('"landuse"')) return ANSWERS.industrial;
  if (query.includes('way["building"];out ids center')) return ANSWERS.buildings;
  throw new Error(`no answer to ${query}`);
}

let root: string;
let contentDir: string;
let cacheDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'otkryvay-location-index-'));
  contentDir = join(root, 'content');
  cacheDir = join(root, 'cache');
  await mkdir(join(contentDir, 'tiny-city'), { recursive: true });
  await writeFile(join(contentDir, 'tiny-city', 'pack.yaml'), PACK_YAML);
  await writeFile(join(contentDir, 'tiny-city', 'location-criteria.yaml'), CRITERIA_YAML);
  await writeFile(join(contentDir, 'tiny-city', 'location-fixtures.yaml'), FIXTURES_YAML);
});

interface Run {
  code: number;
  queries: string[];
  urls: string[];
  out: string[];
  log: string[];
}

interface RunOptions {
  /** false: any request fails the test. */
  online?: boolean;
  env?: Record<string, string>;
  answer?: (query: string, url: string) => string;
  /** The clock of the run: NOW by default. */
  now?: number;
}

async function run(args: string[], options: RunOptions = {}): Promise<Run> {
  const result: Run = { code: -1, queries: [], urls: [], out: [], log: [] };
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (options.online === false) throw new Error('the network must not be touched');
    const query = new URLSearchParams(String(init?.body)).get('data') ?? '';
    result.urls.push(String(url));
    result.queries.push(query);
    return new Response((options.answer ?? answerTo)(query, String(url)), { status: 200 });
  };
  const deps: CliDeps = {
    env: { OVERPASS_URLS: `${A},${B}`, ...options.env },
    cwd: root,
    contentDir,
    fetch: fetch as typeof globalThis.fetch,
    sleep: async () => {},
    now: () => options.now ?? NOW,
    random: () => 0.5,
    out: (line) => result.out.push(line),
    log: (line) => result.log.push(line),
  };
  result.code = await runLocationIndexCli(args, deps);
  return result;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const PACK_SNAPSHOT = () => join(contentDir, 'tiny-city', 'location-index.json');
/** No file is left half-written anywhere. */
async function partials(): Promise<string[]> {
  const files = [...(await readdir(root, { recursive: true }))].map(String);
  return files.filter((file) => file.includes('.partial'));
}

describe('location-index CLI', () => {
  it('builds a valid snapshot: the probe first, then every layer and the mask at its date within the bbox', async () => {
    const got = await run(['--pack', 'tiny-city', '--cache-dir', 'cache', '--out', 'snapshot.json']);
    expect(got.log.filter((line) => line.startsWith('location-index'))).toEqual([]);
    expect(got.code).toBe(0);

    expect(got.queries[0]).toBe(PROBE_QUERY);
    expect(got.queries).toHaveLength(5);
    for (const query of got.queries.slice(1)) {
      expect(query).toContain(`[bbox:${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}]`);
      expect(query).toContain(`[date:"${T}"]`);
      expect(query).toContain('[timeout:180]');
    }
    expect(got.queries.at(-1)).toContain('way["building"];out ids center qt;');
    expect(new Set(got.urls)).toEqual(new Set([A]));

    const text = await readFile(join(root, 'snapshot.json'), 'utf8');
    const parsed = parseLocationIndex(JSON.parse(text), await loadRulesPack('tiny-city', contentDir));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const ix = parsed.value;
    expect(ix.source).toMatchObject({
      licence: 'ODbL-1.0',
      osmBase: T,
      extractedAt: '2026-09-24T10:00:00Z',
      endpoint: A,
      method: METHOD_URL,
      configSha256: sha256(CRITERIA_YAML),
    });
    expect(ix.version).toBe(`20260923T192821Z-${sha256(CRITERIA_YAML).slice(0, 8)}`);
    // Cells with two buildings, and (2, 2) with the station.
    expect(ix.cells.row.map((row, i) => [row, ix.cells.col[i]])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [2, 3],
      [3, 2],
    ]);
    // The station and its entrance, which borrowed the name of the station: each is a place of its own.
    expect(ix.places.map((place) => place[1])).toEqual(['Центральная', 'Центральная']);
    expect(ix.criteria.map((c) => [c.id, c.featureCount])).toEqual([
      ['metro', 2],
      ['competitors', 3],
      ['industrial', 1],
    ]);
    // The file is exactly what the writer makes of its content: one key per line, a column per line.
    expect(serializeLocationIndex(JSON.parse(text) as typeof ix)).toBe(text);
    expect(text).toMatch(/\n {4}"row": \[0,1,2,2,3\],\n/);

    // The report: layers, cells, reference points, the size.
    const report = got.out.join('\n');
    expect(report).toContain(`location index of pack tiny-city: OSM ${T} from ${A}`);
    expect(report).toContain('cells: 5 in the index of 25 (5 × 5 of 300 m)');
    expect(report).toContain('reference points: 2 of 2 pass');
    expect(report).toMatch(/snapshot: snapshot\.json, [\d.]+ KB \([\d.]+ KB gzip\), 2 places/);
    expect(report).toMatch(/^metro .* a\.example\.org$/m);
    expect(report).toContain('buildings: 10 centres from a.example.org');
    expect(await partials()).toEqual([]);
  });

  it('rebuilds the same snapshot offline from the cache, byte for byte, hours later', async () => {
    const online = await run(['--pack', 'tiny-city', '--cache-dir', 'cache', '--out', 'online.json']);
    expect(online.code).toBe(0);
    // Raw answers by the sha256 of their query without the timeout, and the probe record of T apart from them.
    const files = (await readdir(cacheDir)).sort();
    expect(files).toHaveLength(5);
    for (const query of online.queries.slice(1)) expect(files).toContain(`${cacheKey(query)}.json`);
    expect(JSON.parse(await readFile(join(cacheDir, 'probe-20260923T192821Z.json'), 'utf8'))).toEqual({
      osmBase: T,
      endpoint: A,
      extractedAt: '2026-09-24T10:00:00Z',
      layers: { metro: A, competitors: A, industrial: A },
      buildings: { endpoint: A, count: 10 },
    });

    const offline = await run(['--pack', 'tiny-city', '--offline', '--date', T, '--cache-dir', 'cache', '--out', 'offline.json'], {
      online: false,
      now: LATER,
    });
    expect(offline.log.filter((line) => line.startsWith('location-index'))).toEqual([]);
    expect(offline.code).toBe(0);
    // extractedAt is the time of the online probe, not of the rebuild.
    expect(await readFile(join(root, 'offline.json'), 'utf8')).toBe(await readFile(join(root, 'online.json'), 'utf8'));
    expect(offline.out.join('\n')).toContain('requests: 0 to Overpass, 4 from the cache');
    expect(offline.out.join('\n')).toMatch(/^industrial .* a\.example\.org$/m);
  });

  it('keeps the time and the mirror of the probe that fetched the data while a rerun downloads nothing', async () => {
    expect((await run(['--pack', 'tiny-city', '--cache-dir', 'cache', '--out', 'first.json'])).code).toBe(0);
    const recordPath = join(cacheDir, 'probe-20260923T192821Z.json');
    const first = await readFile(recordPath, 'utf8');

    // Hours later B answers the probe, and every answer is in the cache: nothing is fetched, nothing changes.
    const againArgs = ['--pack', 'tiny-city', '--date', T, '--cache-dir', 'cache', '--out', 'again.json'];
    const again = await run(againArgs, { now: LATER, env: { OVERPASS_URLS: `${B},${A}` } });
    expect(again.code).toBe(0);
    expect(again.queries).toEqual([PROBE_QUERY]);
    expect(await readFile(recordPath, 'utf8')).toBe(first);
    expect(await readFile(join(root, 'again.json'), 'utf8')).toBe(await readFile(join(root, 'first.json'), 'utf8'));

    // A rerun that fetches a layer is the one that fetched the data: its probe gives the time and the mirror.
    for (const file of await readdir(cacheDir)) {
      if ((await readFile(join(cacheDir, file), 'utf8')).includes('"landuse"')) await rm(join(cacheDir, file));
    }
    const fetched = await run(['--pack', 'tiny-city', '--date', T, '--cache-dir', 'cache', '--out', 'fetched.json'], {
      now: LATEST,
      env: { OVERPASS_URLS: `${B},${A}` },
    });
    expect(fetched.code).toBe(0);
    expect(fetched.urls).toEqual([B, B]);
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual({
      osmBase: T,
      endpoint: B,
      extractedAt: '2026-09-24T18:00:00Z',
      layers: { metro: A, competitors: A, industrial: B },
      buildings: { endpoint: A, count: 10 },
    });
    const source = (JSON.parse(await readFile(join(root, 'fetched.json'), 'utf8')) as { source: object }).source;
    expect(source).toMatchObject({ endpoint: B, extractedAt: '2026-09-24T18:00:00Z' });
  });

  it('offline, says clearly what is wrong with the probe record of T', async () => {
    const offline = (date = T) => run(['--pack', 'tiny-city', '--offline', '--date', date, '--cache-dir', 'cache', '--out', 'x.json'], { online: false });
    const record = join(cacheDir, 'probe-20260923T192821Z.json');
    const errors = async () => (await offline()).log.filter((line) => line.startsWith('location-index:')).join('\n');

    expect(await errors()).toContain(`offline, and no probe record of ${T} (${record}): run once online with --date ${T}`);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(record, '{"osmBase": "2026-');
    expect(await errors()).toMatch(new RegExp(`the probe record ${record.replace(/[.\\/]/g, '\\$&')} is not JSON: `));
    await writeFile(record, JSON.stringify({ osmBase: T, endpoint: A }));
    expect(await errors()).toContain(`the probe record ${record} is damaged or was written by an older version of the script`);
    expect(await errors()).toContain('extractedAt');
    await rm(record);
    await mkdir(record); // a directory where the record should be: not missing, unreadable
    expect(await errors()).toContain(`cannot read the probe record ${record}: EISDIR`);
  });

  it('with --date, asks the probe only which mirror is up and pins every layer to that date', async () => {
    const date = '2026-09-20T00:00:00Z';
    const got = await run(['--pack', 'tiny-city', '--date', date, '--cache-dir', 'cache', '--out', 'snapshot.json']);
    expect(got.code).toBe(0);
    expect(got.queries[0]).toBe(PROBE_QUERY);
    for (const query of got.queries.slice(1)) expect(query).toContain(`[date:"${date}"]`);
    const ix = JSON.parse(await readFile(join(root, 'snapshot.json'), 'utf8')) as { source: { osmBase: string } };
    expect(ix.source.osmBase).toBe(date);
  });

  it('offline, names the query whose answer is not cached', async () => {
    await run(['--pack', 'tiny-city', '--cache-dir', 'cache', '--out', 'snapshot.json']);
    const criteria = CRITERIA_YAML.replace("'nwr[\"shop\"=\"coffee\"]'", "'nwr[\"shop\"=\"coffee\"]', 'nwr[\"cuisine\"=\"coffee_shop\"]'");
    await writeFile(join(contentDir, 'tiny-city', 'location-criteria.yaml'), criteria);
    const got = await run(['--pack', 'tiny-city', '--offline', '--date', T, '--cache-dir', 'cache', '--out', 'offline.json'], { online: false });
    expect(got.code).toBe(1);
    expect(got.log.join('\n')).toContain('location-index: competitors: offline, and no cached answer');
    expect(got.log.join('\n')).toContain('nwr["cuisine"="coffee_shop"];);out tags center qt;');
  });

  it('fails on suspiciously little data after asking every mirror once, and says how to go on', async () => {
    const sparse = (query: string) => (query.includes('"railway"') ? answer([]) : answerTo(query));
    const got = await run(['--pack', 'tiny-city', '--cache-dir', 'cache', '--out', 'snapshot.json'], { answer: sparse });
    expect(got.code).toBe(1);
    expect(got.queries.filter((query) => query.includes('"railway"'))).toHaveLength(2); // a dated answer does not change: once per mirror
    expect(got.log.join('\n')).toContain('suspiciously little data: metro has 0 OSM objects, min_features is 2');
    expect(got.log.at(-1)).toBe(`hint: the answers of T=${T} fetched so far are cached: rerun with --date ${T}`);
    await expect(readFile(join(root, 'snapshot.json'), 'utf8')).rejects.toThrow();
  });

  it('fails on a built-up mask with fewer buildings than grid.min_features', async () => {
    await writeFile(join(contentDir, 'tiny-city', 'location-criteria.yaml'), CRITERIA_YAML.replace('min_features: 6 }', 'min_features: 11 }'));
    const got = await run(['--pack', 'tiny-city', '--cache-dir', 'cache', '--out', 'snapshot.json']);
    expect(got.code).toBe(1);
    expect(got.queries.filter((query) => query.includes('way["building"]'))).toHaveLength(2);
    expect(got.log.join('\n')).toContain('suspiciously little data: the built-up mask has 10 buildings, grid.min_features is 11');
  });

  it('takes every layer from one slice of OSM: a mirror with older data is passed over', async () => {
    const behind = answer([]).replace(T, '2026-09-23T00:00:00Z');
    const lagging = (query: string, url: string) => (url === B && query !== PROBE_QUERY ? behind : answerTo(query));
    const got = await run(['--pack', 'tiny-city', '--cache-dir', 'cache', '--out', 'snapshot.json'], {
      answer: lagging,
      env: { OVERPASS_URLS: `${B},${A}` },
    });
    expect(got.code).toBe(0);
    // The probe on B; B is behind T for metro and is passed over at once, without retries: A from then on.
    expect(got.urls).toEqual([B, B, A, A, A, A]);
    expect(got.log.join('\n')).toContain('the mirror has data up to 2026-09-23T00:00:00Z only, older than 2026-09-23T19:28:21Z');
  });

  it('leaves the snapshot of the pack alone when a reference point fails, and puts the result into the cache', async () => {
    expect((await run(['--pack', 'tiny-city', '--cache-dir', 'cache'])).code).toBe(0);
    const committed = await readFile(PACK_SNAPSHOT(), 'utf8');
    await writeFile(join(contentDir, 'tiny-city', 'location-fixtures.yaml'), FIXTURES_YAML.replace('level: { metro: 100 }', 'level: { metro: { max: 50 } }'));

    const got = await run(['--pack', 'tiny-city', '--cache-dir', 'cache'], { now: LATER });
    expect(got.code).toBe(1);
    expect(await readFile(PACK_SNAPSHOT(), 'utf8')).toBe(committed);
    const failed = join(cacheDir, 'tiny-city.location-index.failed.json');
    expect(await readFile(failed, 'utf8')).toContain('"format": "otkryvay.location-index/1"');
    expect(got.out.join('\n')).toContain(
      `snapshot NOT written to ${join('content', 'tiny-city', 'location-index.json')}: 1 reference point failed; the result is in ${join('cache', 'tiny-city.location-index.failed.json')}`,
    );
    expect(got.log.join('\n')).toContain('1 reference point failed');
    expect(await partials()).toEqual([]);
  });

  it('writes the snapshot but fails when a reference point does not pass', async () => {
    const fixtures = FIXTURES_YAML.replace('level: { metro: 100 }', 'level: { metro: { max: 50 } }');
    await writeFile(join(contentDir, 'tiny-city', 'location-fixtures.yaml'), fixtures);
    const got = await run(['--pack', 'tiny-city', '--cache-dir', 'cache', '--out', 'snapshot.json']);
    expect(got.code).toBe(1);
    expect(got.out.join('\n')).toContain('reference points: 1 of 2 pass');
    expect(got.out.join('\n')).toContain('level of "metro" is 100, expected at most 50');
    expect(got.log.join('\n')).toContain('1 reference point failed');
    await expect(readFile(join(root, 'snapshot.json'), 'utf8')).resolves.toContain('"format": "otkryvay.location-index/1"');
  });

  it('warns about big drops against the snapshot of the pack, without failing', async () => {
    expect((await run(['--pack', 'tiny-city', '--cache-dir', 'cache'])).code).toBe(0);
    // Another slice, with a cafe and four buildings fewer: cells (0, 0) and (1, 1) lose their buildings.
    const other = '2026-09-23T12:00:00Z';
    const fewer = (query: string) => {
      const elements = (text: string) => (JSON.parse(text) as { elements: Array<{ id: number }> }).elements;
      if (query.includes('"amenity"="cafe"')) return answer(elements(ANSWERS.competitors).filter((element) => element.id !== 12));
      if (query.includes('way["building"];out ids center')) return answer(elements(ANSWERS.buildings).slice(4));
      return answerTo(query);
    };
    const got = await run(['--pack', 'tiny-city', '--date', other, '--cache-dir', 'cache'], { answer: fewer, now: LATER });
    expect(got.code).toBe(0);
    const report = got.out.join('\n');
    expect(report).toContain(`WARNING: much fewer objects than in the snapshot of the pack (OSM ${T}):`);
    expect(report).toContain('  competitors: 3 → 2 (−33 %)');
    expect(report).toContain('  cells: 5 → 3 (−40 %)');
    expect(report).toContain('  buildings: 10 → 6 (−40 %)');
    expect(report).not.toContain('  metro:');
    expect(got.log.join('\n')).toContain('WARNING: much fewer objects than in the snapshot of the pack');
  });

  it('refuses an implausible time of the data', async () => {
    for (const date of ['2009-12-31T23:59:59Z', '2026-09-24T11:00:01Z', '2026-02-30T00:00:00Z']) {
      const got = await run(['--pack', 'tiny-city', '--date', date], { online: false });
      expect(got.code, date).toBe(2);
      expect(got.log.join('\n'), date).toContain(`--date ${date} is implausible`);
    }
    // A mirror telling such a time is passed over.
    const future = (query: string, url: string) => (url === A && query === PROBE_QUERY ? answer([]).replace(T, '2030-01-01T00:00:00Z') : answerTo(query));
    const got = await run(['--pack', 'tiny-city', '--cache-dir', 'cache', '--out', 'snapshot.json'], { answer: future });
    expect(got.code).toBe(0);
    expect(got.log.join('\n')).toContain('2030-01-01T00:00:00Z is implausible');
    expect(got.urls.slice(0, 2)).toEqual([A, B]);
  });

  it('prints the snapshot path from the directory it was started in, or whole when outside it', async () => {
    const elsewhere = join(await mkdtemp(join(tmpdir(), 'otkryvay-elsewhere-')), 'x.json');
    const got = await run(['--pack', 'tiny-city', '--cache-dir', 'cache', '--out', elsewhere]);
    expect(got.code).toBe(0);
    expect(got.out.join('\n')).toContain(`snapshot: ${elsewhere}, `);
  });

  it('--counts asks out count for every selector and layer, and the buildings', async () => {
    const got = await run(['--pack', 'tiny-city', '--counts', '--cache-dir', 'cache']);
    expect(got.code).toBe(0);
    expect(got.queries.slice(1)).toEqual([
      `[out:json][timeout:180][bbox:55.78,49.1,55.7934,49.1238][date:"${T}"];node["railway"="subway_entrance"];out count;node["railway"="station"]["station"="subway"];out count;(node["railway"="subway_entrance"];node["railway"="station"]["station"="subway"];);out count;`,
      `[out:json][timeout:180][bbox:55.78,49.1,55.7934,49.1238][date:"${T}"];nwr["amenity"="cafe"];out count;nwr["shop"="coffee"];out count;(nwr["amenity"="cafe"];nwr["shop"="coffee"];);out count;`,
      `[out:json][timeout:180][bbox:55.78,49.1,55.7934,49.1238][date:"${T}"];way["landuse"="industrial"];out count;rel["landuse"="industrial"];out count;(way["landuse"="industrial"];rel["landuse"="industrial"];);out count;`,
      `[out:json][timeout:180][bbox:55.78,49.1,55.7934,49.1238][date:"${T}"];way["building"];out count;`,
    ]);
    const report = got.out.join('\n');
    expect(report).toMatch(/metro\s+node\["railway"="subway_entrance"\]\s+2\s+1\s+0\s+3/);
    expect(report).toMatch(/buildings\s+way\["building"\]\s+3\s+3/);
  });

  it('explains wrong arguments with the usage', async () => {
    for (const args of [[], ['--pack', '../etc'], ['--pack', 'tiny-city', '--date', 'yesterday'], ['--pack', 'tiny-city', '--offline'], ['--pack', 'tiny-city', '--bbox', '1']]) {
      const got = await run(args, { online: false });
      expect(got.code, args.join(' ')).toBe(2);
      expect(got.log.join('\n')).toContain('usage: pnpm --filter @otkryvay/api location-index');
    }
  });
});
