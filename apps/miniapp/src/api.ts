import type { Readiness, RouteView, TaskDetail, TaskSummary } from '@otkryvay/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface TaskUpdate {
  task: TaskDetail;
  readiness: Readiness;
  nextStep: TaskSummary | null;
}

export interface Explanation {
  text: string;
  generated: true;
  source: TaskDetail['source'];
}

/** A location index the API serves for the «Карта» tab. */
export interface LocationIndexFeature {
  pack: string;
  /** Snapshot version: the time of the OpenStreetMap data and the methodology hash. */
  version: string;
  /** Steps of the pack the map helps with («Подобрать район на карте»). */
  actions: string[];
}

export interface AppConfig {
  features: {
    explain: boolean;
    /** Missing in an API older than the «Карта» tab. */
    locationIndex?: LocationIndexFeature[];
  };
}

/** The optional features the app shows. */
export interface Features {
  explain: boolean;
  locationIndex: LocationIndexFeature[];
}

export const NO_FEATURES: Features = { explain: false, locationIndex: [] };

/** Optional features never block the main scenario: anything unexpected in the config leaves them off. */
export function readFeatures(config: AppConfig | null | undefined): Features {
  const indexes: unknown = config?.features?.locationIndex;
  return {
    explain: config?.features?.explain === true,
    locationIndex: Array.isArray(indexes) ? indexes.filter(isIndexFeature) : [],
  };
}

function isIndexFeature(value: unknown): value is LocationIndexFeature {
  const feature = value as Partial<LocationIndexFeature> | null;
  return typeof feature?.pack === 'string' && typeof feature.version === 'string' && Array.isArray(feature.actions);
}

export interface ApiClient {
  getConfig(): Promise<AppConfig>;
  /** The snapshot JSON as is; the map screen validates it with parseLocationIndex. */
  getLocationIndex(packId: string): Promise<unknown>;
  explainTask(id: string): Promise<Explanation>;
  getRoute(): Promise<RouteView>;
  getTask(id: string): Promise<TaskDetail>;
  setTaskStatus(id: string, status: 'todo' | 'done'): Promise<TaskUpdate>;
  sendEvent(type: string, props?: Record<string, string | number | boolean>): void;
}

export interface ApiAuth {
  /** Signed WebApp.initData from MAX. */
  initData?: string;
  /** Local development only: accepted by the API when NODE_ENV=development. */
  devUserId?: string;
}

/**
 * A request that has not finished in its time is given up, the body included: a stalled mobile connection must end in
 * «Повторить», not in a spinner forever. A status change waits as long as a read, and the card then reads the step
 * again, since the server may have saved it. An explanation waits past the 60 s the server gives the model. Analytics
 * has no timeout: nobody waits for it.
 */
const TIMEOUT_MS = 20_000;
const EXPLAIN_TIMEOUT_MS = 90_000;

export function createApiClient(auth: ApiAuth, baseUrl = ''): ApiClient {
  const headers: Record<string, string> = {};
  if (auth.initData) headers['x-max-init-data'] = auth.initData;
  else if (auth.devUserId) headers['x-dev-user-id'] = auth.devUserId;

  async function request<T>(method: string, path: string, timeoutMs: number | null, body?: unknown): Promise<T> {
    // A timer and an AbortController, not AbortSignal.timeout(): that one is missing in Chrome < 103 and iOS < 16.
    const controller = timeoutMs === null ? null : new AbortController();
    let timedOut = false;
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller?.abort();
          }, timeoutMs);
    const timeout = () => new ApiError(0, 'timeout', 'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.');
    try {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch {
        throw timedOut ? timeout() : new ApiError(0, 'network', 'Нет связи с сервером. Проверьте интернет.');
      }
      // Reading the body can stall too, so the timer runs until it is read.
      const data: unknown = await response.json().catch(() => null);
      if (timedOut) throw timeout();
      if (!response.ok) {
        const { error, message } = (data ?? {}) as { error?: string; message?: string };
        throw new ApiError(response.status, error ?? 'http_error', message ?? `Ошибка сервера (${response.status}).`);
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getConfig: () => request<AppConfig>('GET', '/api/config', TIMEOUT_MS),
    // A plain request: the browser revalidates the snapshot's ETag itself (a repeat opening costs a 304). Setting
    // If-None-Match by hand would bypass the HTTP cache, and JS would get a 304 without a body.
    getLocationIndex: (packId) => request<unknown>('GET', `/api/packs/${encodeURIComponent(packId)}/location-index`, TIMEOUT_MS),
    explainTask: (id) => request<Explanation>('POST', `/api/tasks/${encodeURIComponent(id)}/explain`, EXPLAIN_TIMEOUT_MS),
    getRoute: () => request<RouteView>('GET', '/api/route', TIMEOUT_MS),
    getTask: (id) => request<TaskDetail>('GET', `/api/tasks/${encodeURIComponent(id)}`, TIMEOUT_MS),
    setTaskStatus: (id, status) => request<TaskUpdate>('PATCH', `/api/tasks/${encodeURIComponent(id)}`, TIMEOUT_MS, { status }),
    sendEvent: (type, props = {}) => {
      // Analytics must never break the UI.
      void request('POST', '/api/events', null, { type, props }).catch(() => {});
    },
  };
}
