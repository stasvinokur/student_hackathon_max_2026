import { buildRoute, toRouteView, toTaskDetail, type Profile, type RulesPack, type TaskStatuses } from '@otkryvay/core';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { ApiError, type ApiClient } from './api.js';
import { App } from './App.js';
import type { Bridge, ShareOutcome } from './bridge.js';
import { ThemeProvider } from './theme.js';

// Test doubles of the mini-app tests: an API over a route the real core engine builds, and the MAX bridge.

const TODAY = '2026-09-18';

export function fakeApi(pack: RulesPack, profile: Profile, overrides: Partial<ApiClient> = {}): ApiClient {
  const statuses: Record<string, 'todo' | 'done'> = {};
  const route = () => {
    const r = buildRoute(pack, profile, TODAY, statuses as TaskStatuses);
    if (r.status !== 'ok') throw new Error('route expected');
    return r.route;
  };
  return {
    getConfig: vi.fn(async () => ({ features: { explain: false } })),
    getLocationIndex: vi.fn(async (): Promise<unknown> => {
      throw new ApiError(404, 'location_index_not_found', 'Для этого пакета нет индекса мест.');
    }),
    explainTask: vi.fn(async () => ({ text: 'Сначала оформите ИП.', generated: true as const, source: null })),
    getRoute: vi.fn(async () => toRouteView(route(), pack)),
    getTask: vi.fn(async (id: string) => {
      const step = route().steps.find((s) => s.action.id === id);
      if (!step) throw new ApiError(404, 'task_not_found', 'Нет такого шага');
      return toTaskDetail(route(), step, pack);
    }),
    setTaskStatus: vi.fn(async (id: string, status: 'todo' | 'done') => {
      statuses[id] = status;
      const r = route();
      return { task: toTaskDetail(r, r.steps.find((s) => s.action.id === id)!, pack), readiness: toRouteView(r, pack).readiness, nextStep: null };
    }),
    sendEvent: vi.fn(),
    ...overrides,
  };
}

export type FakeBridge = Bridge & { back: (() => void) | null };

export function fakeBridge(): FakeBridge {
  const bridge = {
    back: null as (() => void) | null,
    ready: vi.fn(),
    openLink: vi.fn(),
    share: vi.fn(async (): Promise<ShareOutcome> => ({ result: 'shared' })),
    haptic: vi.fn(),
    reload: vi.fn(),
    serverReachable: vi.fn(async () => true),
    setBackHandler: vi.fn((handler: (() => void) | null) => {
      bridge.back = handler;
    }),
  };
  return bridge;
}

export function renderApp(props: { api: ApiClient | null; bridge?: FakeBridge; startParam?: string; botLink?: string }): FakeBridge {
  const bridge = props.bridge ?? fakeBridge();
  render(
    <ThemeProvider>
      <App api={props.api} bridge={bridge} startParam={props.startParam} botLink={props.botLink} />
    </ThemeProvider>,
  );
  return bridge;
}
