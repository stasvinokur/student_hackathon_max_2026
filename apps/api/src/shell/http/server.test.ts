import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

describe('GET /health', () => {
  it('returns 200 when the database answers', async () => {
    const app = await buildServer({ checkDb: async () => {} });
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'up' });
  });

  it('returns 503 when the database is unreachable', async () => {
    const app = await buildServer({
      checkDb: async () => {
        throw new Error('connection refused');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', db: 'down' });
  });
});
