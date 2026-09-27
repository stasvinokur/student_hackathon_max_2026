import { RESTART_PAYLOAD } from './payloads.js';

/**
 * Platform-neutral description of a bot message. The core decides *what* to say;
 * the shell (apps/api/src/shell/max) renders it into a MAX API request.
 */
export type ButtonSpec =
  /** Opens the bot's mini-app; `startParam` is delivered to it as start_param. */
  | { kind: 'open_app'; text: string; startParam?: string }
  | { kind: 'callback'; text: string; payload: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'request_geo'; text: string };

export interface ReplySpec {
  text: string;
  /** Rows of inline keyboard buttons. */
  buttons: ButtonSpec[][];
}

// Buttons several messages share. A new object on every call: a reply is the caller's to change.

/** «Открыть маршрут»: opens the route in the mini-app. */
export function openRouteButton(): ButtonSpec {
  return { kind: 'open_app', text: 'Открыть маршрут' };
}

/** «Пройти заново»: onboarding from the first question. */
export function restartButton(): ButtonSpec {
  return { kind: 'callback', text: 'Пройти заново', payload: RESTART_PAYLOAD };
}
