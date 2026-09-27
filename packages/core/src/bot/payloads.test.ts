import { describe, expect, it } from 'vitest';
import {
  keepOpeningPayload,
  parseKeepOpeningPayload,
  parseRescheduleOpeningPayload,
  parseRoutePayload,
  RESTART_PAYLOAD,
  rescheduleOpeningPayload,
  ROUTE_FIRST_STEP_PAYLOAD,
} from './payloads.js';

describe('callback payloads', () => {
  it('name the buttons outside the questions', () => {
    expect(RESTART_PAYLOAD).toBe('ob:restart');
    expect(ROUTE_FIRST_STEP_PAYLOAD).toBe('route:first');
  });

  it('carry the date the offer to move the opening was made for and the one it offers', () => {
    const payload = rescheduleOpeningPayload('2026-10-26', '2026-12-08');
    expect(payload).toBe('route:reschedule:2026-10-26:2026-12-08');
    expect(parseRescheduleOpeningPayload(payload)).toEqual({ from: '2026-10-26', to: '2026-12-08' });
  });

  it('carry the date kept', () => {
    const payload = keepOpeningPayload('2026-10-26');
    expect(payload).toBe('route:keep:2026-10-26');
    expect(parseKeepOpeningPayload(payload)).toBe('2026-10-26');
  });

  it.each([
    '',
    'route:keep:2026-10-26',
    'route:first',
    'route:reschedule:2026-10-26',
    'route:reschedule:2026-10-26:',
    'route:reschedule:2026-10-26:2026-12-08:x',
    'route:reschedule:2026-10-26:2026-12-08\n',
    ' route:reschedule:2026-10-26:2026-12-08',
    'route:reschedule:2026-02-30:2026-12-08',
    'route:reschedule:2026-10-26:2026-13-01',
    'route:reschedule:26.10.2026:08.12.2026',
    'ob:opening_date:+30',
  ])('rejects %j as a move', (payload) => {
    expect(parseRescheduleOpeningPayload(payload)).toBeNull();
  });

  it.each([
    '',
    'route:keep',
    'route:keep:',
    'route:keep:2026-10-26\n',
    ' route:keep:2026-10-26',
    'route:keep:2026-02-30',
    'route:keep:2026-10-26:x',
    'route:keep:26.10.2026',
    'route:reschedule:2026-10-26:2026-12-08',
    'route:first',
  ])('rejects %j as a kept date', (payload) => {
    expect(parseKeepOpeningPayload(payload)).toBeNull();
  });
});

describe('parseRoutePayload', () => {
  it('names the route button a payload belongs to', () => {
    expect(parseRoutePayload(ROUTE_FIRST_STEP_PAYLOAD)).toEqual({ kind: 'first' });
    expect(parseRoutePayload(rescheduleOpeningPayload('2026-10-26', '2026-12-08'))).toEqual({
      kind: 'reschedule',
      move: { from: '2026-10-26', to: '2026-12-08' },
    });
    expect(parseRoutePayload(keepOpeningPayload('2026-10-26'))).toEqual({ kind: 'keep', date: '2026-10-26' });
  });

  it.each([
    'route:',
    'route:first:x',
    'route:unknown',
    'route:reschedule:2026-02-30:2026-12-08',
    'route:reschedule:2026-10-26',
    'route:keep:soon',
    'route:keep:2026-10-26\n',
  ])('takes %j for a route button it does not know', (payload) => {
    expect(parseRoutePayload(payload)).toEqual({ kind: 'unknown' });
  });

  it.each(['', 'ob:restart', 'ob:opening_date:+30', 'Route:first', ' route:first', 'routes:first'])('leaves %j to onboarding', (payload) => {
    expect(parseRoutePayload(payload)).toBeNull();
  });
});
