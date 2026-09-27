import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseLocationIndex, type LocationIndex, type ParseLocationResult, type RulesPack } from '@otkryvay/core';
import type { FastifyBaseLogger } from 'fastify';
import { CONTENT_DIR } from './load.js';

/** Snapshot of a pack for the «Карта» tab, written by the offline builder (doc-3 §4.5). */
export const LOCATION_INDEX_FILE = 'location-index.json';

export interface LoadedLocationIndex {
  index: LocationIndex;
  /** The file text exactly as validated: served as is, never serialized again. */
  body: string;
  /** Strong ETag of body: the first 16 hex digits of its sha256, quoted. */
  etag: string;
}

/** Valid snapshots by pack id; a pack without one has no entry and no map. */
export type LocationIndexStore = ReadonlyMap<string, LoadedLocationIndex>;

type ParseSnapshot = typeof parseLocationIndex;

/** A broken builder can fail every cell: the log keeps the first issues and their count. */
const MAX_LOGGED_ISSUES = 20;

/**
 * Reads content/<pack>/location-index.json of every pack. Unlike a rules pack, the map is optional: a missing
 * snapshot is skipped, and an unreadable or invalid one — or any failure while loading it — is logged and turns
 * the map off for its pack only: a wrong map is worse than no map, and the main scenario must not depend on it.
 * `parse` validates a snapshot; tests replace it to simulate a failure.
 */
export async function loadLocationIndexes(
  packs: readonly RulesPack[],
  log: FastifyBaseLogger,
  contentDir: string = CONTENT_DIR,
  parse: ParseSnapshot = parseLocationIndex,
): Promise<LocationIndexStore> {
  const store = new Map<string, LoadedLocationIndex>();
  for (const pack of packs) {
    const packId = pack.manifest.id;
    try {
      const loaded = await loadOne(pack, log, contentDir, parse);
      if (loaded) store.set(packId, loaded);
    } catch (error) {
      // Not a bad file but a bug, in the core say: still only this pack loses its map.
      log.error({ pack: packId, err: error }, 'location index failed to load: the map is off for this pack');
    }
  }
  log.info({ locationIndexes: [...store.values()].map(({ index }) => `${index.pack}@${index.version}`) }, 'location indexes loaded');
  return store;
}

async function loadOne(pack: RulesPack, log: FastifyBaseLogger, contentDir: string, parse: ParseSnapshot): Promise<LoadedLocationIndex | undefined> {
  const packId = pack.manifest.id;
  let body: string;
  try {
    body = await readFile(join(contentDir, packId, LOCATION_INDEX_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A pack without a map is normal, yet an operator should see it at the default level.
      log.info({ pack: packId }, 'no location index: the map is off for this pack');
    } else {
      log.error({ pack: packId, err: error }, 'location index cannot be read: the map is off for this pack');
    }
    return undefined;
  }

  const result = parseSnapshot(body, pack, parse);
  if (!result.ok) {
    const { issues } = result;
    log.error(
      { pack: packId, issues: issues.slice(0, MAX_LOGGED_ISSUES), issueCount: issues.length },
      'location index is invalid: the map is off for this pack',
    );
    return undefined;
  }
  return { index: result.value, body, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"` };
}

function parseSnapshot(body: string, pack: RulesPack, parse: ParseSnapshot): ParseLocationResult<LocationIndex> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    return { ok: false, issues: [{ path: '', message: `not valid JSON: ${(error as Error).message}` }] };
  }
  return parse(raw, pack);
}
