import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { DATABASE_URL: 'postgres://u:p@db:5432/app', MAX_BOT_TOKEN: 'token' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toMatchObject({ PORT: 3000, HOST: '0.0.0.0', NODE_ENV: 'production', BOT_MODE: 'polling' });
  });

  it('fails fast without DATABASE_URL', () => {
    expect(() => loadConfig({ MAX_BOT_TOKEN: 'token' })).toThrow(/DATABASE_URL/);
  });

  it('requires the bot token unless the bot is off', () => {
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/MAX_BOT_TOKEN/);
    expect(loadConfig({ DATABASE_URL: base.DATABASE_URL, BOT_MODE: 'off' }).BOT_MODE).toBe('off');
  });

  it('treats empty values as unset', () => {
    expect(() => loadConfig({ ...base, MAX_BOT_TOKEN: '' })).toThrow(/MAX_BOT_TOKEN/);
  });

  it('serves the location index unless LOCATION_INDEX_ENABLED=false', () => {
    expect(loadConfig(base).LOCATION_INDEX_ENABLED).toBe(true);
    expect(loadConfig({ ...base, LOCATION_INDEX_ENABLED: '' }).LOCATION_INDEX_ENABLED).toBe(true);
    expect(loadConfig({ ...base, LOCATION_INDEX_ENABLED: 'true' }).LOCATION_INDEX_ENABLED).toBe(true);
    expect(loadConfig({ ...base, LOCATION_INDEX_ENABLED: 'false' }).LOCATION_INDEX_ENABLED).toBe(false);
    expect(() => loadConfig({ ...base, LOCATION_INDEX_ENABLED: 'off' })).toThrow(/LOCATION_INDEX_ENABLED/);
  });

  it('requires an https WEBHOOK_URL and a valid secret in webhook mode', () => {
    expect(() => loadConfig({ ...base, BOT_MODE: 'webhook' })).toThrow(/WEBHOOK_URL[\s\S]*WEBHOOK_SECRET|WEBHOOK_SECRET[\s\S]*WEBHOOK_URL/);
    expect(() =>
      loadConfig({ ...base, BOT_MODE: 'webhook', WEBHOOK_URL: 'http://insecure.example', WEBHOOK_SECRET: 'abcdef' }),
    ).toThrow(/WEBHOOK_URL/);
    expect(() =>
      loadConfig({ ...base, BOT_MODE: 'webhook', WEBHOOK_URL: 'https://api.example.ru', WEBHOOK_SECRET: 'bad secret!' }),
    ).toThrow(/WEBHOOK_SECRET/);
    expect(
      loadConfig({ ...base, BOT_MODE: 'webhook', WEBHOOK_URL: 'https://api.example.ru', WEBHOOK_SECRET: 'good-secret-1' }),
    ).toMatchObject({ BOT_MODE: 'webhook' });
  });
});
