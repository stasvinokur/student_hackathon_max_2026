import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridge } from './bridge.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('bridge.serverReachable', () => {
  it('asks the server for its start page, past every cache', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await createBridge(undefined).serverReachable()).toBe(true);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/', { method: 'HEAD', cache: 'no-store', signal: expect.any(AbortSignal) });
  });

  it('does not ask when the device is offline', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(await createBridge(undefined).serverReachable()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('counts a failed request or a server error as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await createBridge(undefined).serverReachable()).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 502 })));
    expect(await createBridge(undefined).serverReachable()).toBe(false);
  });

  it('gives up on a server that does not answer within 5 s', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
      ),
    );
    const answer = createBridge(undefined).serverReachable();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await answer).toBe(false);
  });
});

describe('bridge.haptic', () => {
  it('stays silent in the web client, which rejects haptic feedback', () => {
    const impactOccurred = vi.fn();
    const notificationOccurred = vi.fn();
    const bridge = createBridge({ initData: 'query_id=1', platform: 'web', HapticFeedback: { impactOccurred, notificationOccurred } });
    bridge.haptic('tap');
    bridge.haptic('error');
    expect(impactOccurred).not.toHaveBeenCalled();
    expect(notificationOccurred).not.toHaveBeenCalled();
  });

  it('stays silent outside MAX: the script of MAX is loaded in a browser too, with no init data', () => {
    const impactOccurred = vi.fn();
    const notificationOccurred = vi.fn();
    const bridge = createBridge({ initData: '', platform: 'ios', HapticFeedback: { impactOccurred, notificationOccurred } });
    bridge.haptic('tap');
    bridge.haptic('success');
    expect(impactOccurred).not.toHaveBeenCalled();
    expect(notificationOccurred).not.toHaveBeenCalled();
  });

  it('gives haptic feedback on phones', () => {
    const impactOccurred = vi.fn();
    const notificationOccurred = vi.fn();
    const bridge = createBridge({ initData: 'query_id=1', platform: 'ios', HapticFeedback: { impactOccurred, notificationOccurred } });
    bridge.haptic('tap');
    bridge.haptic('success');
    expect(impactOccurred).toHaveBeenCalledWith('light');
    expect(notificationOccurred).toHaveBeenCalledWith('success');
  });

  it('takes a feedback the client refuses for none: no rejection is left unhandled', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      // Plain functions: a mock of Vitest would handle the promise it returns itself (its settled results).
      let refused = 0;
      const refuse = () => {
        refused++;
        return Promise.reject(new Error('UnsupportedEvent'));
      };
      const bridge = createBridge({ initData: 'query_id=1', platform: 'android', HapticFeedback: { impactOccurred: refuse, notificationOccurred: refuse } });
      bridge.haptic('tap');
      bridge.haptic('error');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(refused).toBe(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('bridge.share', () => {
  // Inside MAX the page has signed init data; the MAX script is loaded outside it as well, where it has none.
  const inMax = (shareContent: () => Promise<unknown>) => createBridge({ initData: 'query_id=1', shareContent });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('shares through the MAX share sheet', async () => {
    expect(await inMax(async () => ({})).share('Готовность 5%')).toEqual({ result: 'shared' });
  });

  it('copies the text outside MAX without asking the MAX script, which would wait a minute for an answer', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const shareContent = vi.fn(() => new Promise(() => {}));
    expect(await createBridge({ initData: '', shareContent }).share('Готовность 5%')).toEqual({ result: 'copied' });
    expect(shareContent).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('Готовность 5%');
  });

  it('says the sheet did not open when MAX gave up waiting for it', async () => {
    const bridge = inMax(async () => {
      throw { error: { code: 'client.web_app_share.request_timeout' } };
    });
    expect(await bridge.share('Готовность 5%')).toEqual({ result: 'unavailable', error: 'client.web_app_share.request_timeout' });
  });

  it('keeps the MAX error code when the share sheet is closed or fails', async () => {
    const bridge = inMax(async () => {
      throw { error: { code: 'client.web_app_share.failed' } };
    });
    expect(await bridge.share('Готовность 5%')).toEqual({ result: 'cancelled', error: 'client.web_app_share.failed' });
  });

  it('reads a code from any error shape and never throws', async () => {
    const rejectWith = (payload: unknown) =>
      inMax(async () => {
        throw payload;
      }).share('Готовность 5%');
    const bare = Object.assign(Object.create(null) as object, { reason: 7 }); // String() would throw on it

    expect(await rejectWith({ error: 'client.share_failed' })).toEqual({ result: 'cancelled', error: 'client.share_failed' });
    expect(await rejectWith({ error: { message: 'Sheet closed' } })).toEqual({ result: 'cancelled', error: 'Sheet closed' });
    expect(await rejectWith({ error: { reason: 7 } })).toEqual({ result: 'cancelled', error: '{"error":{"reason":7}}' });
    expect(await rejectWith(bare)).toEqual({ result: 'cancelled', error: '{"reason":7}' });
  });
});
