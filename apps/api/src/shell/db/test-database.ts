// Helpers for integration tests against the throwaway `db-test` compose service.
import { sql } from 'drizzle-orm';
import { createDatabase, type Database } from './client.js';
import { runMigrations } from './migrate.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://otkryvay@127.0.0.1:55439/otkryvay_test';

/** Connects and migrates, or returns null when the test database is not running. */
export async function openTestDatabase(): Promise<Database | null> {
  const database = createDatabase(TEST_DATABASE_URL);
  try {
    await database.ping();
  } catch {
    await database.close().catch(() => {});
    console.warn(`[db tests] skipped: no test database at ${TEST_DATABASE_URL}. Start it with: docker compose --profile test up -d db-test`);
    return null;
  }
  await runMigrations(database);
  return database;
}

export async function truncateAll(database: Database): Promise<void> {
  await database.db.execute(sql`truncate table events, reminders, route_tasks, routes, onboarding_states, users restart identity cascade`);
}
