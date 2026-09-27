import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cacheKey,
  createOverpassClient,
  DEFAULT_OVERPASS_URLS,
  defaultUserAgent,
  fileCache,
  legacyCacheKey,
  overpassSettings,
  type OverpassCache,
  type OverpassClientOptions,
  type OverpassSettings,
} from './overpass.js';

const A = 'https://a.example.org/api/interpreter';
const B = 'https://b.example.org/api/interpreter';
const T = '2026-09-23T19:28:21Z';
const QUERY = `[out:json][timeout:180][bbox:55.6,48.8,55.95,49.4][date:"${T}"];(node["railway"="subway_entrance"];);out tags center qt;`;

const answer = (elements: object[] = [{ type: 'node', id: 1, lat: 55.79, lon: 49.1 }], extra: object = {}) =>
  JSON.stringify({ version: 0.6, osm3s: { timestamp_osm_base: T }, ...extra, elements });
const ok = (body = answer()) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const status = (code: number, body = '', headers: Record<string, string> = {}) => new Response(body, { status: code, headers });
/** An Overpass error page, as the interpreter sends it. */
const errorPage = (message: string) =>
  '<?xml version="1.0" encoding="UTF-8"?><html><head><title>OSM3S Response</title></head><body>' +
  '<p>The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.</p>' +
  `<p><strong style="color:#FF0000">Error</strong>: ${message} </p></body></html>`;

interface Call {
  url: string;
  query: string;
  headers: Headers;
}

/** A fake network: answers in order and records every request; it also checks that requests never overlap. */
function network(...answers: Array<Response | Error>) {
  const calls: Call[] = [];
  let inFlight = 0;
  let overlapped = false;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (inFlight > 0) overlapped = true;
    inFlight++;
    try {
      await Promise.resolve();
      calls.push({ url: String(url), query: new URLSearchParams(String(init?.body)).get('data') ?? '', headers: new Headers(init?.headers) });
      const next = answers.shift();
      if (next === undefined) throw new Error('unexpected request');
      if (next instanceof Error) throw next;
      return next;
    } finally {
      inFlight--;
    }
  };
  return { fetch: fetch as typeof globalThis.fetch, calls, overlapped: () => overlapped, left: () => answers.length };
}

/** A clock that moves only when the client sleeps, and the pauses it took. */
function fakeTime() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

function memoryCache(entries = new Map<string, string>()): OverpassCache & { entries: Map<string, string> } {
  return {
    entries,
    where: (key) => `memory:${key}`,
    read: async (key) => entries.get(key),
    write: async (key, body) => {
      entries.set(key, body);
    },
  };
}

const SETTINGS: OverpassSettings = { urls: [A, B], queryTimeoutSeconds: 180, httpTimeoutMs: 240_000, retries: 2, pauseMs: 2000, userAgent: 'test-agent/1' };

function client(net: ReturnType<typeof network>, options: Partial<OverpassClientOptions> = {}) {
  const time = fakeTime();
  const logs: string[] = [];
  const overpass = createOverpassClient({
    settings: SETTINGS,
    fetch: net.fetch,
    sleep: time.sleep,
    now: time.now,
    random: () => 0.5,
    log: (line) => logs.push(line),
    ...options,
  });
  return { overpass, time, logs };
}

const request = (extra: object = {}) => ({ label: 'metro', query: QUERY, cache: true, ...extra });

describe('Overpass client', () => {
  it('posts the query as data= with the User-Agent and gives the parsed answer and the mirror', async () => {
    const net = network(ok());
    const { overpass, time } = client(net);
    const got = await overpass.request(request());
    expect(got).toEqual({ json: JSON.parse(answer()), bytes: Buffer.byteLength(answer()), endpoint: A });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe(A);
    expect(net.calls[0]!.query).toBe(QUERY);
    expect(net.calls[0]!.headers.get('user-agent')).toBe('test-agent/1');
    expect(net.calls[0]!.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
    expect(time.sleeps).toEqual([]);
  });

  it('retries 504 on the same mirror after 5 s plus jitter', async () => {
    const net = network(status(504, errorPage('runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::timeout.')), ok());
    const { overpass, time, logs } = client(net);
    expect((await overpass.request(request())).endpoint).toBe(A);
    expect(net.calls.map((c) => c.url)).toEqual([A, A]);
    expect(time.sleeps).toEqual([5500]); // 5 s + 10 % (random 0.5 of up to 20 %)
    expect(logs.join('\n')).toContain('HTTP 504: Error: runtime error: open64');
  });

  it('grows the pause 5 → 15 → 45 s and then turns to the next mirror', async () => {
    const net = network(status(502), status(503), status(504), new Error('fetch failed'), ok());
    const { overpass, time } = client(net, { settings: { ...SETTINGS, retries: 3 } });
    expect((await overpass.request(request())).endpoint).toBe(B);
    expect(net.calls.map((c) => c.url)).toEqual([A, A, A, A, B]);
    expect(time.sleeps).toEqual([5500, 16500, 49500, 2000]);
  });

  it('waits Retry-After on 429, 30 s without it', async () => {
    const net = network(status(429, 'rate_limited', { 'retry-after': '7' }), status(429), ok());
    const { overpass, time } = client(net);
    expect((await overpass.request(request())).endpoint).toBe(A);
    expect(net.calls.map((c) => c.url)).toEqual([A, A, A]);
    expect(time.sleeps).toEqual([7000, 30_000]);
  });

  it('waits until the HTTP date of Retry-After, and at most 5 minutes', async () => {
    const time = fakeTime();
    const inAMinute = new Date(time.now() + 42_000).toUTCString();
    const past = new Date(time.now() - 60_000).toUTCString();
    const net = network(status(429, '', { 'retry-after': inAMinute }), status(429, '', { 'retry-after': '3600' }), status(429, '', { 'retry-after': past }), ok());
    const overpass = createOverpassClient({ settings: { ...SETTINGS, retries: 3 }, fetch: net.fetch, sleep: time.sleep, now: time.now, random: () => 0.5 });
    expect((await overpass.request(request())).endpoint).toBe(A);
    // A date in the past waits no more; the pause between two requests still holds.
    expect(time.sleeps).toEqual([42_000, 300_000, 0, 2000]);
  });

  it('turns to the next mirror when the answer says the server gave up', async () => {
    for (const remark of [
      'runtime error: Query timed out in "query" at line 1 after 180 seconds.',
      'runtime error: Query run out of memory using about 2048 MB of RAM.',
    ]) {
      const net = network(ok(answer([], { remark })), ok());
      const { overpass, time } = client(net);
      expect((await overpass.request(request())).endpoint).toBe(B);
      expect(net.calls.map((c) => c.url)).toEqual([A, B]);
      expect(time.sleeps).toEqual([2000]); // only the pause between two requests
    }
  });

  it('retries an answer that is empty, cut or not JSON', async () => {
    const cut = answer().slice(0, 40);
    const net = network(ok(''), ok(cut), ok());
    const { overpass, logs } = client(net);
    expect((await overpass.request(request())).endpoint).toBe(A);
    expect(net.calls.map((c) => c.url)).toEqual([A, A, A]);
    expect(logs.join('\n')).toContain('empty answer');
    expect(logs.join('\n')).toContain('the answer is not JSON or is cut');
  });

  it('passes over a mirror whose data are older than notBefore, without retrying it', async () => {
    const stale = answer(undefined, { osm3s: { timestamp_osm_base: '2026-09-22T08:45:51Z' } });
    const net = network(ok(stale), ok());
    const { overpass, logs } = client(net);
    expect((await overpass.request(request({ notBefore: T }))).endpoint).toBe(B);
    expect(net.calls.map((c) => c.url)).toEqual([A, B]);
    expect(logs.join('\n')).toContain(`the mirror has data up to 2026-09-22T08:45:51Z only, older than ${T}; trying the next mirror`);
  });

  it('turns to the next mirror at once when an answer does not tell the time of its data and notBefore is given', async () => {
    const net = network(ok(JSON.stringify({ elements: [] })), ok());
    const { overpass } = client(net);
    expect((await overpass.request(request({ notBefore: T }))).endpoint).toBe(B);
    expect(net.calls.map((c) => c.url)).toEqual([A, B]);
  });

  it('strips control characters from what a server says before logging it', async () => {
    const esc = String.fromCharCode(27);
    const bell = String.fromCharCode(7);
    const net = network(status(503, `${esc}[2J${esc}]0;owned${bell}busy${esc}[31m now`), ok(answer([], { remark: `runtime error: ${esc}[1mtimed out` })), ok());
    const { overpass, logs } = client(net);
    // 503 on A: again on A, which gives up; B answers.
    expect((await overpass.request(request())).endpoint).toBe(B);
    for (const line of logs) expect(line).not.toMatch(/\p{Cc}/u);
    const text = logs.join('\n');
    expect(text).toContain('HTTP 503: [2J ]0;owned busy [31m now');
    expect(text).toContain('the server gave up: runtime error: [1mtimed out');
  });

  it('fails at once on 400 with the text of the server', async () => {
    const net = network(status(400, errorPage('line 1: parse error: Unknown type &quot;nod&quot;')), ok());
    const { overpass } = client(net);
    await expect(overpass.request(request())).rejects.toThrow('metro: a.example.org rejected the query: HTTP 400: Error: line 1: parse error: Unknown type "nod"');
    expect(net.calls).toHaveLength(1);
  });

  it('turns to the next mirror at once on another client error', async () => {
    const net = network(status(403, 'Forbidden'), ok());
    const { overpass } = client(net);
    expect((await overpass.request(request())).endpoint).toBe(B);
    expect(net.calls.map((c) => c.url)).toEqual([A, B]);
  });

  it('says what every mirror answered when all of them fail', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const net = network(status(504), status(504), status(504), timeout, refused, ok('{"elem'));
    const { overpass } = client(net);
    await expect(overpass.request(request())).rejects.toMatchObject({
      message: [
        'metro: no Overpass mirror gave a usable answer:',
        '  - a.example.org: HTTP 504',
        '  - a.example.org: HTTP 504',
        '  - a.example.org: HTTP 504',
        '  - b.example.org: no answer in 240.0 s',
        '  - b.example.org: network error: fetch failed (ECONNREFUSED)',
        '  - b.example.org: the answer is not JSON or is cut (6 B)',
      ].join('\n'),
    });
    expect(net.left()).toBe(0);
  });

  it('turns to the next mirror at once on suspiciously little data — a dated answer does not change — then fails', async () => {
    const net = network(ok(), ok());
    const { overpass, time } = client(net);
    const check = (json: unknown) => {
      const found = (json as { elements: unknown[] }).elements.length;
      return found < 50 ? `suspiciously little data: metro has ${found} OSM object, min_features is 50` : undefined;
    };
    await expect(overpass.request(request({ check }))).rejects.toThrow(
      [
        'metro: no Overpass mirror gave a usable answer:',
        '  - a.example.org: suspiciously little data: metro has 1 OSM object, min_features is 50',
        '  - b.example.org: suspiciously little data: metro has 1 OSM object, min_features is 50',
      ].join('\n'),
    );
    expect(net.calls.map((c) => c.url)).toEqual([A, B]);
    expect(time.sleeps).toEqual([2000]); // no backoff: only the pause between two requests
  });

  it('turns to the next mirror at once when a check throws', async () => {
    const net = network(ok(), ok());
    const { overpass } = client(net);
    let calls = 0;
    const check = () => {
      calls++;
      if (calls === 1) throw new Error('malformed Overpass answer: elements[0].id: invalid');
      return undefined;
    };
    expect((await overpass.request(request({ check }))).endpoint).toBe(B);
    expect(net.calls.map((c) => c.url)).toEqual([A, B]);
  });

  it('asks strictly one request at a time, OVERPASS_PAUSE_MS apart', async () => {
    const net = network(ok(), ok(), ok());
    const { overpass, time } = client(net);
    const queries = ['q1', 'q2', 'q3'].map((q) => overpass.request({ label: q, query: `${QUERY}${q}`, cache: false }));
    await Promise.all(queries);
    expect(net.overlapped()).toBe(false);
    expect(net.calls.map((c) => c.query.slice(-2))).toEqual(['q1', 'q2', 'q3']);
    expect(time.sleeps).toEqual([2000, 2000]);
  });

  it('asks the mirror that answered last first', async () => {
    const net = network(status(404), ok(), ok());
    const { overpass } = client(net);
    await overpass.request(request());
    await overpass.request({ label: 'transit', query: `${QUERY} `, cache: true });
    expect(net.calls.map((c) => c.url)).toEqual([A, B, B]);
  });
});

describe('Overpass cache', () => {
  it('keeps the raw answer by the sha256 of the query without its timeout and reads it back without the network', async () => {
    const cache = memoryCache();
    const first = client(network(ok()), { cache });
    await first.overpass.request(request());
    const key = createHash('sha256').update(QUERY.replace('[timeout:180]', '')).digest('hex');
    expect(cacheKey(QUERY)).toBe(key);
    expect(cache.entries.get(key)).toBe(answer());

    const net = network();
    const second = client(net, { cache });
    expect(await second.overpass.request(request())).toEqual({ json: JSON.parse(answer()), bytes: Buffer.byteLength(answer()), endpoint: undefined });
    expect(net.calls).toHaveLength(0);
  });

  it('finds an answer whatever the timeout of the query: a longer OVERPASS_QUERY_TIMEOUT_S keeps the cache', async () => {
    const cache = memoryCache();
    await client(network(ok()), { cache }).overpass.request(request());
    const net = network();
    const { overpass } = client(net, { cache, offline: true });
    const longer = QUERY.replace('[timeout:180]', '[timeout:600]');
    expect(cacheKey(longer)).toBe(cacheKey(QUERY));
    expect((await overpass.request(request({ query: longer }))).json).toEqual(JSON.parse(answer()));
    expect(net.calls).toHaveLength(0);
  });

  it('reads an answer kept under the sha256 of the whole query, as the first caches kept them', async () => {
    const cache = memoryCache(new Map([[legacyCacheKey(QUERY), answer()]]));
    expect(legacyCacheKey(QUERY)).toBe(createHash('sha256').update(QUERY).digest('hex'));
    const net = network();
    const { overpass } = client(net, { cache, offline: true });
    expect((await overpass.request(request())).json).toEqual(JSON.parse(answer()));
    expect(net.calls).toHaveLength(0);
    // Found under the new key first when both are there.
    cache.entries.set(cacheKey(QUERY), answer([]));
    expect((await overpass.request(request())).json).toEqual(JSON.parse(answer([])));
  });

  it('copies an answer found under the old key to its new key, so that another timeout finds it too', async () => {
    const cache = memoryCache(new Map([[legacyCacheKey(QUERY), answer()]]));
    const net = network();
    const { overpass, logs } = client(net, { cache, offline: true });
    expect((await overpass.request(request())).json).toEqual(JSON.parse(answer()));
    expect(cache.entries.get(cacheKey(QUERY))).toBe(answer());
    expect(logs).toContain(`metro: the cached answer is copied to its new key memory:${cacheKey(QUERY)}`);
    const longer = QUERY.replace('[timeout:180]', '[timeout:600]');
    expect(legacyCacheKey(longer)).not.toBe(legacyCacheKey(QUERY));
    expect((await overpass.request(request({ query: longer }))).json).toEqual(JSON.parse(answer()));
    expect(net.calls).toHaveLength(0);
  });

  it('keeps an answer found under the old key when its copy cannot be written, with a warning', async () => {
    const entries = new Map([[legacyCacheKey(QUERY), answer()]]);
    const cache: OverpassCache = {
      where: (key) => `/cache/${key}.json`,
      read: async (key) => entries.get(key),
      write: async () => {
        throw new Error('EACCES: permission denied');
      },
    };
    const { overpass, logs } = client(network(), { cache, offline: true });
    expect((await overpass.request(request())).json).toEqual(JSON.parse(answer()));
    expect(logs).toContain(`WARNING: metro: the cached answer is not copied to its new key (/cache/${cacheKey(QUERY)}.json): EACCES: permission denied`);
  });

  it('keeps an answer it cannot cache, with a warning', async () => {
    const cache: OverpassCache = {
      where: (key) => `/cache/${key}.json`,
      read: async () => undefined,
      write: async () => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      },
    };
    const { overpass, logs } = client(network(ok()), { cache });
    expect((await overpass.request(request())).endpoint).toBe(A);
    expect(logs).toContain(`WARNING: metro: the answer is not cached (/cache/${cacheKey(QUERY)}.json): ENOSPC: no space left on device`);
  });

  it('does not cache the probe, nor an answer it could not use', async () => {
    const cache = memoryCache();
    const { overpass } = client(network(ok(), status(400, 'bad')), { cache });
    await overpass.request({ label: 'probe', query: '[out:json][timeout:25];out;', cache: false });
    await expect(overpass.request(request())).rejects.toThrow('HTTP 400');
    expect(cache.entries.size).toBe(0);
  });

  it('asks again for a cached answer it cannot use', async () => {
    const cache = memoryCache(new Map([[cacheKey(QUERY), '{"elements": [']]));
    const net = network(ok());
    const { overpass } = client(net, { cache });
    expect((await overpass.request(request())).endpoint).toBe(A);
    expect(cache.entries.get(cacheKey(QUERY))).toBe(answer());
  });

  it('offline, never touches the network: a missing answer is an error naming the query', async () => {
    const net = network(ok());
    const { overpass } = client(net, { cache: memoryCache(), offline: true });
    await expect(overpass.request(request())).rejects.toThrow(`metro: offline, and no cached answer (memory:${cacheKey(QUERY)}) to the query ${QUERY}`);
    await expect(overpass.request({ label: 'probe', query: '[out:json][timeout:25];out;', cache: false })).rejects.toThrow('probe: offline');
    expect(net.calls).toHaveLength(0);
  });

  it('asks again for a cached answer of older data than notBefore', async () => {
    const stale = answer(undefined, { osm3s: { timestamp_osm_base: '2026-09-22T08:45:51Z' } });
    const cache = memoryCache(new Map([[cacheKey(QUERY), stale]]));
    const net = network(ok());
    const { overpass, logs } = client(net, { cache });
    expect((await overpass.request(request({ notBefore: T }))).endpoint).toBe(A);
    expect(logs[0]).toBe(`metro: the cached answer is unusable (the mirror has data up to 2026-09-22T08:45:51Z only, older than ${T}), asking again`);
    expect(cache.entries.get(cacheKey(QUERY))).toBe(answer());
  });

  it('offline, refuses a cached answer it cannot use', async () => {
    const cache = memoryCache(new Map([[cacheKey(QUERY), answer([])]]));
    const { overpass } = client(network(), { cache, offline: true });
    const check = () => 'suspiciously little data: metro has 0 OSM objects, min_features is 50';
    await expect(overpass.request(request({ check }))).rejects.toThrow('the cached answer memory:');
  });

  it('leaves no partial file behind when an entry cannot be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otkryvay-overpass-'));
    // A directory where the entry should be: the rename fails.
    await mkdir(join(dir, `${cacheKey(QUERY)}.json`));
    await expect(fileCache(dir).write(cacheKey(QUERY), answer())).rejects.toThrow();
    expect(await readdir(dir)).toEqual([`${cacheKey(QUERY)}.json`]);
  });

  it('keeps the entries as files named by the sha256 of the query', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'otkryvay-overpass-')), 'cache');
    const cache = fileCache(dir);
    expect(await cache.read(cacheKey(QUERY))).toBeUndefined();
    await cache.write(cacheKey(QUERY), answer());
    expect(await readdir(dir)).toEqual([`${cacheKey(QUERY)}.json`]);
    expect(await readFile(join(dir, `${cacheKey(QUERY)}.json`), 'utf8')).toBe(answer());
    expect(await cache.read(cacheKey(QUERY))).toBe(answer());
  });
});

describe('Overpass settings', () => {
  it('has the defaults of doc-3 §4.3 and a User-Agent without personal data', () => {
    const settings = overpassSettings({}, '0.1.0');
    expect(settings).toEqual({
      urls: DEFAULT_OVERPASS_URLS,
      queryTimeoutSeconds: 180,
      httpTimeoutMs: 240_000,
      retries: 2,
      pauseMs: 2000,
      userAgent: 'otkryvay-location-index/0.1.0 (+https://github.com/trade-stasvinokur/student_hackathon_max_2026)',
    });
    // The tool and where to read about it: no e-mail, no names, nothing but the project.
    expect(defaultUserAgent('1.2.3')).toMatch(/^otkryvay-location-index\/1\.2\.3 \(\+https:\/\/github\.com\/[\w-]+\/[\w-]+\)$/);
    expect(defaultUserAgent('1.2.3')).not.toMatch(/@|mailto|stasvinokur@|Stanislav|Vinokur /i);
  });

  it('reads OVERPASS_* variables; an empty one keeps the default', () => {
    const settings = overpassSettings(
      {
        OVERPASS_URLS: ` ${B} , ${A},`,
        OVERPASS_QUERY_TIMEOUT_S: '300',
        OVERPASS_HTTP_TIMEOUT_MS: '360000',
        OVERPASS_RETRIES: '0',
        OVERPASS_PAUSE_MS: '',
        OVERPASS_USER_AGENT: 'my-tool/2',
        HOME: '/home/someone',
      },
      '0.1.0',
    );
    expect(settings).toEqual({ urls: [B, A], queryTimeoutSeconds: 300, httpTimeoutMs: 360_000, retries: 0, pauseMs: 2000, userAgent: 'my-tool/2' });
  });

  it('refuses settings that make no sense', () => {
    expect(() => overpassSettings({ OVERPASS_RETRIES: '-1' }, '0.1.0')).toThrow('OVERPASS_RETRIES');
    expect(() => overpassSettings({ OVERPASS_QUERY_TIMEOUT_S: 'soon' }, '0.1.0')).toThrow('OVERPASS_QUERY_TIMEOUT_S');
    expect(() => overpassSettings({ OVERPASS_URLS: ',' }, '0.1.0')).toThrow('OVERPASS_URLS lists no mirror');
    expect(() => overpassSettings({ OVERPASS_URLS: 'ftp://mirror.example.org' }, '0.1.0')).toThrow('is not an http(s) URL');
  });
});
