import { loadConfig } from './shell/config.js';
import { systemClock } from './shell/clock.js';
import { loadLocationIndexes, type LocationIndexStore } from './shell/content/location-index.js';
import { loadPackRegistry } from './shell/content/packs.js';
import { createDatabase } from './shell/db/client.js';
import { runMigrations } from './shell/db/migrate.js';
import { createRepositories } from './shell/db/repositories.js';
import { WEBHOOK_PATH } from './shell/http/webhook.js';
import { buildServer } from './shell/http/server.js';
import { createBot, registerWebhook, startPolling } from './shell/max/bot.js';
import { createUpdateHandler } from './shell/max/updates.js';
import { createLlmClient } from './shell/llm/client.js';
import { createExplainService } from './shell/services/explain.js';
import { createOnboardingService } from './shell/services/onboarding.js';
import { createReminderService } from './shell/services/reminders.js';
import { createRouteService } from './shell/services/routes.js';
import { createReminderWorker } from './shell/scheduler/reminder-worker.js';
import pino from 'pino';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
const clock = systemClock;

// An invalid rules pack aborts startup: better no route than an unverified one.
const packs = await loadPackRegistry();
log.info({ packs: packs.all().map((p) => `${p.manifest.id}@${p.manifest.version}`) }, 'rules packs loaded');

// The map is optional: a missing or invalid snapshot turns it off for its pack (logged), never the server.
const locationIndexes: LocationIndexStore = config.LOCATION_INDEX_ENABLED ? await loadLocationIndexes(packs.all(), log) : new Map();
if (!config.LOCATION_INDEX_ENABLED) log.info('LOCATION_INDEX_ENABLED=false: the map is off');

const database = createDatabase(config.DATABASE_URL);
const repos = createRepositories(database.db);
const reminders = createReminderService({ repos, clock, delaySeconds: config.REMINDER_DELAY_SECONDS });
const routes = createRouteService({ repos, packs, clock, reminders });
const onboarding = createOnboardingService({ repos, routes, packs, clock, log });
const explain = createExplainService({
  routes,
  log,
  llm:
    config.LLM_ENABLED && config.LLM_API_URL && config.LLM_API_KEY && config.LLM_MODEL
      ? createLlmClient({ url: config.LLM_API_URL, apiKey: config.LLM_API_KEY, model: config.LLM_MODEL, timeoutMs: config.LLM_TIMEOUT_MS })
      : null,
});

const bot = config.BOT_MODE !== 'off' && config.MAX_BOT_TOKEN ? createBot(config.MAX_BOT_TOKEN) : undefined;
const botInfo = bot ? await bot.api.getMyInfo() : undefined;
const render = { webApp: config.MAX_WEB_APP ?? botInfo?.username ?? String(botInfo?.user_id ?? '') };
const handleUpdate = bot && botInfo ? createUpdateHandler({ api: bot.api, onboarding, render, log }) : undefined;

const app = await buildServer(
  {
    checkDb: database.ping,
    ...(config.BOT_MODE === 'webhook' && handleUpdate && config.WEBHOOK_SECRET
      ? { webhook: { secret: config.WEBHOOK_SECRET, handleUpdate } }
      : {}),
    api: {
      routes,
      explain,
      locationIndexes,
      recordEvent: (type, userId, props) => repos.events.record(type, userId, props),
      clock,
      auth: { botToken: config.MAX_BOT_TOKEN, maxAgeSeconds: config.INIT_DATA_MAX_AGE_SECONDS, devBypass: config.NODE_ENV === 'development' },
    },
  },
  { loggerInstance: log },
);

await runMigrations(database);
log.info('database migrations applied');

await app.listen({ host: config.HOST, port: config.PORT });

if (bot && handleUpdate) {
  log.info({ bot: botInfo?.username, mode: config.BOT_MODE }, 'MAX bot connected');
  await bot.api
    .setMyCommands([
      { name: 'start', description: 'Начать или продолжить' },
      { name: 'restart', description: 'Пройти вопросы заново' },
    ])
    .catch((error: unknown) => log.warn({ err: error }, 'failed to set bot commands'));
  if (config.BOT_MODE === 'polling') {
    startPolling(bot, handleUpdate, log);
  } else if (config.WEBHOOK_URL && config.WEBHOOK_SECRET) {
    const url = new URL(WEBHOOK_PATH, config.WEBHOOK_URL).toString();
    await registerWebhook(bot.api, url, config.WEBHOOK_SECRET);
    log.info({ url }, 'MAX webhook registered');
  }
} else {
  log.warn('BOT_MODE=off: MAX bot is disabled');
}

// Reminders are delivered by the bot, so the worker runs only when the bot is enabled.
const stopReminders = bot
  ? createReminderWorker({ repos, routes, api: bot.api, render, clock, log }).start(config.REMINDER_POLL_SECONDS * 1000)
  : undefined;
if (bot) log.info({ delaySeconds: config.REMINDER_DELAY_SECONDS, pollSeconds: config.REMINDER_POLL_SECONDS }, 'reminder worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');
    bot?.stopPolling();
    stopReminders?.();
    void app
      .close()
      .then(() => database.close())
      .then(() => process.exit(0));
  });
}
