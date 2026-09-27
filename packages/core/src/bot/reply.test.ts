import { describe, expect, it } from 'vitest';
import { openRouteButton, restartButton } from './reply.js';

describe('shared buttons', () => {
  it('open the route in the mini-app and restart the questions', () => {
    expect(openRouteButton()).toEqual({ kind: 'open_app', text: 'Открыть маршрут' });
    expect(restartButton()).toEqual({ kind: 'callback', text: 'Пройти заново', payload: 'ob:restart' });
  });

  it('are new objects on every call: a reply is the caller’s to change', () => {
    expect(openRouteButton()).not.toBe(openRouteButton());
    expect(restartButton()).not.toBe(restartButton());
  });
});
