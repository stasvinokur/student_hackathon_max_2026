import type { Update } from '@maxhub/max-bot-api/types';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { WEBHOOK_PATH } from './webhook.js';

const SECRET = 'test-secret-123';
const update = { update_type: 'bot_started', timestamp: 1, chat_id: 1, user: { user_id: 42 } };

async function setup() {
  const handleUpdate = vi.fn(async (_update: Update) => {});
  const app = await buildServer({ checkDb: async () => {}, webhook: { secret: SECRET, handleUpdate } });
  return { app, handleUpdate };
}

describe(`POST ${WEBHOOK_PATH}`, () => {
  it('rejects a request without the secret header', async () => {
    const { app, handleUpdate } = await setup();
    const res = await app.inject({ method: 'POST', url: WEBHOOK_PATH, payload: update });
    expect(res.statusCode).toBe(401);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('rejects a request with a wrong secret', async () => {
    const { app, handleUpdate } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: { 'x-max-bot-api-secret': 'wrong-secret-999' },
      payload: update,
    });
    expect(res.statusCode).toBe(401);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('rejects a body that is not an update', async () => {
    const { app, handleUpdate } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: { 'x-max-bot-api-secret': SECRET },
      payload: { hello: 'world' },
    });
    expect(res.statusCode).toBe(400);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('accepts an update with the correct secret and hands it to the handler', async () => {
    const { app, handleUpdate } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: { 'x-max-bot-api-secret': SECRET },
      payload: update,
    });
    expect(res.statusCode).toBe(200);
    expect(handleUpdate).toHaveBeenCalledWith(update);
  });

  it('is not exposed when webhook mode is off', async () => {
    const app = await buildServer({ checkDb: async () => {} });
    const res = await app.inject({ method: 'POST', url: WEBHOOK_PATH, payload: update });
    expect(res.statusCode).toBe(404);
  });
});
