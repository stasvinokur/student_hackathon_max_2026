import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyInitData, type HmacSha256 } from './init-data.js';

const hmacSha256: HmacSha256 = (key, message) => createHmac('sha256', key).update(message).digest();
const BOT_TOKEN = 'test-bot-token';
const NOW = 1_789_000_000;
const options = { botToken: BOT_TOKEN, nowSeconds: NOW, maxAgeSeconds: 86_400, hmacSha256 };

/** Signs launch params the way MAX does, returning the raw initData query string. */
function sign(fields: Record<string, string>, token = BOT_TOKEN): string {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = JSON.stringify({ id: 103194277, first_name: 'Анна', language_code: 'ru' });

describe('verifyInitData', () => {
  it('accepts correctly signed launch data', () => {
    const raw = sign({ auth_date: String(NOW - 60), query_id: 'q1', user, start_param: 'task-kkt' });
    expect(verifyInitData(raw, options)).toEqual({
      ok: true,
      user: { id: 103194277, first_name: 'Анна', language_code: 'ru' },
      authDate: NOW - 60,
      startParam: 'task-kkt',
    });
  });

  it('rejects missing data', () => {
    expect(verifyInitData('', options)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyInitData(undefined, options)).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects a tampered field', () => {
    const raw = sign({ auth_date: String(NOW), user }).replace('103194277', '100000001');
    expect(verifyInitData(raw, options)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects data signed with another bot token', () => {
    expect(verifyInitData(sign({ auth_date: String(NOW), user }, 'other-token'), options)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an expired or far-future launch', () => {
    expect(verifyInitData(sign({ auth_date: String(NOW - 86_401), user }), options)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyInitData(sign({ auth_date: String(NOW + 3600), user }), options)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects malformed data even when signed', () => {
    expect(verifyInitData('user=1&auth_date=2', options)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyInitData(sign({ auth_date: String(NOW), user: '{"id":"abc"}' }), options)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyInitData(sign({ auth_date: String(NOW) }), options)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyInitData(sign({ auth_date: 'yesterday', user }), options)).toEqual({ ok: false, reason: 'malformed' });
  });
});
