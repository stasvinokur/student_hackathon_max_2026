import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { OpenAPIV3_1 } from 'openapi-types';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock.js';
import { CONTENT_DIR, loadRulesPack } from '../content/load.js';
import { loadLocationIndexes, type LocationIndexStore } from '../content/location-index.js';
import type { RouteService } from '../services/routes.js';
import { buildServer } from './server.js';
import { signInitData } from './test-init-data.js';

// The «Карта» tab over HTTP: the committed kazan-coffee snapshot, its entry in /api/config and the map events.
// No database: none of these endpoints touches it.

const BOT_TOKEN = 'test-bot-token';
const clock = fixedClock('2026-09-18T09:00:00Z');
const USER = 1001;
const headers = { 'x-max-init-data': signInitData(BOT_TOKEN, USER, Math.floor(clock.now().getTime() / 1000)) };
const SNAPSHOT_URL = '/api/packs/kazan-coffee/location-index';
const STALE = '"0000000000000000"';

interface RecordedEvent {
  type: string;
  userId: number;
  props: Record<string, unknown>;
}

const events: RecordedEvent[] = [];

function server(locationIndexes?: LocationIndexStore) {
  const unused = () => {
    throw new Error('the map endpoints do not use the route service');
  };
  return buildServer({
    checkDb: async () => {},
    api: {
      routes: new Proxy({}, { get: () => unused }) as RouteService,
      ...(locationIndexes ? { locationIndexes } : {}),
      recordEvent: async (type, userId, props) => void events.push({ type, userId, props }),
      clock,
      auth: { botToken: BOT_TOKEN, maxAgeSeconds: 86_400, devBypass: false },
    },
  });
}

let store: LocationIndexStore;
let file: Buffer;
let app: FastifyInstance;
/** The map is off (LOCATION_INDEX_ENABLED=false, or no valid snapshot): main.ts passes an empty store. */
let off: FastifyInstance;
/** No store at all, as openapi-spec.ts builds the server: the endpoint is registered all the same. */
let bare: FastifyInstance;

beforeAll(async () => {
  store = await loadLocationIndexes([await loadRulesPack('kazan-coffee')], pino({ level: 'silent' }));
  file = await readFile(join(CONTENT_DIR, 'kazan-coffee', 'location-index.json'));
  app = await server(store);
  await app.ready();
  off = await server(new Map());
  bare = await server();
});
afterAll(async () => {
  await app?.close();
  await off?.close();
  await bare?.close();
});

/** Servers without a snapshot; created in beforeAll, hence getters. */
const withoutSnapshots = [
  ['the map is off', () => off],
  ['the server has no location index store', () => bare],
] as const;

const get = (instance: FastifyInstance, url: string, extra: Record<string, string> = {}) =>
  instance.inject({ method: 'GET', url, headers: { ...headers, ...extra } });

describe('GET /api/packs/:packId/location-index', () => {
  it('200: the snapshot file byte for byte, as JSON, with a strong ETag and no-cache', async () => {
    // The route declares a 200 schema, so an object would go through the zod serializer and come out rewritten.
    const spec = app.swagger() as OpenAPIV3_1.Document;
    expect(spec.paths?.['/api/packs/{packId}/location-index']?.get?.responses?.['200']).toHaveProperty('content.application/json.schema');

    const res = await get(app, SNAPSHOT_URL);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers.etag).toBe(store.get('kazan-coffee')?.etag);
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers['content-length']).toBe(String(file.length));
    expect(res.rawPayload.equals(file), 'the body must be the snapshot file as is').toBe(true);
    expect(res.json()).toMatchObject({ format: 'otkryvay.location-index/1', pack: 'kazan-coffee' });
  });

  it.each([
    ['the ETag', (etag: string) => etag],
    ['a list with the ETag', (etag: string) => `${STALE}, ${etag}`],
    ['the ETag marked weak', (etag: string) => `W/${etag}`],
    ['*', () => '*'],
  ])('304 without a body when If-None-Match has %s', async (_, ifNoneMatch) => {
    const etag = store.get('kazan-coffee')!.etag;
    const res = await get(app, SNAPSHOT_URL, { 'if-none-match': ifNoneMatch(etag) });
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe('');
    expect(res.headers.etag).toBe(etag);
    expect(res.headers['cache-control']).toBe('private, no-cache');
  });

  it('200 with the whole snapshot when If-None-Match has only other tags', async () => {
    for (const ifNoneMatch of [STALE, `W/${STALE}, "1111111111111111"`]) {
      const res = await get(app, SNAPSHOT_URL, { 'if-none-match': ifNoneMatch });
      expect(res.statusCode, ifNoneMatch).toBe(200);
      expect(res.rawPayload.equals(file), ifNoneMatch).toBe(true);
    }
  });

  it('404 location_index_not_found for a pack without a snapshot', async () => {
    const res = await get(app, '/api/packs/no-such-pack/location-index');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'location_index_not_found', message: 'Для этого пакета нет индекса мест.' });
  });

  it.each(withoutSnapshots)('404 when %s', async (_, instance) => {
    const res = await get(instance(), SNAPSHOT_URL);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'location_index_not_found' });
  });

  it('400 bad_request for a malformed pack id', async () => {
    for (const packId of ['Bad_Id!', 'kazan--coffee', 'a'.repeat(65)]) {
      const res = await get(app, `/api/packs/${packId}/location-index`);
      expect(res.statusCode, packId).toBe(400);
      expect(res.json()).toMatchObject({ error: 'bad_request' });
    }
  });

  it('records no event: the mini-app reports map_opened itself', async () => {
    events.length = 0;
    const etag = store.get('kazan-coffee')!.etag;
    const answers = [
      await get(app, SNAPSHOT_URL),
      await get(app, SNAPSHOT_URL, { 'if-none-match': etag }),
      await get(app, '/api/packs/no-such-pack/location-index'),
    ];
    expect(answers.map((res) => res.statusCode)).toEqual([200, 304, 404]);
    expect(events).toEqual([]);
  });

  it('401 without initData, before the pack id is validated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/packs/Bad_Id!/location-index' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });
});

describe('GET /api/config', () => {
  it('lists the loaded location indexes: pack, snapshot version and the steps the map helps with', async () => {
    const { version } = store.get('kazan-coffee')!.index;
    expect((await get(app, '/api/config')).json()).toEqual({
      features: { explain: false, locationIndex: [{ pack: 'kazan-coffee', version, actions: ['lease-premises'] }] },
    });
  });

  it.each(withoutSnapshots)('lists none when %s', async (_, instance) => {
    expect((await get(instance(), '/api/config')).json()).toEqual({ features: { explain: false, locationIndex: [] } });
  });
});

describe('POST /api/events', () => {
  it('accepts the map events with their props', async () => {
    events.length = 0;
    const sent = [
      { type: 'map_opened', props: { source: 'tab' } },
      { type: 'location_cell_opened', props: { cell: 1234, version: '20260924T084102Z-53b5a120', from: 'map' } },
      { type: 'place_opened', props: { place: 'cgie-rt', from: 'list' } },
      { type: 'map_failed', props: { kind: 'chunk' } },
      { type: 'map_failed', props: { kind: 'tiles', stage: 'style', basemapTiles: 0, status: 503 } },
    ];
    for (const payload of sent) {
      const res = await app.inject({ method: 'POST', url: '/api/events', headers, payload });
      expect(res.statusCode, payload.type).toBe(202);
    }
    expect(events).toEqual(sent.map((e) => ({ ...e, userId: USER })));
  });
});
