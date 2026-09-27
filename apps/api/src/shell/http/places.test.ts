import type { Profile, RouteView, TaskDetail } from '@otkryvay/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock.js';
import { loadRulesPack } from '../content/load.js';
import { createPackRegistry } from '../content/packs.js';
import type { Database } from '../db/client.js';
import { createRepositories } from '../db/repositories.js';
import { openTestDatabase, truncateAll } from '../db/test-database.js';
import { createRouteService } from '../services/routes.js';
import { buildServer } from './server.js';
import { signInitData } from './test-init-data.js';

// Places of route steps as the mini-app gets them: the real kazan-coffee pack and the demo_user profile of DATA-API.yaml.

const database: Database | null = await openTestDatabase();
const BOT_TOKEN = 'test-bot-token';
const clock = fixedClock('2026-09-18T09:00:00Z');
const DEMO = 1000001;
/** "newbie-to-go": not registered yet, coffee-to-go without food, looking for premises, works alone. */
const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 0, sells_food: false, opening_date: '2026-11-17' };

const headers = { 'x-max-init-data': signInitData(BOT_TOKEN, DEMO, Math.floor(clock.now().getTime() / 1000)) };

describe.skipIf(!database)('places of route steps over HTTP (kazan-coffee, demo_user profile)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await truncateAll(database!);
    const repos = createRepositories(database!.db);
    const routes = createRouteService({ repos, packs: createPackRegistry([await loadRulesPack('kazan-coffee')]), clock });
    await repos.users.touch(DEMO);
    await routes.createRoute(DEMO, profile);
    app = await buildServer({
      checkDb: async () => {},
      api: { routes, recordEvent: (t, u, p) => repos.events.record(t, u, p), clock, auth: { botToken: BOT_TOKEN, maxAgeSeconds: 86_400, devBypass: false } },
    });
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  async function get<T>(url: string): Promise<T> {
    const res = await app.inject({ method: 'GET', url, headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<T>();
  }

  it('GET /api/route lists the places of the applicable steps once each, in route order', async () => {
    const route = await get<RouteView>('/api/route');
    expect(route.places.map((p) => [p.id, p.actions.map((a) => a.id)])).toEqual([
      ['ifns-18-kazan', ['register-business']],
      ['rospotrebnadzor-rt', ['rpn-notification']],
      // Working alone, the owner needs no staff medical books: the lab stays for production control only.
      ['cgie-rt', ['production-control']],
      ['tko-operator-kazan', ['tko-contract']],
      ['uag-kazan', ['kazan-signage']],
      ['my-business-kazan', ['support-consultation']],
    ]);
  });

  it('GET /api/tasks/:id leads from the registration card to the registering tax office', async () => {
    const task = await get<TaskDetail>('/api/tasks/register-business');
    expect(task.places).toEqual([
      {
        id: 'ifns-18-kazan',
        name: 'Межрайонная ИФНС России № 18 по Республике Татарстан',
        shortName: 'ИФНС № 18',
        address: 'Казань, ул. Владимира Кулагина, 1',
        lat: 55.74213,
        lon: 49.142156,
        note: 'Регистрирующая инспекция — регистрирует ООО и ИП. Остановка «Регистрационная палата».',
        osmUrl: 'https://www.openstreetmap.org/way/92939129',
        source: {
          url: 'https://www.nalog.gov.ru/rn16/ifns/16_mri18/',
          title: 'ФНС России — Межрайонная ИФНС № 18 по Республике Татарстан',
          checkedAt: '2026-09-23',
        },
      },
    ]);
    expect((await get<TaskDetail>('/api/tasks/lease-premises')).places).toEqual([]);
  });

  it('GET /api/tasks/:id gives the rpn-notification card exactly its place (the task_with_places check of DATA-API.yaml)', async () => {
    const task = await get<TaskDetail>('/api/tasks/rpn-notification');
    expect(task.status).toBe('todo');
    expect(task.places.map((p) => [p.id, p.osmUrl])).toEqual([['rospotrebnadzor-rt', 'https://www.openstreetmap.org/node/12996321895']]);
  });

  it('PATCH /api/tasks/:id returns the updated card with its places', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/tasks/support-consultation', headers, payload: { status: 'done' } });
    expect(res.statusCode, res.body).toBe(200);
    const { task } = res.json<{ task: TaskDetail }>();
    expect(task).toMatchObject({ status: 'done', places: [{ id: 'my-business-kazan', address: 'Казань, ул. Петербургская, 28' }] });
  });
});
