import { Keyboard, type Api } from '@maxhub/max-bot-api';
import type { Button } from '@maxhub/max-bot-api/types';
import type { ButtonSpec, ReplySpec } from '@otkryvay/core';

export type SendExtra = NonNullable<Parameters<Api['sendMessageToUser']>[2]>;

export interface RenderOptions {
  /** `web_app` value for open_app buttons (bot username by default). */
  webApp: string;
}

export function renderButton(button: ButtonSpec, options: RenderOptions): Button {
  switch (button.kind) {
    case 'open_app':
      return Keyboard.button.openApp(button.text, options.webApp, undefined, button.startParam);
    case 'callback':
      return Keyboard.button.callback(button.text, button.payload);
    case 'link':
      return Keyboard.button.link(button.text, button.url);
    case 'request_geo':
      return Keyboard.button.requestGeoLocation(button.text);
  }
}

/** Turns a core ReplySpec into arguments for Api.sendMessageToUser / sendMessageToChat. */
export function renderReply(reply: ReplySpec, options: RenderOptions): { text: string; extra: SendExtra } {
  const rows = reply.buttons.filter((row) => row.length > 0);
  const extra: SendExtra =
    rows.length > 0
      ? { attachments: [Keyboard.inlineKeyboard(rows.map((row) => row.map((b) => renderButton(b, options))))] }
      : {};
  return { text: reply.text, extra };
}
