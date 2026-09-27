// Thin adapter over MAX Bridge (window.WebApp). UI code talks to this module only;
// every method is a safe no-op outside the MAX client.

export interface MaxUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface MaxWebApp {
  initData?: string;
  initDataUnsafe?: { user?: MaxUser; start_param?: string };
  platform?: string;
  version?: string;
  ready?: () => void;
  openLink?: (url: string) => unknown;
  shareContent?: (content: { text?: string; link?: string }) => unknown;
  BackButton?: { show?: () => void; hide?: () => void; onClick?: (cb: () => void) => void; offClick?: (cb: () => void) => void };
  /** Its calls may answer with a promise, rejected by a client that cannot give the feedback. */
  HapticFeedback?: {
    impactOccurred?: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => unknown;
    notificationOccurred?: (type: 'error' | 'success' | 'warning') => unknown;
  };
}

declare global {
  interface Window {
    WebApp?: MaxWebApp;
  }
}

export interface LaunchContext {
  /** Raw signed init data; sent to the API for server-side verification. */
  initData: string;
  user: MaxUser;
  startParam?: string;
  platform?: string;
}

/** Launch data provided by MAX, or null when the page is opened outside the MAX client. */
export function readLaunchContext(webApp: MaxWebApp | undefined): LaunchContext | null {
  const user = webApp?.initDataUnsafe?.user;
  if (!webApp?.initData || !user) return null;

  const context: LaunchContext = { initData: webApp.initData, user };
  const startParam = webApp.initDataUnsafe?.start_param;
  if (startParam) context.startParam = startParam;
  if (webApp.platform) context.platform = webApp.platform;
  return context;
}

/**
 * Outcome of a share attempt. The MAX web client (26.9) answers WebAppShare with
 * `client.web_app_share.unsupported_method`, so there the text is copied instead. 'unavailable':
 * nothing went out, neither a sheet (MAX timed out waiting for it) nor the clipboard.
 */
export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'unavailable';

/** What happened to a share attempt; `error` is the MAX error code when the sheet did not deliver. */
export interface ShareOutcome {
  result: ShareResult;
  error?: string;
}

/** Platform services used by the UI. Injected into <App> so tests can replace them. */
export interface Bridge {
  ready(): void;
  openLink(url: string): void;
  share(text: string): Promise<ShareOutcome>;
  haptic(kind: 'success' | 'error' | 'tap'): void;
  /** Loads the app anew: after a deploy the chunks of the running version are gone. */
  reload(): void;
  /** Whether the server answers now: a reload without it would swap the working app for an error page. */
  serverReachable(): Promise<boolean>;
  /** Shows the platform back button while a handler is set; pass null to hide it. */
  setBackHandler(handler: (() => void) | null): void;
}

/** MAX rejects unsupported bridge calls with `{ error: { code: '...unsupported_method' } }`. */
function isUnsupported(error: unknown): boolean {
  try {
    return JSON.stringify(error ?? '').includes('unsupported') || String(error).includes('unsupported');
  } catch {
    return false;
  }
}

/**
 * Short error code for analytics. MAX rejects with `{ error: <whatever the client sent> }`, usually
 * `{ code }`; anything else is kept as JSON. Never throws; holds no personal data.
 */
function errorCode(error: unknown): string {
  const e = error as { error?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const inner = e?.error as { code?: unknown; message?: unknown } | string | null | undefined;
  const code = typeof inner === 'string' ? inner : (inner?.code ?? inner?.message ?? e?.code ?? e?.message);
  if (typeof code === 'string' || typeof code === 'number') return String(code).slice(0, 100);
  try {
    return String(JSON.stringify(error)).slice(0, 100);
  } catch {
    return 'unknown';
  }
}

/** Clipboard API first; execCommand still works where the iframe lacks clipboard permission. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // no permission in this iframe — fall through
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

/** Longer than a healthy answer from the stand takes, short enough for a user waiting on «Повторить». */
const REACHABILITY_TIMEOUT_MS = 5_000;

export function createBridge(webApp: MaxWebApp | undefined): Bridge {
  let current: (() => void) | null = null;
  const onBack = () => current?.();
  // Haptics only inside MAX, which signs the page with its init data: the MAX script is loaded in a browser as well,
  // and the MAX web client answers every haptic call with UnsupportedEvent, so neither is called.
  const haptics = webApp?.initData && webApp.platform !== 'web' ? webApp.HapticFeedback : undefined;

  return {
    ready: () => webApp?.ready?.(),
    openLink: (url) => {
      if (webApp?.openLink) void webApp.openLink(url);
      else window.open(url, '_blank', 'noopener');
    },
    share: async (text) => {
      // The MAX sheet only inside MAX (signed init data): the MAX script is loaded outside it as well, where it waits a
      // minute for an answer no client sends.
      if (webApp?.initData && webApp.shareContent) {
        try {
          await webApp.shareContent({ text });
          return { result: 'shared' };
        } catch (error) {
          const code = errorCode(error);
          // MAX gave up waiting for the sheet: it never opened, and the user is told so.
          if (code.includes('request_timeout')) return { result: 'unavailable', error: code };
          // Anything but "this client cannot share" means the sheet was closed; the code tells
          // a user's cancel from a client failure in the pilot analytics.
          if (!isUnsupported(error)) return { result: 'cancelled', error: code };
        }
      }
      try {
        if (navigator.share) {
          await navigator.share({ text });
          return { result: 'shared' };
        }
      } catch {
        // web-share is not allowed inside the MAX iframe, or the user cancelled
      }
      return { result: (await copyToClipboard(text)) ? 'copied' : 'unavailable' };
    },
    haptic: (kind) => {
      try {
        const done = kind === 'tap' ? haptics?.impactOccurred?.('light') : haptics?.notificationOccurred?.(kind);
        // A feedback the client refuses is no failure of the app: its rejection is handled here, not left to the console.
        Promise.resolve(done).catch(() => {});
      } catch {
        // the same refusal, thrown at once
      }
    },
    reload: () => window.location.reload(),
    serverReachable: async () => {
      if (navigator.onLine === false) return false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
      try {
        // The start page, past every cache: the answer must come from the server now.
        const response = await fetch('/', { method: 'HEAD', cache: 'no-store', signal: controller.signal });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    setBackHandler: (handler) => {
      const button = webApp?.BackButton;
      if (handler && !current) {
        button?.onClick?.(onBack);
        button?.show?.();
      }
      if (!handler && current) {
        button?.offClick?.(onBack);
        button?.hide?.();
      }
      current = handler;
    },
  };
}
