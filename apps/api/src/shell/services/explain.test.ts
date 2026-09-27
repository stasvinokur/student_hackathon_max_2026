import type { ChatMessage, Profile } from '@otkryvay/core';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../clock.js';
import { loadRulesPack } from '../content/load.js';
import { createPackRegistry } from '../content/packs.js';
import type { Database } from '../db/client.js';
import { createRepositories, type Repositories } from '../db/repositories.js';
import { openTestDatabase, truncateAll } from '../db/test-database.js';
import { buildServer } from '../http/server.js';
import { signInitData } from '../http/test-init-data.js';
import type { LlmClient } from '../llm/client.js';
import { createExplainService } from './explain.js';
import { createRouteService, type RouteService } from './routes.js';

const database: Database | null = await openTestDatabase();
const USER = 1001;
const BOT_TOKEN = 'test-bot-token';
const clock = fixedClock('2026-09-18T09:00:00Z');
const log = pino({ level: 'silent' });
const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 0, sells_food: false, opening_date: '2026-12-15' };

describe.skipIf(!database)('«Объясни проще» (integration)', () => {
  let repos: Repositories;
  let routes: RouteService;

  beforeAll(async () => {
    repos = createRepositories(database!.db);
    routes = createRouteService({ repos, packs: createPackRegistry([await loadRulesPack('kazan-coffee')]), clock });
  });
  beforeEach(async () => {
    await truncateAll(database!);
    await repos.users.touch(USER);
    await routes.createRoute(USER, profile);
  });
  afterAll(async () => {
    await database?.close();
  });

  async function server(llm: LlmClient | null) {
    const explain = createExplainService({ routes, llm, log });
    return buildServer({
      checkDb: async () => {},
      api: { routes, explain, recordEvent: (t, u, p) => repos.events.record(t, u, p), clock, auth: { botToken: BOT_TOKEN, maxAgeSeconds: 86_400, devBypass: false } },
    });
  }
  const headers = { 'x-max-init-data': signInitData(BOT_TOKEN, USER, Math.floor(clock.now().getTime() / 1000)) };

  it('is off by default: the feature flag is false and the endpoint answers 503', async () => {
    const app = await server(null);
    expect((await app.inject({ method: 'GET', url: '/api/config', headers })).json()).toEqual({ features: { explain: false, locationIndex: [] } });
    const res = await app.inject({ method: 'POST', url: '/api/tasks/register-business/explain', headers });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'explanation_unavailable' });
  });

  it('rephrases only the card text, marks it as generated with the source, and caches per pack version', async () => {
    const complete = vi.fn(async (_messages: ChatMessage[]) => '  Сначала оформите ИП — без этого ничего не выйдет.  ');
    const app = await server({ complete });
    expect((await app.inject({ method: 'GET', url: '/api/config', headers })).json()).toEqual({ features: { explain: true, locationIndex: [] } });

    const first = await app.inject({ method: 'POST', url: '/api/tasks/register-business/explain', headers });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      text: 'Сначала оформите ИП — без этого ничего не выйдет.',
      generated: true,
      source: { url: expect.stringContaining('consultant.ru') },
    });
    const prompt = complete.mock.calls[0]![0]!.map((m) => m.content).join('\n');
    expect(prompt).toContain('Шаг: Зарегистрировать ИП или ООО с кодами общепита');
    expect(prompt).not.toContain(String(USER)); // no user data leaves the service

    await app.inject({ method: 'POST', url: '/api/tasks/register-business/explain', headers });
    expect(complete).toHaveBeenCalledTimes(1); // cached
  });

  it('answers 503 on a timeout or an empty answer, and 404 for a task outside the route', async () => {
    const timeout = await server({ complete: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } });
    expect((await timeout.inject({ method: 'POST', url: '/api/tasks/register-business/explain', headers })).statusCode).toBe(503);

    const empty = await server({ complete: async () => '   ' });
    expect((await empty.inject({ method: 'POST', url: '/api/tasks/register-business/explain', headers })).statusCode).toBe(503);
    expect((await empty.inject({ method: 'POST', url: '/api/tasks/hire-staff/explain', headers })).statusCode).toBe(404);
  });
});
