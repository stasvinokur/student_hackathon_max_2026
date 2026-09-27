import { Bot, type Api } from '@maxhub/max-bot-api';
import type { UpdateType } from '@maxhub/max-bot-api/types';
import type { FastifyBaseLogger } from 'fastify';
import type { UpdateHandler } from './updates.js';

export const HANDLED_UPDATE_TYPES: UpdateType[] = ['bot_started', 'message_created', 'message_callback'];

export function createBot(token: string): Bot {
  return new Bot(token);
}

/** Long polling for local development. Runs in the background until stopPolling(). */
export function startPolling(bot: Bot, handleUpdate: UpdateHandler, log: FastifyBaseLogger): void {
  bot.use((ctx) => handleUpdate(ctx.update));
  bot.catch((error, ctx) => log.error({ err: error, update: ctx.update }, 'bot middleware failed'));
  void bot.start({ mode: 'polling', options: { allowedUpdates: HANDLED_UPDATE_TYPES } }).catch((error: unknown) => {
    log.error({ err: error }, 'failed to start MAX long polling');
  });
  log.info('MAX bot started in polling mode');
}

/** Points MAX at our webhook and removes any other subscription (only one receiver at a time). */
export async function registerWebhook(api: Api, url: string, secret: string): Promise<void> {
  const subscriptions = await api.getSubscriptions();
  await Promise.all(subscriptions.filter((s) => s.url !== url).map((s) => api.unsubscribe(s.url)));
  await api.subscribe(url, secret, HANDLED_UPDATE_TYPES);
}
