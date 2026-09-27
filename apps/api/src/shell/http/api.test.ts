import { RulesPackSchema, type Profile } from '@otkryvay/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock.js';
import { createPackRegistry } from '../content/packs.js';
import type { Database } from '../db/client.js';
import { createRepositories, type Repositories } from '../db/repositories.js';
import { openTestDatabase, truncateAll } from '../db/test-database.js';
import { createRouteService, type RouteService } from '../services/routes.js';
import { buildServer } from './server.js';
import { signInitData } from './test-init-data.js';

const database: Database | null = await openTestDatabase();
const BOT_TOKEN = 'test-bot-token';
const clock = fixedClock('2026-09-18T09:00:00Z');
const NOW = Math.floor(clock.now().getTime() / 1000);
const ALICE = 1001;
const BOB = 2002;

const source = { url: 'https://www.nalog.gov.ru/', title: 'ФНС', checked_at: '2026-09-18' };
const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Шаг ${id}`, lane: 'critical', duration_days: 3, why: 'w', do_now: 'd', done_when: 'x', source, kind: 'test_data', ...extra,
});
const pack = RulesPackSchema.parse({
  manifest: { id: 'demo', version: '1.0.0', title: 'Demo', industry: 'coffee', checked_at: '2026-09-18', cities: ['kazan'], region: { code: 'kazan', name: 'Казань' } },
  actions: [
    card('register', { applies_if: { field: 'legal_status', eq: 'none' } }),
    card('kkt', { depends_on: ['register'] }),
    card('hire', { lane: 'ops', applies_if: { field: 'employees', gt: 0 } }),
  ],
});
const profile = (extra: Partial<Profile> = {}): Profile => ({
  format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'signed', employees: 2, sells_food: false, opening_date: '2026-11-01', ...extra,
});

const initData = (userId: number, authDate = NOW, token = BOT_TOKEN) => signInitData(token, userId, authDate);
const as = (userId: number) => ({ 'x-max-init-data': initData(userId) });

describe.skipIf(!database)('mini-app API (integration)', () => {
  let repos: Repositories;
  let routes: RouteService;
  let app: FastifyInstance;

  async function server(devBypass = false) {
    return buildServer({
      checkDb: async () => {},
      api: { routes, recordEvent: (t, u, p) => repos.events.record(t, u, p), clock, auth: { botToken: BOT_TOKEN, maxAgeSeconds: 86_400, devBypass } },
    });
  }

  beforeAll(async () => {
    repos = createRepositories(database!.db);
    routes = createRouteService({ repos, packs: createPackRegistry([pack]), clock });
    app = await server();
  });
  beforeEach(async () => {
    await truncateAll(database!);
    await repos.users.touch(ALICE);
    await repos.users.touch(BOB);
    await routes.createRoute(ALICE, profile());
    await routes.createRoute(BOB, profile({ legal_status: 'ip', employees: 0 }));
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  describe('authorization', () => {
    it.each([
      ['no initData', {}],
      ['forged signature', { 'x-max-init-data': initData(ALICE).replace('1001', '2002') }],
      ['another bot token', { 'x-max-init-data': initData(ALICE, NOW, 'other-token') }],
      ['expired (older than 24h)', { 'x-max-init-data': initData(ALICE, NOW - 86_401) }],
      ['dev header outside development', { 'x-dev-user-id': String(ALICE) }],
    ])('401 for %s on every endpoint', async (_, headers) => {
      const calls = [
        app.inject({ method: 'GET', url: '/api/route', headers }),
        app.inject({ method: 'GET', url: '/api/tasks/kkt', headers }),
        app.inject({ method: 'PATCH', url: '/api/tasks/kkt', headers, payload: { status: 'done' } }),
        app.inject({ method: 'GET', url: '/api/readiness', headers }),
        app.inject({ method: 'POST', url: '/api/events', headers, payload: { type: 'miniapp_opened' } }),
        app.inject({ method: 'GET', url: '/api/packs/kazan-coffee/location-index', headers }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ error: 'unauthorized' });
      }
    });

    it('rejects before validating the body (401, not 400)', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/api/tasks/kkt', payload: { status: 'nope' } });
      expect(res.statusCode).toBe(401);
    });

    it('accepts the dev header only when the bypass is enabled (NODE_ENV=development)', async () => {
      const dev = await server(true);
      const res = await dev.inject({ method: 'GET', url: '/api/readiness', headers: { 'x-dev-user-id': String(ALICE) } });
      expect(res.statusCode).toBe(200);
      await dev.close();
    });
  });

  describe('GET /api/route', () => {
    it('200 with the personal route', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/route', headers: as(ALICE) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        openingDate: '2026-11-01',
        projectedOpeningDate: null,
        today: '2026-09-18',
        daysToOpening: 44,
        readiness: { done: 0, total: 3 },
      });
      expect(body.lanes.critical.map((t: { id: string }) => t.id)).toEqual(['register', 'kkt']);
      expect(body.nextStep.id).toBe('register');
    });

    it('404 before onboarding is finished', async () => {
      await repos.users.touch(3003);
      const res = await app.inject({ method: 'GET', url: '/api/route', headers: as(3003) });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'route_not_found' });
    });
  });

  describe('GET /api/tasks/:id', () => {
    it('200 with the card', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks/kkt', headers: as(ALICE) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: 'kkt', waitingFor: [{ id: 'register' }], source: { url: 'https://www.nalog.gov.ru/' } });
    });

    it('400 for a malformed id', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/tasks/BAD%20ID!', headers: as(ALICE) })).statusCode).toBe(400);
    });

    it('404 for a task outside the user route (no leaking other users)', async () => {
      // "register" and "hire" are in Alice's route, not in Bob's.
      const res = await app.inject({ method: 'GET', url: '/api/tasks/register', headers: as(BOB) });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'task_not_found' });
      expect((await app.inject({ method: 'GET', url: '/api/tasks/unknown', headers: as(ALICE) })).statusCode).toBe(404);
    });
  });

  describe('PATCH /api/tasks/:id', () => {
    it('200: marks done, updates readiness and the next step, cancels reminders', async () => {
      const route = await routes.getRoute(ALICE);
      await repos.reminders.schedule({ userId: ALICE, routeId: route!.routeId, actionId: 'register', kind: 'next_step', dueAt: new Date('2026-09-18T08:00:00Z') });

      const res = await app.inject({ method: 'PATCH', url: '/api/tasks/register', headers: as(ALICE), payload: { status: 'done' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ task: { id: 'register', status: 'done' }, readiness: { done: 1, total: 3 }, nextStep: { id: 'kkt' } });
      expect(await repos.reminders.claimDue(new Date('2026-09-18T10:00:00Z'), 10, 60_000)).toEqual([]);

      const back = await app.inject({ method: 'PATCH', url: '/api/tasks/register', headers: as(ALICE), payload: { status: 'todo' } });
      expect(back.json()).toMatchObject({ task: { status: 'todo' }, readiness: { done: 0 } });
    });

    it('400 for an invalid body', async () => {
      for (const payload of [{ status: 'finished' }, {}]) {
        const res = await app.inject({ method: 'PATCH', url: '/api/tasks/register', headers: as(ALICE), payload });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'bad_request' });
      }
      // A non-JSON body is refused before validation.
      const text = await app.inject({ method: 'PATCH', url: '/api/tasks/register', headers: as(ALICE), payload: 'done' });
      expect(text.statusCode).toBe(415);
    });

    it("404 for another user's task, which stays untouched", async () => {
      const res = await app.inject({ method: 'PATCH', url: '/api/tasks/hire', headers: as(BOB), payload: { status: 'done' } });
      expect(res.statusCode).toBe(404);
      expect((await repos.routes.getForUser(ALICE))?.statuses.hire).toBe('todo');
    });
  });

  describe('GET /api/readiness', () => {
    it('200 and 404', async () => {
      const ok = await app.inject({ method: 'GET', url: '/api/readiness', headers: as(BOB) });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ done: 0, total: 1, percent: 0, criticalDone: 0, criticalTotal: 1 });
      expect((await app.inject({ method: 'GET', url: '/api/readiness', headers: as(4004) })).statusCode).toBe(404);
    });
  });

  describe('POST /api/events', () => {
    it('202 for an allowed event, 400 for an unknown one', async () => {
      const ok = await app.inject({ method: 'POST', url: '/api/events', headers: as(ALICE), payload: { type: 'source_opened', props: { task: 'kkt' } } });
      expect(ok.statusCode).toBe(202);
      const bad = await app.inject({ method: 'POST', url: '/api/events', headers: as(ALICE), payload: { type: 'drop_tables' } });
      expect(bad.statusCode).toBe(400);
    });
  });
});
