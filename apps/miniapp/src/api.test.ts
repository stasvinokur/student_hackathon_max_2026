import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from './api.js';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function stubFetch(answer: Fetch) {
  const fetch = vi.fn(answer);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Settles like a real fetch whose request is aborted: it waits for the signal. */
const untilAborted = <T>(init?: RequestInit) =>
  new Promise<T>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))));

const TIMEOUT = { name: 'ApiError', status: 0, code: 'timeout', message: 'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createApiClient', () => {
  it('loads the location index of a pack with a plain GET: the browser cache revalidates the ETag itself', async () => {
    const snapshot = { format: 'otkryvay.location-index/1', pack: 'kazan-coffee' };
    const fetch = stubFetch(async () => json(snapshot));

    await expect(createApiClient({ initData: 'signed' }).getLocationIndex('kazan-coffee')).resolves.toEqual(snapshot);
    // No If-None-Match and no cache mode: either would bypass the HTTP cache and hand JS a bare 304.
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/packs/kazan-coffee/location-index', {
      method: 'GET',
      headers: { 'x-max-init-data': 'signed' },
      signal: expect.any(AbortSignal),
    });
  });

  it('reports a pack without an index as an API error', async () => {
    stubFetch(async () => json({ error: 'location_index_not_found', message: 'Для этого пакета нет индекса мест.' }, 404));
    await expect(createApiClient({ initData: 'signed' }).getLocationIndex('kazan-coffee')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'location_index_not_found',
    });
  });

  it('reports a failed connection as a network error', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(createApiClient({ initData: 'signed' }).getRoute()).rejects.toMatchObject({ name: 'ApiError', status: 0, code: 'network' });
  });
});

describe('request timeout', () => {
  it('gives up on a GET the server does not answer within 20 s', async () => {
    vi.useFakeTimers();
    stubFetch((_url, init) => untilAborted<Response>(init));
    const outcome = expect(createApiClient({ initData: 'signed' }).getLocationIndex('kazan-coffee')).rejects.toMatchObject(TIMEOUT);

    await vi.advanceTimersByTimeAsync(20_000);
    await outcome;
  });

  it('gives up when the answer starts but its body never ends', async () => {
    vi.useFakeTimers();
    stubFetch(async (_url, init) => ({ ok: true, status: 200, json: () => untilAborted<unknown>(init) }) as unknown as Response);
    const outcome = expect(createApiClient({ initData: 'signed' }).getRoute()).rejects.toMatchObject(TIMEOUT);

    await vi.advanceTimersByTimeAsync(20_000);
    await outcome;
  });

  it('leaves no timer behind once the answer is read', async () => {
    vi.useFakeTimers();
    stubFetch(async () => json({ features: { explain: false } }));
    await createApiClient({ initData: 'signed' }).getConfig();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up on a status change the server does not confirm within 20 s: the card then checks what was saved', async () => {
    vi.useFakeTimers();
    stubFetch((_url, init) => untilAborted<Response>(init));
    const outcome = expect(createApiClient({ initData: 'signed' }).setTaskStatus('register', 'done')).rejects.toMatchObject(TIMEOUT);
    await vi.advanceTimersByTimeAsync(20_000);
    await outcome;
  });

  it('lets an explanation take longer than the 60 s the server gives the model', async () => {
    vi.useFakeTimers();
    stubFetch((_url, init) => untilAborted<Response>(init));
    let settled = false;
    const outcome = createApiClient({ initData: 'signed' }).explainTask('register');
    void outcome.catch(() => {}).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(outcome).rejects.toMatchObject(TIMEOUT);
  });

  it('sends analytics without a timeout: an event may wait for the network', async () => {
    const fetch = stubFetch(async () => json({ accepted: true }, 202));
    createApiClient({ initData: 'signed' }).sendEvent('map_opened', { source: 'tab' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty('signal');
  });
});
