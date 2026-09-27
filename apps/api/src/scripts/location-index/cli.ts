import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
  buildingCentres,
  buildingsCountQuery,
  buildingsQuery,
  buildLocationIndex,
  featuresFromOverpass,
  isOsmTime,
  KEBAB_ID,
  overpassCountQuery,
  overpassOsmBase,
  overpassQuery,
  parseLocationIndex,
  scoreLocations,
  type BBox,
  type LocationIndex,
  type OsmFeature,
} from '@otkryvay/core';
import { z } from 'zod';
import { loadRulesPack } from '../../shell/content/load.js';
import { checkReferencePoint, loadLocationCriteria, loadLocationFixtures, serializeLocationIndex, SNAPSHOT_FILE } from './content.js';
import { messageOf } from './format.js';
import {
  createOverpassClient,
  fileCache,
  overpassSettings,
  PROJECT_URL,
  writeAtomically,
  type OverpassClient,
  type OverpassRequest,
  type OverpassSettings,
} from './overpass.js';
import { checkLayer, dropsOf, formatCounts, formatReport, type LayerCount } from './report.js';

// The offline pipeline of the location index (doc-3 §4): the methodology of a pack and OpenStreetMap in, the
// snapshot content/<pack>/location-index.json out. Strictly one query at a time: the probe for the time of the
// data, one query per criterion, the built-up mask — all pinned to that time with [date:"T"], so that every layer
// is one slice of OSM and a rerun with --date T takes every answer from the cache.

/** The script that makes the snapshots, named in every snapshot (source.method). */
export const METHOD_URL = `${PROJECT_URL}/tree/main/apps/api/src/scripts/location-index`;

/** The smallest query: no data, only the time of the freshest data of the mirror (osm3s.timestamp_osm_base). */
export const PROBE_QUERY = '[out:json][timeout:25];out;';

/** Where a snapshot with a failed reference point goes, in the cache directory, instead of the pack. */
function failedSnapshotFile(packId: string): string {
  return `${packId}.location-index.failed.json`;
}

const USAGE = `usage: pnpm --filter @otkryvay/api location-index --pack <id> [options]
  --pack <id>        rules pack in content/, e.g. kazan-coffee
  --counts           only count the OSM objects of every layer (out count), no snapshot
  --date <T>         OSM time like 2026-09-23T19:28:21Z; by default the freshest data of the mirror
  --cache-dir <dir>  cache of raw Overpass answers; by default .cache/location-index at the repository root
  --offline          answers only from the cache, no network (needs --date)
  --out <file>       where to write the snapshot; by default content/<pack>/location-index.json
relative paths are taken from the directory pnpm was started in (INIT_CWD).
environment: OVERPASS_URLS, OVERPASS_QUERY_TIMEOUT_S, OVERPASS_HTTP_TIMEOUT_MS, OVERPASS_RETRIES,
  OVERPASS_PAUSE_MS, OVERPASS_USER_AGENT (doc-3 §4.3)`;

const DEFAULT_CACHE_DIR = fileURLToPath(new URL('../../../../../.cache/location-index', import.meta.url));
const PACKAGE_JSON = new URL('../../../package.json', import.meta.url);
/** A time of OSM data is plausible from 2010 to an hour ahead of the clock (a mirror's clock may run a little fast). */
const EARLIEST_DATA = Date.parse('2010-01-01T00:00:00Z');
const CLOCK_SKEW_MS = 3_600_000;

export interface CliDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** Relative --cache-dir and --out are resolved against it: where pnpm was started (INIT_CWD), else the cwd. */
  cwd: string;
  /** The content directory with the packs. */
  contentDir: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds, like Date.now: the pauses, the time of the probe and of the run. */
  now: () => number;
  random: () => number;
  /** The report (stdout). */
  out: (line: string) => void;
  /** Progress and errors (stderr). */
  log: (line: string) => void;
}

interface Options {
  pack: string;
  counts: boolean;
  date: string | undefined;
  cacheDir: string;
  offline: boolean;
  out: string | undefined;
}

/** How far a run got: after the probe, the answers of T are worth a rerun with --date T. */
interface RunState {
  osmBase: string | undefined;
}

class UsageError extends Error {}

/** Runs the CLI; resolves to the exit code: 0 — done, 1 — failed, 2 — wrong arguments. */
export async function runLocationIndexCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let options: Options | 'help';
  try {
    options = parseOptions(argv, deps);
  } catch (error) {
    deps.log(`location-index: ${messageOf(error)}\n${USAGE}`);
    return 2;
  }
  if (options === 'help') {
    deps.out(USAGE);
    return 0;
  }
  const state: RunState = { osmBase: undefined };
  try {
    return options.counts ? await countRun(options, deps, state) : await buildRun(options, deps, state);
  } catch (error) {
    deps.log(`location-index: ${messageOf(error)}`);
    const t = state.osmBase;
    if (t !== undefined) {
      deps.log(
        options.offline
          ? `hint: run online with --date ${t} to fetch what is missing`
          : `hint: the answers of T=${t} fetched so far are cached: rerun with --date ${t}`,
      );
    }
    return 1;
  }
}

function parseOptions(argv: readonly string[], deps: CliDeps): Options | 'help' {
  // pnpm may pass the arguments after a separator.
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        pack: { type: 'string' },
        counts: { type: 'boolean', default: false },
        date: { type: 'string' },
        'cache-dir': { type: 'string' },
        offline: { type: 'boolean', default: false },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(messageOf(error));
  }
  if (values.help) return 'help';
  const pack = values.pack;
  if (pack === undefined) throw new UsageError('--pack is required');
  if (!KEBAB_ID.test(pack)) throw new UsageError(`--pack must be the id of a pack, like kazan-coffee, got "${pack}"`);
  const date = values.date;
  if (date !== undefined) {
    if (!isOsmTime(date)) throw new UsageError(`--date must be an OSM time like 2026-09-23T19:28:21Z, got "${date}"`);
    const problem = implausible(date, deps.now());
    if (problem) throw new UsageError(`--date ${problem}`);
  }
  if (values.offline && date === undefined) throw new UsageError('--offline needs --date: the time of the data cannot be asked for offline');
  if (values.counts && values.out !== undefined) throw new UsageError('--counts writes no snapshot, so it takes no --out');
  return {
    pack,
    counts: values.counts,
    date,
    cacheDir: values['cache-dir'] === undefined ? DEFAULT_CACHE_DIR : resolve(deps.cwd, values['cache-dir']),
    offline: values.offline,
    out: values.out === undefined ? undefined : resolve(deps.cwd, values.out),
  };
}

/** Why a time cannot be the time of OSM data: before 2010, more than an hour ahead of the clock, not a real date. */
function implausible(time: string, now: number): string | undefined {
  const at = Date.parse(time);
  // Date.parse takes 2026-02-30 for 2 March; a real date prints back as itself.
  if (Number.isNaN(at) || new Date(at).toISOString().replace('.000Z', 'Z') !== time) return `${time} is implausible: not a real date`;
  if (at < EARLIEST_DATA) return `${time} is implausible: before 2010`;
  return at > now + CLOCK_SKEW_MS ? `${time} is implausible: more than an hour ahead of the clock` : undefined;
}

// ---------- the snapshot ----------

async function buildRun(options: Options, deps: CliDeps, state: RunState): Promise<number> {
  const started = deps.now();
  const pack = await loadRulesPack(options.pack, deps.contentDir);
  const bbox = regionOf(options.pack, pack.manifest.region.bbox);
  const { config, sha256 } = await loadLocationCriteria(deps.contentDir, options.pack);
  const fixtures = await loadLocationFixtures(deps.contentDir, options.pack);
  const settings = overpassSettings(deps.env, await packageVersion());
  const counter = { network: 0, cached: 0 };
  const client = clientOf(options, deps, settings, counter);

  // Read before anything is written: the snapshot of the pack and the probe record of its time.
  const packPath = join(deps.contentDir, options.pack, SNAPSHOT_FILE);
  const previous = await previousSnapshot(packPath, options.cacheDir);

  let record: ProbeRecord;
  let fresh: Fetch | undefined;
  if (options.offline) record = await readProbeRecord(options.cacheDir, options.date!);
  else ({ record, fresh } = await probe(client, options, deps));
  state.osmBase = record.osmBase;
  deps.log(`OSM data as of ${record.osmBase} (${fresh?.endpoint ?? record.endpoint})`);
  // Online, the record is kept up to date after every answer: a run that fails halfway still tells where its answers came from.
  const save = async () => (options.offline ? undefined : writeAtomically(probeRecordPath(options.cacheDir, record.osmBase), `${JSON.stringify(record, null, 2)}\n`));
  // The first download makes this run the one that fetched the data: the time and the mirror of its probe go in.
  const fetched = () => {
    if (fresh) Object.assign(record, fresh);
    fresh = undefined;
  };
  await save();

  const layers: Record<string, OsmFeature[]> = {};
  const answers: Record<string, unknown> = {};
  for (const criterion of config.criteria) {
    const query = overpassQuery(criterion, bbox, { date: record.osmBase, timeoutSeconds: settings.queryTimeoutSeconds });
    const check = (json: unknown) => tooFew(criterion.id, featuresFromOverpass(json, criterion).length, criterion.min_features);
    const answer = await client.request({ label: criterion.id, query, cache: true, check, notBefore: record.osmBase });
    answers[criterion.id] = answer.json;
    layers[criterion.id] = featuresFromOverpass(answer.json, criterion);
    if (answer.endpoint !== undefined) {
      fetched();
      record.layers[criterion.id] = answer.endpoint;
      await save();
    }
  }
  const maskMin = config.grid.min_features ?? 1;
  const mask = await client.request({
    label: 'buildings',
    query: buildingsQuery(bbox, { date: record.osmBase, timeoutSeconds: settings.queryTimeoutSeconds }),
    cache: true,
    notBefore: record.osmBase,
    check: (json) => {
      const count = buildingCentres(json).length;
      return count < maskMin ? `suspiciously little data: the built-up mask has ${count} buildings, grid.min_features is ${maskMin}` : undefined;
    },
  });
  const buildings = buildingCentres(mask.json);
  if (mask.endpoint !== undefined) fetched();
  record.buildings = { endpoint: mask.endpoint ?? record.buildings?.endpoint, count: buildings.length };
  await save();

  const ix = buildLocationIndex({
    pack: options.pack,
    bbox,
    config,
    configSha256: sha256,
    layers,
    buildings,
    source: { osmBase: record.osmBase, extractedAt: record.extractedAt, endpoint: record.endpoint, method: METHOD_URL },
  });
  const text = serializeLocationIndex(ix);
  // The snapshot as the API will read it: parsed back from the text and checked against the pack.
  const checked = parseLocationIndex(JSON.parse(text), pack);
  if (!checked.ok) {
    throw new Error(`the snapshot fails its own check:\n${checked.issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`);
  }

  const result = scoreLocations(checked.value);
  const references = fixtures?.points.map((point) => checkReferencePoint(checked.value, result, point));
  const failed = references?.filter((check) => check.failures.length > 0).length ?? 0;
  // A snapshot that fails a reference point never replaces the one of the pack, unless --out says where it goes.
  const target = options.out ?? (failed > 0 ? join(options.cacheDir, failedSnapshotFile(options.pack)) : packPath);
  await writeAtomically(target, text);

  const drops = previous ? dropsOf(previous, checked.value, buildings.length) : [];
  const report = formatReport({
    pack: options.pack,
    osmBase: record.osmBase,
    endpoint: record.endpoint,
    configSha256: sha256,
    layers: config.criteria.map((criterion, c) =>
      checkLayer(answers[criterion.id], criterion, layers[criterion.id]!, bbox, checked.value.criteria[c]!.featureCount),
    ),
    mirrors: record.layers,
    buildings: { count: buildings.length, endpoint: record.buildings.endpoint },
    ix: checked.value,
    result,
    fixtures: references,
    drops: drops.length > 0 ? { osmBase: previous!.ix.source.osmBase, drops } : undefined,
    written: { path: shown(deps.cwd, target), instead: target === packPath || options.out ? undefined : shown(deps.cwd, packPath), failed },
    bytes: Buffer.byteLength(text),
    gzipBytes: gzipSync(text, { level: 9 }).length,
    seconds: (deps.now() - started) / 1000,
    network: counter.network,
    cached: counter.cached,
  });
  for (const line of report) deps.out(line);

  if (drops.length > 0) deps.log(`location-index: WARNING: much fewer objects than in the snapshot of the pack: ${drops.map((d) => d.what).join(', ')}`);
  if (failed > 0) {
    const where = target === packPath || options.out ? `the snapshot is written to ${shown(deps.cwd, target)}` : `the snapshot of the pack is left as it was, the result is in ${shown(deps.cwd, target)}`;
    deps.log(`location-index: ${failed} reference point${failed === 1 ? '' : 's'} failed; ${where}`);
    return 1;
  }
  return 0;
}

/** The snapshot of the pack before this run, with the buildings of its time when its probe record is at hand. */
async function previousSnapshot(path: string, cacheDir: string): Promise<{ ix: LocationIndex; buildings: number | undefined } | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed;
  try {
    parsed = parseLocationIndex(JSON.parse(text));
  } catch {
    return undefined;
  }
  if (!parsed.ok) return undefined;
  const record = await probeRecordIfAny(cacheDir, parsed.value.source.osmBase);
  return { ix: parsed.value, buildings: record?.buildings?.count };
}

// ---------- the time of the data: the probe and its record ----------

/**
 * Where the data of T came from, kept next to the cache as probe-<T>.json, so that an offline rebuild makes the same
 * snapshot, byte for byte: the probe that fetched the data, and the mirror of every layer and of the built-up mask.
 */
const ProbeRecordSchema = z.strictObject({
  osmBase: z.string().refine(isOsmTime, 'must be an OSM time like 2026-09-23T19:28:21Z'),
  /** The mirror that answered the probe of the online run that fetched the data (source.endpoint). */
  endpoint: z.url(),
  /**
   * When that probe answered: the time of the extraction (source.extractedAt). A rerun that takes every answer from
   * the cache fetches nothing and keeps it, so the snapshot of T does not change.
   */
  extractedAt: z.iso.datetime({ precision: 0 }),
  /** The mirror of every layer by criterion id. */
  layers: z.record(z.string(), z.url()),
  buildings: z.strictObject({ endpoint: z.url().optional(), count: z.number().int().min(0) }).optional(),
});

type ProbeRecord = z.infer<typeof ProbeRecordSchema>;

/** The mirror and the time of this run's probe: the record takes them once the run downloads something. */
type Fetch = Pick<ProbeRecord, 'endpoint' | 'extractedAt'>;

function probeRecordPath(cacheDir: string, osmBase: string): string {
  return join(cacheDir, `probe-${osmBase.replace(/[-:]/g, '')}.json`);
}

/**
 * Online: the probe asks the mirrors for the time of their freshest data, or checks that one has --date. A record of
 * T from an earlier run stays as it is until this run downloads something: the answers from the cache are its.
 */
async function probe(client: OverpassClient, options: Options, deps: CliDeps): Promise<{ record: ProbeRecord; fresh: Fetch }> {
  const date = options.date;
  const answer = await client.request({
    label: 'probe',
    query: PROBE_QUERY,
    cache: false,
    // With --date, a mirror behind it would answer [date:"T"] with older data; without, the freshest data will do.
    notBefore: date,
    check: (json) => {
      const base = overpassOsmBase(json);
      return base === null ? 'the answer does not tell the time of its data (osm3s.timestamp_osm_base)' : implausible(base, deps.now());
    },
  });
  const osmBase = date ?? overpassOsmBase(answer.json)!;
  const fresh: Fetch = { endpoint: answer.endpoint!, extractedAt: isoSeconds(deps.now()) };
  const earlier = await probeRecordIfAny(options.cacheDir, osmBase);
  const record = earlier ? { ...earlier, layers: { ...earlier.layers } } : { osmBase, ...fresh, layers: {} };
  return { record, fresh };
}

/** Offline: the record of the last online probe of T, or an error that says what is wrong with it. */
async function readProbeRecord(cacheDir: string, osmBase: string): Promise<ProbeRecord> {
  const path = probeRecordPath(cacheDir, osmBase);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`offline, and no probe record of ${osmBase} (${path}): run once online with --date ${osmBase}`, { cause: error });
    }
    throw new Error(`cannot read the probe record ${path}: ${messageOf(error)}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`the probe record ${path} is not JSON: ${messageOf(error)}`, { cause: error });
  }
  const parsed = ProbeRecordSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`the probe record ${path} is damaged or was written by an older version of the script:\n${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.osmBase !== osmBase) throw new Error(`the probe record ${path} is of ${parsed.data.osmBase}, not ${osmBase}`);
  return parsed.data;
}

/** The record of T when there is a usable one; a missing or damaged record is simply not there. */
async function probeRecordIfAny(cacheDir: string, osmBase: string): Promise<ProbeRecord | undefined> {
  try {
    return await readProbeRecord(cacheDir, osmBase);
  } catch {
    return undefined;
  }
}

// ---------- counts ----------

const CountAnswerSchema = z.object({
  elements: z.array(
    z.object({
      type: z.literal('count'),
      tags: z.object({ nodes: z.coerce.number(), ways: z.coerce.number(), relations: z.coerce.number(), total: z.coerce.number() }),
    }),
  ),
});

/**
 * `out count` versions of the layer queries (a sanity check against doc-3 §2): every selector, all of them
 * together, and the buildings of the mask. Cached like the layers, so a rerun costs nothing; no probe record is
 * written, so the snapshots of T stay as they are.
 */
async function countRun(options: Options, deps: CliDeps, state: RunState): Promise<number> {
  const pack = await loadRulesPack(options.pack, deps.contentDir);
  const bbox = regionOf(options.pack, pack.manifest.region.bbox);
  const { config } = await loadLocationCriteria(deps.contentDir, options.pack);
  const settings = overpassSettings(deps.env, await packageVersion());
  const client = clientOf(options, deps, settings, { network: 0, cached: 0 });
  const osmBase = options.offline ? options.date! : (await probe(client, options, deps)).record.osmBase;
  state.osmBase = osmBase;
  deps.log(`OSM data as of ${osmBase}`);

  const opts = { date: osmBase, timeoutSeconds: settings.queryTimeoutSeconds };
  const layers: LayerCount[] = [];
  for (const criterion of config.criteria) {
    // A count per selector, then — with several — one of all of them together (overpassCountQuery).
    const statements = criterion.osm.length + (criterion.osm.length > 1 ? 1 : 0);
    const counts = await countsOf(client, `${criterion.id} (count)`, overpassCountQuery(criterion, bbox, opts), statements, osmBase);
    layers.push({ id: criterion.id, selectors: criterion.osm.map((selector, i) => ({ selector, ...counts[i]! })), total: counts.at(-1)!.total });
  }
  const [buildings] = await countsOf(client, 'buildings (count)', buildingsCountQuery(bbox, opts), 1, osmBase);
  for (const line of formatCounts(layers, buildings!.total)) deps.out(line);
  return 0;
}

async function countsOf(client: OverpassClient, label: string, query: string, statements: number, osmBase: string) {
  const check = (json: unknown) => {
    const parsed = CountAnswerSchema.safeParse(json);
    if (!parsed.success) return 'the answer has no counts';
    return parsed.data.elements.length === statements ? undefined : `expected ${statements} counts, got ${parsed.data.elements.length}`;
  };
  const answer = await client.request({ label, query, cache: true, check, notBefore: osmBase });
  return CountAnswerSchema.parse(answer.json).elements.map((element) => element.tags);
}

// ---------- helpers ----------

function clientOf(options: Options, deps: CliDeps, settings: OverpassSettings, counter: { network: number; cached: number }): OverpassClient {
  if (!options.offline) deps.log(`overpass: ${settings.urls.length} mirrors, User-Agent «${settings.userAgent}»`);
  const client = createOverpassClient({
    settings,
    cache: fileCache(options.cacheDir),
    offline: options.offline,
    fetch: deps.fetch,
    sleep: deps.sleep,
    now: deps.now,
    random: deps.random,
    log: (line) => deps.log(`overpass: ${line}`),
  });
  // Counts the answers that came from a mirror and from the cache.
  return {
    async request(request: OverpassRequest) {
      const answer = await client.request(request);
      if (answer.endpoint === undefined) counter.cached++;
      else counter.network++;
      return answer;
    },
  };
}

function regionOf(packId: string, bbox: BBox | undefined): BBox {
  if (!bbox) throw new Error(`pack "${packId}" has no region.bbox: the grid of the index is laid over it`);
  return bbox;
}

function tooFew(label: string, found: number, min: number): string | undefined {
  return found < min ? `suspiciously little data: ${label} has ${found} OSM object${found === 1 ? '' : 's'}, min_features is ${min}` : undefined;
}

/** A path as the person who started the run will find it: from their directory, or whole when it lies elsewhere. */
function shown(cwd: string, path: string): string {
  const from = relative(cwd, path);
  return from !== '' && !from.startsWith('..') && !isAbsolute(from) ? from : path;
}

async function packageVersion(): Promise<string> {
  const { version } = z.object({ version: z.string().min(1) }).parse(JSON.parse(await readFile(PACKAGE_JSON, 'utf8')));
  return version;
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
