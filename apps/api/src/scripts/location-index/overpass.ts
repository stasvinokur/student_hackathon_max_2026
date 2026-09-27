import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { overpassOsmBase } from '@otkryvay/core';
import { z } from 'zod';
import { formatBytes, formatSeconds, messageOf, oneLine } from './format.js';

// The Overpass API client of the offline location index pipeline (doc-3 §4.3). Public mirrors are shared and
// fragile — on 23.09 they answered 504 and sent empty or cut bodies with status 200 — so the client is polite and
// stubborn at once: one request at a time with a pause between them, retries with growing pauses, the next mirror
// when one gives up, a check of every answer, and a cache of raw answers, so that a snapshot can be rebuilt
// offline. The network, the clock, the pauses and the cache are injected: the tests need no network.

/** Mirrors in the order they are tried (doc-3 §4.3). */
export const DEFAULT_OVERPASS_URLS: readonly string[] = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export const PROJECT_URL = 'https://github.com/trade-stasvinokur/student_hackathon_max_2026';

/** Names the tool and where to read about it, never a person: no e-mail, no names (doc-3 §4.3). */
export function defaultUserAgent(version: string): string {
  return `otkryvay-location-index/${version} (+${PROJECT_URL})`;
}

// ---------- settings ----------

export interface OverpassSettings {
  /** Mirrors in the order they are tried. */
  urls: readonly string[];
  /** Server-side timeout written into every query, seconds. */
  queryTimeoutSeconds: number;
  /** How long to wait for a whole answer, milliseconds. */
  httpTimeoutMs: number;
  /** Retries per mirror after the first attempt. */
  retries: number;
  /** Least pause between two requests, milliseconds. */
  pauseMs: number;
  userAgent: string;
}

const EnvSchema = z.object({
  OVERPASS_URLS: z.string().optional(),
  OVERPASS_QUERY_TIMEOUT_S: z.coerce.number().int().min(1).max(3600).default(180),
  OVERPASS_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).default(240_000),
  OVERPASS_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  OVERPASS_PAUSE_MS: z.coerce.number().int().min(0).default(2000),
  OVERPASS_USER_AGENT: z.string().optional(),
});

const MirrorUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' });

/** Settings from OVERPASS_* environment variables (doc-3 §4.3); an empty variable counts as not set. */
export function overpassSettings(env: Readonly<Record<string, string | undefined>>, version: string): OverpassSettings {
  const set = Object.fromEntries(Object.entries(env).filter(([key, value]) => key.startsWith('OVERPASS_') && value?.trim()));
  const parsed = EnvSchema.safeParse(set);
  if (!parsed.success) throw new Error(`invalid Overpass settings:\n${z.prettifyError(parsed.error)}`);
  const vars = parsed.data;
  const urls = vars.OVERPASS_URLS === undefined ? DEFAULT_OVERPASS_URLS : vars.OVERPASS_URLS.split(',').map((url) => url.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error('invalid Overpass settings: OVERPASS_URLS lists no mirror');
  for (const url of urls) {
    if (!MirrorUrl.safeParse(url).success) throw new Error(`invalid Overpass settings: OVERPASS_URLS: "${url}" is not an http(s) URL`);
  }
  return {
    urls,
    queryTimeoutSeconds: vars.OVERPASS_QUERY_TIMEOUT_S,
    httpTimeoutMs: vars.OVERPASS_HTTP_TIMEOUT_MS,
    retries: vars.OVERPASS_RETRIES,
    pauseMs: vars.OVERPASS_PAUSE_MS,
    userAgent: vars.OVERPASS_USER_AGENT?.trim() || defaultUserAgent(version),
  };
}

// ---------- cache ----------

/** Raw answers by the sha256 of their query: the query names the bbox, the date and the selectors, not a mirror. */
export interface OverpassCache {
  /** Where an entry is kept, for messages. */
  where(key: string): string;
  read(key: string): Promise<string | undefined>;
  write(key: string, body: string): Promise<void>;
}

/**
 * The key of an answer: the sha256 of its query without the server-side timeout, which changes how long a mirror may
 * work, not the answer — a longer OVERPASS_QUERY_TIMEOUT_S keeps the cache.
 */
export function cacheKey(query: string): string {
  return sha256(query.replace(/^\[out:json\]\[timeout:\d+\]/, '[out:json]'));
}

/** The key the first caches kept answers under: the sha256 of the whole query. Read as a fallback, never written. */
export function legacyCacheKey(query: string): string {
  return sha256(query);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The cache in a directory: <dir>/<key>.json, the answer exactly as the mirror sent it. */
export function fileCache(dir: string): OverpassCache {
  const path = (key: string) => join(dir, `${key}.json`);
  return {
    where: path,
    async read(key) {
      try {
        return await readFile(path(key), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    write: (key, body) => writeAtomically(path(key), body),
  };
}

/** Writes a file aside and renames it into place: an interrupted run leaves no cut file, a failed one no leftover. */
export async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  try {
    await writeFile(partial, text);
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

// ---------- the client ----------

export interface OverpassRequest {
  /** Name in logs and errors: a criterion id, «probe», «buildings». */
  label: string;
  query: string;
  /** Whether the answer is cached; not the probe, which asks for the time of the freshest data. */
  cache: boolean;
  /**
   * Checks an answer beyond well-formed JSON, e.g. that it has enough objects (min_features): returns why the
   * answer is unusable, or undefined; a throw counts as a reason. A dated answer does not change, so the next mirror
   * is asked at once, without retries.
   */
  check?: (json: unknown) => string | undefined;
  /**
   * The answer must be of OSM data at least this fresh (osm3s.timestamp_osm_base, which Overpass writes into every
   * answer, [date] or not). A mirror behind it answers [date:"T"] with its older data — a server of overpass-api.de
   * was two days behind on 24.09 — so it is passed over at once.
   */
  notBefore?: string | undefined;
}

export interface OverpassAnswer {
  json: unknown;
  /** Size of the answer, bytes. */
  bytes: number;
  /** The mirror that sent it; undefined for an answer from the cache. */
  endpoint: string | undefined;
}

export interface OverpassClient {
  request(request: OverpassRequest): Promise<OverpassAnswer>;
}

export interface OverpassClientOptions {
  settings: OverpassSettings;
  /** Without a cache nothing is cached. */
  cache?: OverpassCache | undefined;
  /** Answers only from the cache; a missing entry is an error. */
  offline?: boolean | undefined;
  fetch?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Milliseconds, like Date.now. */
  now?: (() => number) | undefined;
  /** In [0, 1), like Math.random: the jitter of pauses. */
  random?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
}

export class OverpassError extends Error {
  override name = 'OverpassError';
}

/** Pause before the k-th retry on a mirror: 5, 15, 45 s… (doc-3 §4.3), plus up to a fifth more at random. */
const BACKOFF_MS = 5000;
const BACKOFF_FACTOR = 3;
const JITTER = 0.2;
/** 429 without Retry-After waits this long; a longer Retry-After is cut to the maximum. */
const RETRY_AFTER_MS = 30_000;
const MAX_RETRY_AFTER_MS = 300_000;
/** Remarks of an answer the server gave up on: its elements are incomplete, another mirror may manage. */
const GAVE_UP = /runtime error|timed out|out of memory/i;

type Attempt =
  | { kind: 'ok'; json: unknown; body: string }
  /** Try the same mirror again, after the given pause or the backoff: the network, 5xx, a cut answer. */
  | { kind: 'retry'; reason: string; waitMs?: number }
  /** This mirror cannot answer the query, now or ever: try the next one. */
  | { kind: 'next'; reason: string }
  /** No mirror can: the query itself is wrong. */
  | { kind: 'fatal'; reason: string };

export function createOverpassClient(options: OverpassClientOptions): OverpassClient {
  const { settings, cache, offline = false } = options;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => {});

  /** When the last request ended, for the pause before the next one. */
  let lastEnd: number | undefined;
  /** The mirror that answered last is asked first: a mirror that is down is not tried again for every query. */
  let preferred = 0;
  /** Requests run strictly one after another, even when called together. */
  let queue: Promise<unknown> = Promise.resolve();

  async function perform(request: OverpassRequest): Promise<OverpassAnswer> {
    const key = cacheKey(request.query);
    if (request.cache && cache) {
      const found = await readCached(cache, request.query);
      if (found) {
        const verdict = judge(found.body, request);
        if (verdict.kind === 'ok') {
          log(`${request.label}: from the cache, ${formatBytes(byteLength(found.body))}`);
          // An answer under the old key holds the old timeout in its key: under the new one, any timeout finds it.
          if (found.key !== key) {
            try {
              await cache.write(key, found.body);
              log(`${request.label}: the cached answer is copied to its new key ${cache.where(key)}`);
            } catch (error) {
              log(`WARNING: ${request.label}: the cached answer is not copied to its new key (${cache.where(key)}): ${messageOf(error)}`);
            }
          }
          return { json: verdict.json, bytes: byteLength(found.body), endpoint: undefined };
        }
        if (offline) throw new OverpassError(`${request.label}: the cached answer ${cache.where(found.key)} is unusable: ${verdict.reason}`);
        log(`${request.label}: the cached answer is unusable (${verdict.reason}), asking again`);
      }
    }
    if (offline) {
      const where = request.cache && cache ? ` (${cache.where(key)})` : '';
      throw new OverpassError(`${request.label}: offline, and no cached answer${where} to the query ${request.query}`);
    }

    const failures: string[] = [];
    for (let k = 0; k < settings.urls.length; k++) {
      const index = (preferred + k) % settings.urls.length;
      const url = settings.urls[index]!;
      for (let attempt = 0; ; attempt++) {
        const outcome = await send(url, request);
        if (outcome.kind === 'ok') {
          preferred = index;
          if (request.cache && cache) {
            // The answer came at a cost to a shared server: a full disk must not throw it away.
            try {
              await cache.write(key, outcome.body);
            } catch (error) {
              log(`WARNING: ${request.label}: the answer is not cached (${cache.where(key)}): ${messageOf(error)}`);
            }
          }
          return { json: outcome.json, bytes: byteLength(outcome.body), endpoint: url };
        }
        failures.push(`${hostOf(url)}: ${outcome.reason}`);
        if (outcome.kind === 'fatal') {
          throw new OverpassError(`${request.label}: ${hostOf(url)} rejected the query: ${outcome.reason}\nquery: ${request.query}`);
        }
        if (outcome.kind === 'next' || attempt >= settings.retries) {
          const next = k + 1 < settings.urls.length ? '; trying the next mirror' : '';
          log(`${request.label}: ${hostOf(url)}: ${outcome.reason}${next}`);
          break;
        }
        const wait = outcome.waitMs ?? Math.round(BACKOFF_MS * BACKOFF_FACTOR ** attempt * (1 + JITTER * random()));
        log(`${request.label}: ${hostOf(url)}: ${outcome.reason}; again in ${formatSeconds(wait)}`);
        await sleep(wait);
      }
    }
    throw new OverpassError(`${request.label}: no Overpass mirror gave a usable answer:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  }

  /** One POST to one mirror, after the pause since the previous request. */
  async function send(url: string, request: OverpassRequest): Promise<Attempt> {
    if (lastEnd !== undefined) {
      const wait = lastEnd + settings.pauseMs - now();
      if (wait > 0) await sleep(wait);
    }
    const started = now();
    let response: Response;
    let body: string;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', 'user-agent': settings.userAgent },
        body: new URLSearchParams({ data: request.query }).toString(),
        signal: AbortSignal.timeout(settings.httpTimeoutMs),
      });
      body = await response.text();
    } catch (error) {
      return { kind: 'retry', reason: networkFailure(error, settings.httpTimeoutMs) };
    } finally {
      lastEnd = now();
    }
    log(`${request.label}: ${hostOf(url)} answered HTTP ${response.status}, ${formatBytes(byteLength(body))} in ${formatSeconds(lastEnd - started)}`);

    const status = response.status;
    if (status === 200) return judge(body, request);
    const text = serverText(body);
    const reason = `HTTP ${status}${text ? `: ${text}` : ''}`;
    if (status === 400) return { kind: 'fatal', reason };
    if (status === 429) return { kind: 'retry', reason, waitMs: retryAfter(response.headers.get('retry-after'), now()) };
    // 502, 503, 504 — and any other server failure — may pass.
    if (status >= 500) return { kind: 'retry', reason };
    return { kind: 'next', reason };
  }

  return {
    request(request) {
      const run = queue.then(() => perform(request));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/** The cached answer to a query: under its key, else under the key of the first caches. */
async function readCached(cache: OverpassCache, query: string): Promise<{ key: string; body: string } | undefined> {
  for (const key of [cacheKey(query), legacyCacheKey(query)]) {
    const body = await cache.read(key);
    if (body !== undefined) return { key, body };
  }
  return undefined;
}

/**
 * An answer with status 200 (or from the cache): whole JSON with elements, not given up on, of data fresh enough,
 * passing the check. Only a cut answer is worth asking the same mirror again: what a whole answer says of a dated
 * query does not change.
 */
function judge(body: string, { check, notBefore }: OverpassRequest): Attempt {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { kind: 'retry', reason: body.trim() === '' ? 'empty answer' : `the answer is not JSON or is cut (${formatBytes(byteLength(body))})` };
  }
  if (typeof json !== 'object' || json === null || !Array.isArray((json as { elements?: unknown }).elements)) {
    return { kind: 'retry', reason: 'the answer has no elements' };
  }
  const remark = (json as { remark?: unknown }).remark;
  if (typeof remark === 'string' && GAVE_UP.test(remark)) return { kind: 'next', reason: `the server gave up: ${oneLine(remark)}` };
  if (notBefore !== undefined) {
    const base = overpassOsmBase(json);
    if (base === null) return { kind: 'next', reason: 'the answer does not tell the time of its data (osm3s.timestamp_osm_base)' };
    if (base < notBefore) return { kind: 'next', reason: `the mirror has data up to ${base} only, older than ${notBefore}` };
  }
  let problem: string | undefined;
  try {
    problem = check?.(json);
  } catch (error) {
    problem = messageOf(error);
  }
  return problem === undefined ? { kind: 'ok', json, body } : { kind: 'next', reason: oneLine(problem) };
}

/** Retry-After in seconds or as an HTTP date; 30 s without it, at most 5 minutes. */
function retryAfter(header: string | null, nowMs: number): number {
  const value = header?.trim();
  let wait = RETRY_AFTER_MS;
  if (value && /^\d+$/.test(value)) wait = Number(value) * 1000;
  else if (value && !Number.isNaN(Date.parse(value))) wait = Date.parse(value) - nowMs;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, wait));
}

function networkFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return `no answer in ${formatSeconds(timeoutMs)}`;
  if (!(error instanceof Error)) return `network error: ${oneLine(String(error))}`;
  // fetch hides the reason (ECONNRESET, ENOTFOUND, a certificate) in the cause.
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : undefined;
  return oneLine(`network error: ${error.message}${detail ? ` (${detail})` : ''}`);
}

/** The message of an Overpass error page, without the markup and the licence line; at most 300 characters. */
function serverText(body: string): string {
  const text = body
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    // Block tags part the text; inline ones, like the <strong>Error</strong> of Overpass, do not.
    .replace(/<\/?(p|br|div|h\d|li|tr|td|body|html)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/The data included in this document is from www\.openstreetmap\.org\. The data is made available under ODbL\./g, ' ');
  return oneLine(text).slice(0, 300);
}

function hostOf(url: string): string {
  return new URL(url).host;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
