import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseLocationCriteria, parseLocationIndex, scoreLocations, type LocationIndex, type RulesPack } from '@otkryvay/core';
import { parse as parseYaml } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkReferencePoint,
  CRITERIA_FILE,
  loadLocationFixtures,
  serializeLocationIndex,
  SNAPSHOT_FILE,
  type LocationFixtures,
} from '../../scripts/location-index/content.js';
import { CONTENT_DIR, loadRulesPack } from './load.js';

// The location index of kazan-coffee as committed: the methodology, the OSM snapshot built from it
// (pnpm --filter @otkryvay/api location-index --pack kazan-coffee) and the reference points (doc-3 §4.1).

const PACK = 'kazan-coffee';

let pack: RulesPack;
let criteriaBytes: Buffer;
let snapshotText: string;
let ix: LocationIndex;
let fixtures: LocationFixtures;

beforeAll(async () => {
  pack = await loadRulesPack(PACK);
  criteriaBytes = await readFile(join(CONTENT_DIR, PACK, CRITERIA_FILE));
  snapshotText = await readFile(join(CONTENT_DIR, PACK, SNAPSHOT_FILE), 'utf8');
  const parsed = parseLocationIndex(JSON.parse(snapshotText), pack);
  if (!parsed.ok) throw new Error(`the snapshot is invalid:\n${parsed.issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`);
  ix = parsed.value;
  const loaded = await loadLocationFixtures(CONTENT_DIR, PACK);
  if (!loaded) throw new Error('no location-fixtures.yaml');
  fixtures = loaded;
});

describe('location index of kazan-coffee', () => {
  it('has a methodology that passes validation: 10 criteria, 8 of demand and 2 penalties, a 300 m grid', () => {
    const config = parseLocationCriteria(parseYaml(criteriaBytes.toString('utf8')));
    if (!config.ok) throw new Error(JSON.stringify(config.issues));
    expect(config.value.criteria).toHaveLength(10);
    expect(config.value.criteria.filter((c) => c.role === 'demand')).toHaveLength(8);
    expect(config.value.criteria.filter((c) => c.role === 'penalty').map((c) => c.model)).toEqual(['saturation', 'share']);
    expect(config.value.grid.cell_meters).toBe(300);
    expect(config.value.linked_actions).toEqual(['lease-premises']);
  });

  it('has a snapshot built from the committed methodology (rebuild it after changing location-criteria.yaml)', () => {
    expect(ix.source.configSha256).toBe(createHash('sha256').update(criteriaBytes).digest('hex'));
    expect(ix.pack).toBe(PACK);
  });

  it('carries the ODbL notice of OpenStreetMap and the date of the data', () => {
    expect(ix.source).toMatchObject({
      name: 'OpenStreetMap',
      licence: 'ODbL-1.0',
      licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
      attribution: '© участники OpenStreetMap',
      attributionUrl: 'https://www.openstreetmap.org/copyright',
      method: 'https://github.com/trade-stasvinokur/student_hackathon_max_2026/tree/main/apps/api/src/scripts/location-index',
    });
    expect(ix.source.osmBase).toMatch(/^2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(ix.source.extractedAt >= ix.source.osmBase).toBe(true);
  });

  it('covers the built-up city: 3–9 thousand cells', () => {
    expect(ix.cells.row.length).toBeGreaterThanOrEqual(3000);
    expect(ix.cells.row.length).toBeLessThanOrEqual(9000);
  });

  it('is written as the pipeline writes it', () => {
    expect(serializeLocationIndex(JSON.parse(snapshotText) as LocationIndex)).toBe(snapshotText);
  });

  it('passes the reference points with the default importance', () => {
    expect(fixtures.points.map((p) => p.id)).toEqual(expect.arrayContaining(['kremlyovskaya', 'bauman', 'volga']));
    const result = scoreLocations(ix);
    for (const point of fixtures.points) {
      const check = checkReferencePoint(ix, result, point);
      expect.soft(check.failures, `${point.id}: ${check.summary}`).toEqual([]);
    }
  });
});
