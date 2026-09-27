import { createHmac } from 'node:crypto';
import {
  KEBAB_ID,
  LocationIndexSchema,
  ReadinessSchema,
  RouteViewSchema,
  TaskDetailSchema,
  TaskSummarySchema,
  verifyInitData,
  type HmacSha256,
} from '@otkryvay/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { LocationIndexStore } from '../content/location-index.js';
import type { ExplainService } from '../services/explain.js';
import type { RouteService } from '../services/routes.js';

export const INIT_DATA_HEADER = 'x-max-init-data';
export const DEV_USER_HEADER = 'x-dev-user-id';

/** Client-side analytics events the mini-app may report. */
export const CLIENT_EVENT_TYPES = [
  'miniapp_opened',
  'route_viewed',
  'task_opened',
  'source_opened',
  'share_clicked',
  // The «Карта» tab: the map opened ({ source: 'tab' | 'task' }), a cell card ({ cell, version } — the number is a
  // cell of that snapshot), a place card ({ place }), both with { from: 'map' | 'list' } (a tap on the map, or a list
  // or a step), and a failure of the map, once per failure
  // ({ kind: 'chunk' | 'render' | 'timeout' | 'invalid_snapshot' | 'network' }, and for the MapLibre canvas, which
  // then gives way to the lists: 'webgl' | 'init' | 'map_chunk' | 'map_chunk_timeout' | 'tiles' | 'tiles_timeout' |
  // 'context_lost' | 'draw', with { stage, basemapTiles, status } for the tiles).
  'map_opened',
  'location_cell_opened',
  'place_opened',
  'map_failed',
] as const;

export interface ApiDeps {
  routes: RouteService;
  /** Optional «Объясни проще»; omitted or disabled — the button is hidden and the endpoint answers 503. */
  explain?: ExplainService;
  /** Location index snapshots of the «Карта» tab by pack id; omitted or empty — the map is off and the endpoint answers 404. */
  locationIndexes?: LocationIndexStore;
  recordEvent: (type: string, userId: number, props: Record<string, unknown>) => Promise<void>;
  clock: Clock;
  auth: {
    /** Bot token used to verify initData signatures; without it every request is 401. */
    botToken: string | undefined;
    /** Launch data older than this is rejected. */
    maxAgeSeconds: number;
    /** Accept X-Dev-User-Id instead of initData. Only ever true when NODE_ENV=development. */
    devBypass: boolean;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** MAX user id proven by the initData signature. */
    userId: number;
  }
}

const hmacSha256: HmacSha256 = (key, message) => createHmac('sha256', key).update(message).digest();

const ErrorSchema = z.object({ error: z.string(), message: z.string().optional() });
const TaskIdParams = z.object({ id: z.string().regex(/^[a-z0-9-]{1,64}$/).describe('Action id from the rules pack') });
const security = [{ maxInitData: [] }];

const notFound = (error: 'route_not_found' | 'task_not_found') => ({
  error,
  message: error === 'route_not_found' ? 'Сначала пройдите вопросы в чате с ботом.' : 'Такого действия нет в вашем маршруте.',
});

const ConfigSchema = z.object({
  features: z.object({
    explain: z.boolean(),
    locationIndex: z
      .array(
        z.object({
          pack: z.string().describe('Rules pack id'),
          version: z.string().describe('Snapshot version: the time of the OpenStreetMap data and the methodology hash'),
          actions: z.array(z.string()).describe('Steps of the pack the map helps with'),
        }),
      )
      .describe('Location indexes of the «Карта» tab, served by GET /api/packs/{packId}/location-index; empty when the map is off'),
  }),
});

// ---------- location index snapshot ----------

const PackIdParams = z.object({ packId: z.string().max(64).regex(KEBAB_ID).describe('Rules pack id, e.g. kazan-coffee') });
const IfNoneMatchHeaders = z.object({
  'if-none-match': z.string().optional().describe('ETag of the snapshot the client keeps: 304 while it is current'),
});
const SNAPSHOT_CACHE_CONTROL = 'private, no-cache';
// @fastify/swagger documents the `headers` key of a response schema as response headers; zod passes it on as metadata.
const snapshotResponseHeaders = {
  ETag: {
    type: 'string',
    description:
      'Strong tag of the snapshot: the first 16 hex digits of its sha256, quoted. A compressing proxy (the stand has one) ' +
      'appends -gzip or -zstd: for a 304 send back the tag as received, with the same Accept-Encoding',
  },
  'Cache-Control': { type: 'string', description: `${SNAPSHOT_CACHE_CONTROL}: keep the snapshot, revalidate it with If-None-Match` },
};
const SnapshotResponse = LocationIndexSchema.meta({
  description: 'The snapshot file of the pack as is (content/<pack>/location-index.json): OpenStreetMap data, ODbL 1.0',
  headers: snapshotResponseHeaders,
});
const NotModifiedResponse = z.null().meta({ description: 'If-None-Match has the current ETag: no body', headers: snapshotResponseHeaders });

/** If-None-Match (RFC 9110 §13.1.2): "*" or a list of entity tags, compared weakly, so a W/ prefix does not matter. */
function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  return (header ?? '').split(',').some((part) => {
    const tag = part.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

/** Mini-app REST API under /api. Every route requires a verified MAX user. */
export async function registerApi(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  await app.register(async (api) => {
    api.decorateRequest('userId', 0);

    // onRequest runs before body parsing and validation: unauthenticated calls get 401, never 400.
    api.addHook('onRequest', async (request, reply) => {
      const devUser = request.headers[DEV_USER_HEADER];
      if (deps.auth.devBypass && typeof devUser === 'string' && /^\d+$/.test(devUser)) {
        request.userId = Number(devUser);
        return;
      }

      const initData = request.headers[INIT_DATA_HEADER];
      const result = deps.auth.botToken
        ? verifyInitData(typeof initData === 'string' ? initData : undefined, {
            botToken: deps.auth.botToken,
            nowSeconds: Math.floor(deps.clock.now().getTime() / 1000),
            maxAgeSeconds: deps.auth.maxAgeSeconds,
            hmacSha256,
          })
        : ({ ok: false, reason: 'missing' } as const);

      if (!result.ok) {
        request.log.info({ reason: result.reason }, 'mini-app request rejected');
        return reply.code(401).send({ error: 'unauthorized', message: `initData ${result.reason}` });
      }
      request.userId = result.user.id;
    });

    const r = api.withTypeProvider<ZodTypeProvider>();

    r.get(
      '/api/route',
      {
        schema: {
          operationId: 'getRoute',
          summary: 'Персональный маршрут открытия',
          tags: ['route'],
          security,
          response: { 200: RouteViewSchema, 401: ErrorSchema, 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        const view = await deps.routes.getRouteView(request.userId);
        return view ?? reply.code(404).send(notFound('route_not_found'));
      },
    );

    r.get(
      '/api/tasks/:id',
      {
        schema: {
          operationId: 'getTask',
          summary: 'Карточка действия',
          tags: ['tasks'],
          security,
          params: TaskIdParams,
          response: { 200: TaskDetailSchema, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        const task = await deps.routes.getTask(request.userId, request.params.id);
        return task ?? reply.code(404).send(notFound('task_not_found'));
      },
    );

    r.patch(
      '/api/tasks/:id',
      {
        schema: {
          operationId: 'setTaskStatus',
          summary: 'Отметить действие выполненным или вернуть в работу',
          tags: ['tasks'],
          security,
          params: TaskIdParams,
          body: z.object({ status: z.enum(['todo', 'done']) }),
          response: {
            200: z.object({ task: TaskDetailSchema, readiness: ReadinessSchema, nextStep: TaskSummarySchema.nullable() }),
            400: ErrorSchema,
            401: ErrorSchema,
            404: ErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const update = await deps.routes.setTaskStatus(request.userId, request.params.id, request.body.status);
        if (!update) {
          const hasRoute = (await deps.routes.getReadiness(request.userId)) !== null;
          return reply.code(404).send(notFound(hasRoute ? 'task_not_found' : 'route_not_found'));
        }
        await deps.recordEvent('task_status_changed', request.userId, { task: request.params.id, status: request.body.status });
        return update;
      },
    );

    r.get(
      '/api/readiness',
      {
        schema: {
          operationId: 'getReadiness',
          summary: 'Готовность к открытию',
          tags: ['route'],
          security,
          response: { 200: ReadinessSchema, 401: ErrorSchema, 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        const readiness = await deps.routes.getReadiness(request.userId);
        return readiness ?? reply.code(404).send(notFound('route_not_found'));
      },
    );

    r.get(
      '/api/config',
      {
        schema: {
          operationId: 'getConfig',
          summary: 'Включённые функции мини-приложения',
          tags: ['service'],
          security,
          response: { 200: ConfigSchema, 401: ErrorSchema },
        },
      },
      async () => ({
        features: {
          explain: deps.explain?.enabled ?? false,
          locationIndex: [...(deps.locationIndexes?.values() ?? [])].map(({ index }) => ({
            pack: index.pack,
            version: index.version,
            actions: index.linkedActions,
          })),
        },
      }),
    );

    r.post(
      '/api/tasks/:id/explain',
      {
        schema: {
          operationId: 'explainTask',
          summary: 'Объяснить карточку простыми словами (генерация ИИ, по флагу LLM_ENABLED)',
          tags: ['tasks'],
          security,
          params: TaskIdParams,
          response: {
            200: z.object({
              text: z.string(),
              generated: z.literal(true).describe('Текст сгенерирован моделью по тексту карточки; основание — source'),
              source: TaskDetailSchema.shape.source,
            }),
            400: ErrorSchema,
            401: ErrorSchema,
            404: ErrorSchema,
            503: ErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const result = deps.explain
          ? await deps.explain.explain(request.userId, request.params.id)
          : ({ status: 'unavailable' } as const);
        if (result.status === 'not_found') return reply.code(404).send(notFound('task_not_found'));
        if (result.status === 'unavailable') {
          return reply.code(503).send({ error: 'explanation_unavailable', message: 'Пояснение сейчас недоступно.' });
        }
        await deps.recordEvent('task_explained', request.userId, { task: request.params.id });
        return { text: result.text, generated: true as const, source: result.source };
      },
    );

    r.post(
      '/api/events',
      {
        schema: {
          operationId: 'recordEvent',
          summary: 'Событие аналитики из mini-app',
          tags: ['analytics'],
          security,
          body: z.object({
            type: z.enum(CLIENT_EVENT_TYPES),
            props: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])).default({}),
          }),
          response: { 202: z.object({ accepted: z.literal(true) }), 400: ErrorSchema, 401: ErrorSchema },
        },
      },
      async (request, reply) => {
        await deps.recordEvent(request.body.type, request.userId, request.body.props);
        return reply.code(202).send({ accepted: true });
      },
    );

    // Registered even without snapshots (then 404), so it is in the OpenAPI document. The 200 body is the snapshot file
    // itself: a string with a JSON content type, which Fastify sends as is, so the zod serializer never rewrites the
    // 0.5 MB snapshot and SnapshotResponse only documents it. Hence the plain instance: with the zod type provider the
    // reply would have to be the parsed object. The mini-app scores the cells itself.
    api.get<{ Params: z.infer<typeof PackIdParams>; Headers: z.infer<typeof IfNoneMatchHeaders> }>(
      '/api/packs/:packId/location-index',
      {
        schema: {
          operationId: 'getLocationIndex',
          summary: 'Снимок индекса мест (OpenStreetMap, ODbL) для вкладки «Карта»',
          tags: ['map'],
          security,
          params: PackIdParams,
          headers: IfNoneMatchHeaders,
          response: { 200: SnapshotResponse, 304: NotModifiedResponse, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        const snapshot = deps.locationIndexes?.get(request.params.packId);
        if (!snapshot) {
          return reply.code(404).send({ error: 'location_index_not_found', message: 'Для этого пакета нет индекса мест.' });
        }
        reply.header('etag', snapshot.etag).header('cache-control', SNAPSHOT_CACHE_CONTROL);
        if (matchesIfNoneMatch(request.headers['if-none-match'], snapshot.etag)) return reply.code(304).send();
        return reply.header('content-type', 'application/json; charset=utf-8').send(snapshot.body);
      },
    );
  });
}
