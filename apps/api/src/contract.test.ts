// Runs every check from DATA-API.yaml against the real server (test database, real rules pack),
// so the published contract cannot drift from the API.
import { readFile } from 'node:fs/promises';
import type { Profile } from '@otkryvay/core';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { fixedClock } from './shell/clock.js';
import { loadRulesPack } from './shell/content/load.js';
import { loadLocationIndexes } from './shell/content/location-index.js';
import { createPackRegistry } from './shell/content/packs.js';
import type { Database } from './shell/db/client.js';
import { createRepositories } from './shell/db/repositories.js';
import { openTestDatabase, truncateAll } from './shell/db/test-database.js';
import { buildServer } from './shell/http/server.js';
import { signInitData } from './shell/http/test-init-data.js';
import { createExplainService } from './shell/services/explain.js';
import { createRouteService } from './shell/services/routes.js';

interface Check {
  id: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  role: 'anonymous' | 'demo_user' | 'new_user';
  params: { path?: Record<string, string>; headers?: Record<string, string>; body?: unknown };
  expected_status: number[];
  response: { content_type: string; required_fields: string[] };
}

const contractText = await readFile(new URL('../../../DATA-API.yaml', import.meta.url), 'utf8');
const contract = parseYaml(contractText) as {
  roles: Record<string, { max_user_id?: number }>;
  checks: Check[];
};
const database: Database | null = await openTestDatabase();
const BOT_TOKEN = 'contract-test-token';
const clock = fixedClock('2026-09-18T09:00:00Z');

const initData = (userId: number) => signInitData(BOT_TOKEN, userId, Math.floor(clock.now().getTime() / 1000));

describe.skipIf(!database)('DATA-API.yaml contract', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const demoId = contract.roles.demo_user!.max_user_id!;
  const newId = contract.roles.new_user!.max_user_id!;

  beforeAll(async () => {
    await truncateAll(database!);
    const repos = createRepositories(database!.db);
    const pack = await loadRulesPack('kazan-coffee');
    const log = pino({ level: 'silent' });
    const routes = createRouteService({ repos, packs: createPackRegistry([pack]), clock });
    // demo_user exactly as seed-demo creates it: the "newbie-to-go" profile, two steps done.
    const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 0, sells_food: false, opening_date: '2026-11-17' };
    await repos.users.touch(demoId);
    const created = await routes.createRoute(demoId, profile);
    for (const done of ['support-consultation', 'register-business']) await repos.tasks.setStatus(created!.routeId, done, 'done', clock.now());

    app = await buildServer({
      checkDb: async () => {},
      webhook: { secret: 'contract-secret', handleUpdate: async () => {} },
      api: {
        routes,
        explain: createExplainService({ routes, llm: null, log }),
        locationIndexes: await loadLocationIndexes([pack], log),
        recordEvent: (t, u, p) => repos.events.record(t, u, p),
        clock,
        auth: { botToken: BOT_TOKEN, maxAgeSeconds: 86_400, devBypass: false },
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  it('lists checks for every API endpoint', () => {
    const covered = new Set(contract.checks.map((c) => `${c.method} ${c.path}`));
    for (const endpoint of ['GET /health', 'GET /api/route', 'GET /api/tasks/{id}', 'PATCH /api/tasks/{id}', 'GET /api/readiness', 'POST /api/events', 'GET /api/config', 'POST /api/tasks/{id}/explain', 'GET /api/packs/{packId}/location-index', 'POST /webhook/max']) {
      expect(covered, endpoint).toContain(endpoint);
    }
  });

  it('gives demo_user a forecast, as its role says: 60 days are fewer than the 66 its profile needs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/route', headers: { 'x-max-init-data': initData(demoId) } });
    expect(res.json()).toMatchObject({ openingDate: '2026-11-17', projectedOpeningDate: '2026-11-23', daysToOpening: 60 });
  });

  it.each(contract.checks.map((c) => [c.id, c] as const))('%s', async (_id, check) => {
    const url = Object.entries(check.params.path ?? {}).reduce((p, [k, v]) => p.replace(`{${k}}`, encodeURIComponent(v)), check.path);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(check.params.headers ?? {})) {
      if (name.toLowerCase() !== 'x-max-init-data') headers[name.toLowerCase()] = value;
      else if (value.includes('изменённым')) headers['x-max-init-data'] = initData(demoId).replace(String(demoId), String(demoId + 8));
      else headers['x-max-init-data'] = initData(check.role === 'new_user' ? newId : demoId);
    }

    const res = await app.inject({
      method: check.method,
      url,
      headers,
      ...(check.params.body === undefined ? {} : { payload: check.params.body as object }),
    });

    expect(check.expected_status, `${check.id}: got ${res.statusCode} ${res.body}`).toContain(res.statusCode);
    expect(res.headers['content-type']).toContain(check.response.content_type);
    const body = res.json() as Record<string, unknown>;
    for (const field of check.response.required_fields) expect(body, `${check.id}.${field}`).toHaveProperty(field);
  });
});

describe('DATA-API.yaml', () => {
  it('reads the same with a YAML 1.1 parser, which takes a bare off, n or 12:30 for something else', () => {
    expect(parseYaml(contractText, { version: '1.1' })).toEqual(contract);
  });
});
