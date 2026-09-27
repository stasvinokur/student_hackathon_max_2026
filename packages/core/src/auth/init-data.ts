/**
 * Verification of MAX mini-app launch data (WebApp.initData), per
 * https://dev.max.ru/docs/webapps/validation:
 *   secret = HMAC_SHA256(key = "WebAppData", message = botToken)
 *   hash   = hex(HMAC_SHA256(key = secret, message = data_check_string))
 * where data_check_string is every received field except `hash`, as "key=value",
 * sorted by key and joined with "\n".
 *
 * Pure: the HMAC primitive and the current time are passed in, so the core stays
 * free of platform crypto and clocks.
 */

export type HmacSha256 = (key: Uint8Array | string, message: string) => Uint8Array;

export interface InitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface VerifyInitDataOptions {
  botToken: string;
  /** Current Unix time in seconds. */
  nowSeconds: number;
  /** How long a launch stays valid. */
  maxAgeSeconds: number;
  hmacSha256: HmacSha256;
}

export type InitDataFailure = 'missing' | 'malformed' | 'bad_signature' | 'expired';

export type VerifyInitDataResult =
  | { ok: true; user: InitDataUser; authDate: number; startParam: string | null }
  | { ok: false; reason: InitDataFailure };

/** Clock skew tolerated for auth_date slightly in the future. */
const FUTURE_SKEW_SECONDS = 60;

export function verifyInitData(raw: string | undefined | null, options: VerifyInitDataOptions): VerifyInitDataResult {
  if (!raw) return { ok: false, reason: 'missing' };

  const params = parseQuery(raw);
  if (!params) return { ok: false, reason: 'malformed' };

  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'malformed' };

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = options.hmacSha256('WebAppData', options.botToken);
  const expected = toHex(options.hmacSha256(secret, dataCheckString));
  if (!constantTimeEqual(expected, hash.toLowerCase())) return { ok: false, reason: 'bad_signature' };

  const authDate = Number(params.get('auth_date'));
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, reason: 'malformed' };
  if (options.nowSeconds - authDate > options.maxAgeSeconds || authDate - options.nowSeconds > FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: 'expired' };
  }

  const user = parseUser(params.get('user'));
  if (!user) return { ok: false, reason: 'malformed' };

  return { ok: true, user, authDate, startParam: params.get('start_param') ?? null };
}

/** application/x-www-form-urlencoded parser; no platform globals so the core runs anywhere. */
function parseQuery(raw: string): Map<string, string> | null {
  const params = new Map<string, string>();
  for (const pair of raw.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const [key, value] = eq === -1 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
    try {
      params.set(decodeURIComponent(key.replaceAll('+', ' ')), decodeURIComponent(value.replaceAll('+', ' ')));
    } catch {
      return null;
    }
  }
  return params;
}

function parseUser(json: string | undefined): InitDataUser | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null) return null;
    const id = (value as { id?: unknown }).id;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? (value as InitDataUser) : null;
  } catch {
    return null;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
