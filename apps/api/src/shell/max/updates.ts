import type { Api } from '@maxhub/max-bot-api';
import type { Message, Update } from '@maxhub/max-bot-api/types';
import type { OnboardingInput, ReplySpec } from '@otkryvay/core';
import type { FastifyBaseLogger } from 'fastify';
import type { OnboardingService } from '../services/onboarding.js';
import { renderReply, type RenderOptions } from './render.js';

export type UpdateHandler = (update: Update) => Promise<void>;

export interface UpdateHandlerDeps {
  api: Pick<Api, 'sendMessageToUser' | 'answerOnCallback'>;
  onboarding: OnboardingService;
  render: RenderOptions;
  log: FastifyBaseLogger;
}

const FAILURE_REPLY: ReplySpec = {
  text: 'Что-то пошло не так на нашей стороне. Ваши ответы сохранены — повторите последнее действие через минуту.',
  buttons: [],
};

/** Translates a MAX update into an onboarding input for a user, or null when the update is not for us. */
export function toOnboardingInput(update: Update): { userId: number; input: OnboardingInput } | null {
  switch (update.update_type) {
    case 'bot_started':
      return { userId: update.user.user_id, input: { type: 'start' } };

    case 'message_created': {
      const { message } = update;
      const userId = message.sender?.user_id;
      // Only private dialogs; the bot is not meant to talk in group chats.
      if (!userId || message.recipient.chat_type !== 'dialog' || message.sender?.is_bot) return null;

      const location = message.body.attachments?.find((a) => a.type === 'location');
      if (location?.type === 'location') {
        return { userId, input: { type: 'location', latitude: location.latitude, longitude: location.longitude } };
      }
      const text = (message.body.text ?? '').trim();
      if (text === '/start') return { userId, input: { type: 'start' } };
      if (text === '/restart') return { userId, input: { type: 'restart' } };
      return { userId, input: { type: 'text', text } };
    }

    case 'message_callback':
      return { userId: update.callback.user.user_id, input: { type: 'callback', payload: update.callback.payload ?? '' } };

    default:
      return null;
  }
}

/** Label of the pressed button, found in the keyboard of the message it belongs to. */
function pressedLabel(message: Message | null | undefined, payload: string): string | null {
  for (const attachment of message?.body.attachments ?? []) {
    if (attachment.type !== 'inline_keyboard') continue;
    for (const button of attachment.payload.buttons.flat()) {
      if (button.type === 'callback' && button.payload === payload) return button.text;
    }
  }
  return null;
}

/**
 * Keyboard for the answered message: callback buttons are removed (the choice is made),
 * other buttons — e.g. «Открыть маршрут» — stay usable.
 */
export function frozenAttachments(message: Message | null | undefined) {
  const keyboard = message?.body.attachments?.find((a) => a.type === 'inline_keyboard');
  if (keyboard?.type !== 'inline_keyboard') return [];
  const rows = keyboard.payload.buttons.map((row) => row.filter((b) => b.type !== 'callback')).filter((row) => row.length > 0);
  return rows.length > 0 ? [{ type: 'inline_keyboard' as const, payload: { buttons: rows } }] : [];
}

/**
 * Single entry point for MAX updates, shared by polling and webhook modes.
 * Never throws: failures are logged and the user gets a short apology instead of silence.
 */
export function createUpdateHandler(deps: UpdateHandlerDeps): UpdateHandler {
  const send = async (userId: number, reply: ReplySpec) => {
    const { text, extra } = renderReply(reply, deps.render);
    await deps.api.sendMessageToUser(userId, text, extra);
  };

  return async (update) => {
    const target = toOnboardingInput(update);
    if (!target) {
      deps.log.debug({ updateType: update.update_type }, 'update ignored');
      return;
    }
    const { userId, input } = target;

    if (update.update_type === 'message_callback') {
      // Freeze the answered message: keep its text, show the choice, drop the answer buttons.
      const original = update.message;
      const label = pressedLabel(original, update.callback.payload ?? '');
      const text = original?.body.text ?? null;
      await deps.api
        .answerOnCallback(update.callback.callback_id, label && text ? { message: { text: `${text}\n\n✓ ${label}`, attachments: frozenAttachments(original) } } : {})
        .catch((error: unknown) => deps.log.warn({ err: error }, 'answerOnCallback failed'));
    }

    try {
      const replies = await deps.onboarding.handle(userId, input);
      for (const reply of replies) await send(userId, reply);
      deps.log.info({ userId, updateType: update.update_type, input: input.type, replies: replies.length }, 'update handled');
    } catch (error) {
      deps.log.error({ err: error, userId, updateType: update.update_type }, 'failed to handle MAX update');
      await send(userId, FAILURE_REPLY).catch((sendError: unknown) =>
        deps.log.error({ err: sendError, userId }, 'failed to deliver the failure notice'),
      );
    }
  };
}
