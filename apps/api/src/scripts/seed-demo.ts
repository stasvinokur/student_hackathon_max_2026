// Creates a demo user with a ready route — test data for local development and review:
//   DATABASE_URL=... pnpm --filter @otkryvay/api seed:demo [userId]
// The profile is the "newbie-to-go" fixture with the opening date 60 days from today. On purpose fewer than the 66
// days it needs even with registration done (lease → fit-out → fire safety): the demo route shows the forecast
// (projectedOpeningDate) and the step dates counted from it, as DATA-API.yaml says.
import { addDays, type Profile } from '@otkryvay/core';
import { systemClock } from '../shell/clock.js';
import { loadPackRegistry } from '../shell/content/packs.js';
import { createDatabase } from '../shell/db/client.js';
import { runMigrations } from '../shell/db/migrate.js';
import { createRepositories } from '../shell/db/repositories.js';
import { createRouteService } from '../shell/services/routes.js';

const userId = Number(process.argv[2] ?? process.env.DEMO_USER_ID ?? 1);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const database = createDatabase(databaseUrl);
await runMigrations(database);
const repos = createRepositories(database.db);
const routes = createRouteService({ repos, packs: await loadPackRegistry(), clock: systemClock });

const profile: Profile = {
  format: 'to_go',
  city: 'kazan',
  legal_status: 'none',
  premises: 'searching',
  employees: 0,
  sells_food: false,
  opening_date: addDays(systemClock.today(), 60),
};

await repos.users.touch(userId);
await repos.onboarding.save(userId, { step: 'done', answers: profile });
const created = await routes.createRoute(userId, profile);
if (!created) throw new Error('route was not built');
for (const done of ['support-consultation', 'register-business']) {
  await repos.tasks.setStatus(created.routeId, done, 'done', systemClock.now());
}

console.log(`demo route for user ${userId}: ${created.route.steps.length} actions, opening ${profile.opening_date}`);
await database.close();
