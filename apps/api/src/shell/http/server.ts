import fastifySwagger from '@fastify/swagger';
import { CORE_VERSION } from '@otkryvay/core';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { registerApi, type ApiDeps, INIT_DATA_HEADER } from './api.js';
import { registerWebhookRoute, type WebhookDeps } from './webhook.js';

const HealthSchema = z.object({ status: z.enum(['ok', 'degraded']), db: z.enum(['up', 'down']), core: z.string() });

export interface ServerDeps {
  /** Resolves when the database answers, rejects otherwise. */
  checkDb: () => Promise<void>;
  /** Present only when BOT_MODE=webhook. */
  webhook?: WebhookDeps;
  /** Mini-app REST API; omitted in tests that only need health/webhook. */
  api?: ApiDeps;
}

export async function buildServer(deps: ServerDeps, options: FastifyServerOptions = {}) {
  const app = Fastify(options);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({ error: 'bad_request', message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: (error as Error).message });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Открывай API',
        description:
          'REST API мини-приложения «Открывай» в MAX. Все методы /api требуют заголовок X-Max-Init-Data — ' +
          'строку WebApp.initData из MAX Bridge; подпись проверяется по токену бота (HMAC-SHA256).',
        version: CORE_VERSION,
      },
      servers: [{ url: 'https://otkryvay.stasvinokur.ru', description: 'Публичный стенд' }],
      components: {
        securitySchemes: {
          maxInitData: { type: 'apiKey', in: 'header', name: INIT_DATA_HEADER, description: 'WebApp.initData из MAX Bridge' },
          maxWebhookSecret: {
            type: 'apiKey',
            in: 'header',
            name: 'x-max-bot-api-secret',
            description: 'Секрет подписки, который MAX передаёт при доставке обновлений',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  // Polled by the container healthcheck every few seconds: log failures only.
  app.get(
    '/health',
    {
      logLevel: 'warn',
      schema: {
        operationId: 'health',
        summary: 'Проверка живости и доступности БД',
        tags: ['service'],
        security: [],
        response: { 200: HealthSchema, 503: HealthSchema },
      },
    },
    async (request, reply) => {
      try {
        await deps.checkDb();
        return { status: 'ok' as const, db: 'up' as const, core: CORE_VERSION };
      } catch (error) {
        request.log.error({ err: error }, 'health check: database is unreachable');
        return reply.code(503).send({ status: 'degraded' as const, db: 'down' as const, core: CORE_VERSION });
      }
    },
  );

  if (deps.webhook) {
    registerWebhookRoute(app, deps.webhook);
  }
  if (deps.api) {
    await registerApi(app, deps.api);
  }

  return app;
}
