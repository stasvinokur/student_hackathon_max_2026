import { timingSafeEqual } from 'node:crypto';
import type { Update } from '@maxhub/max-bot-api/types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const OkSchema = z.object({ ok: z.literal(true) });
const ErrorSchema = z.object({ error: z.string() });

export const WEBHOOK_PATH = '/webhook/max';
const SECRET_HEADER = 'x-max-bot-api-secret';

export interface WebhookDeps {
  secret: string;
  handleUpdate: (update: Update) => Promise<void>;
}

function isSecretValid(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== 'string') return false;
  const received = Buffer.from(header);
  const expected = Buffer.from(secret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function isUpdate(body: unknown): body is Update {
  return typeof body === 'object' && body !== null && typeof (body as { update_type?: unknown }).update_type === 'string';
}

export function registerWebhookRoute(app: FastifyInstance, deps: WebhookDeps): void {
  app.post(
    WEBHOOK_PATH,
    {
      schema: {
        operationId: 'maxWebhook',
        summary: 'Приём обновлений MAX Bot API (только при BOT_MODE=webhook)',
        tags: ['bot'],
        security: [{ maxWebhookSecret: [] }],
        response: { 200: OkSchema, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (request, reply) => {
    if (!isSecretValid(request.headers[SECRET_HEADER], deps.secret)) {
      request.log.warn('MAX webhook call with a missing or invalid secret');
      return reply.code(401).send({ error: 'invalid secret' });
    }
    if (!isUpdate(request.body)) {
      return reply.code(400).send({ error: 'invalid update' });
    }
    // Acknowledge immediately: MAX retries slow deliveries. The handler logs its own failures.
    void deps.handleUpdate(request.body);
    return { ok: true as const };
    },
  );
}
