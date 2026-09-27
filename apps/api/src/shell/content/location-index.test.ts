import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLocationIndex, RulesPackSchema, type RulesPack } from '@otkryvay/core';
import { tinyLocationIndex } from '@otkryvay/core/testing';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { CONTENT_DIR, loadRulesPack } from './load.js';
import { loadLocationIndexes } from './location-index.js';

// The map is optional: a pack without a valid snapshot loses its «Карта» tab, the server keeps running (doc-3 §6).

interface LogRecord {
  level: number;
  msg: string;
  [key: string]: unknown;
}

const INFO = 30;
const WARN = 40;
const ERROR = 50;

/** A real logger at the default level (LOG_LEVEL=info) that keeps its records: what an operator would see. */
function recordingLog() {
  const records: LogRecord[] = [];
  const log = pino({ level: 'info' }, { write: (line: string) => void records.push(JSON.parse(line) as LogRecord) });
  return { log, records };
}

/** A pack the tiny snapshot can belong to: the linked step exists, the grid lies in the region. */
function packOf(id: string): RulesPack {
  return RulesPackSchema.parse({
    manifest: {
      id,
      version: '1.0.0',
      title: 'Тестовый пакет',
      industry: 'coffee',
      checked_at: '2026-09-18',
      cities: ['kazan'],
      region: { code: 'kazan', name: 'Казань', bbox: { south: 55.6, west: 48.8, north: 55.95, east: 49.4 } },
    },
    actions: [{ id: 'lease-premises', title: 'Арендовать помещение', lane: 'critical', duration_days: 14, why: 'w', do_now: 'd', done_when: 'x', kind: 'test_data' }],
  });
}

/** A content directory with the given location-index.json text per pack id. */
async function contentWith(snapshots: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'otkryvay-location-'));
  for (const [packId, text] of Object.entries(snapshots)) {
    await mkdir(join(dir, packId));
    await writeFile(join(dir, packId, 'location-index.json'), text);
  }
  return dir;
}

const tinyText = `${JSON.stringify(tinyLocationIndex, null, 2)}\n`;
const loadedMessage = (records: LogRecord[]) => records.find((r) => r.msg === 'location indexes loaded');

describe('loadLocationIndexes', () => {
  it('keeps the snapshot of a pack: the index, the file text as is and a strong ETag of that text', async () => {
    const { log, records } = recordingLog();
    const store = await loadLocationIndexes([packOf('kazan-coffee')], log, await contentWith({ 'kazan-coffee': tinyText }));

    const entry = store.get('kazan-coffee');
    expect(entry?.index).toEqual(tinyLocationIndex);
    expect(entry?.body).toBe(tinyText);
    expect(entry?.etag).toBe(`"${createHash('sha256').update(tinyText).digest('hex').slice(0, 16)}"`);
    expect(loadedMessage(records)).toMatchObject({ level: 30, locationIndexes: ['kazan-coffee@20260923T192821Z-3f9a1c2b'] });
  });

  it('skips a pack without a snapshot quietly: one info line, nothing at warn or error', async () => {
    const { log, records } = recordingLog();
    const store = await loadLocationIndexes([packOf('kazan-coffee')], log, await contentWith({}));

    expect(store.size).toBe(0);
    expect(records.filter((r) => r.level >= WARN)).toEqual([]);
    expect(records).toContainEqual(
      expect.objectContaining({ level: INFO, pack: 'kazan-coffee', msg: 'no location index: the map is off for this pack' }),
    );
    expect(loadedMessage(records)).toMatchObject({ locationIndexes: [] });
  });

  it.each([
    ['not JSON', 'kazan-coffee', '{ "format": ', { path: '', message: expect.stringContaining('JSON') }],
    ['against the schema', 'kazan-coffee', JSON.stringify({ ...tinyLocationIndex, format: 'otkryvay.location-index/2' }), { path: 'format' }],
    ['of another pack', 'demo', tinyText, { path: 'pack', message: expect.stringContaining('does not belong to pack "demo"') }],
  ])('turns the map off for a pack whose snapshot is %s and logs the issues', async (_, packId, text, issue) => {
    const { log, records } = recordingLog();
    const store = await loadLocationIndexes([packOf(packId)], log, await contentWith({ [packId]: text }));

    expect(store.size).toBe(0);
    const errors = records.filter((r) => r.level === ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ pack: packId, issues: expect.arrayContaining([expect.objectContaining(issue)]) });
  });

  it('logs the first 20 issues and their count: a broken builder can fail every cell', async () => {
    const text = JSON.stringify({ ...tinyLocationIndex, cells: { ...tinyLocationIndex.cells, row: Array.from({ length: 30 }, () => 'x') } });
    const { log, records } = recordingLog();
    await loadLocationIndexes([packOf('kazan-coffee')], log, await contentWith({ 'kazan-coffee': text }));

    const errors = records.filter((r) => r.level === ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ pack: 'kazan-coffee', issueCount: 30 });
    expect(errors[0]?.issues).toHaveLength(20);
  });

  it('turns the map off for a snapshot it cannot read, without failing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otkryvay-location-'));
    await mkdir(join(dir, 'kazan-coffee', 'location-index.json'), { recursive: true });
    const { log, records } = recordingLog();
    const store = await loadLocationIndexes([packOf('kazan-coffee')], log, dir);

    expect(store.size).toBe(0);
    expect(records.filter((r) => r.level === ERROR)).toEqual([expect.objectContaining({ pack: 'kazan-coffee' })]);
  });

  it('turns the map off for a pack whose loading throws, say on a bug in the core, and keeps the others', async () => {
    const { log, records } = recordingLog();
    const dir = await contentWith({ 'kazan-coffee': tinyText, demo: tinyText });
    const buggy: typeof parseLocationIndex = (raw, pack) => {
      if (pack?.manifest.id === 'demo') throw new TypeError('a bug in the core');
      return parseLocationIndex(raw, pack);
    };
    const store = await loadLocationIndexes([packOf('demo'), packOf('kazan-coffee')], log, dir, buggy);

    expect([...store.keys()]).toEqual(['kazan-coffee']);
    expect(records.filter((r) => r.level === ERROR)).toEqual([
      expect.objectContaining({ pack: 'demo', err: expect.objectContaining({ type: 'TypeError', message: 'a bug in the core' }) }),
    ]);
    expect(loadedMessage(records)).toMatchObject({ locationIndexes: ['kazan-coffee@20260923T192821Z-3f9a1c2b'] });
  });

  it('keeps serving the other packs when the snapshot of one is broken', async () => {
    const { log, records } = recordingLog();
    const dir = await contentWith({ 'kazan-coffee': tinyText, demo: '[]' });
    const store = await loadLocationIndexes([packOf('demo'), packOf('kazan-coffee')], log, dir);

    expect([...store.keys()]).toEqual(['kazan-coffee']);
    expect(records.filter((r) => r.level === ERROR)).toEqual([expect.objectContaining({ pack: 'demo' })]);
    expect(loadedMessage(records)).toMatchObject({ locationIndexes: ['kazan-coffee@20260923T192821Z-3f9a1c2b'] });
  });

  it('loads the committed snapshot of kazan-coffee and logs its version', async () => {
    const { log, records } = recordingLog();
    const store = await loadLocationIndexes([await loadRulesPack('kazan-coffee')], log);

    const entry = store.get('kazan-coffee');
    expect(entry?.body).toBe(await readFile(join(CONTENT_DIR, 'kazan-coffee', 'location-index.json'), 'utf8'));
    expect(entry?.index.linkedActions).toEqual(['lease-premises']);
    expect(entry?.index.version).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    expect(loadedMessage(records)).toMatchObject({ locationIndexes: [`kazan-coffee@${entry?.index.version}`] });
    expect(records.filter((r) => r.level >= WARN)).toEqual([]);
  });
});
