import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Region, RulesPack } from '@otkryvay/core';
import { CONTENT_DIR, loadRulesPack } from './load.js';

export interface PackRegistry {
  get(packId: string): RulesPack | undefined;
  /** Pack that covers the given city (Profile.city). */
  forCity(city: string): RulesPack | undefined;
  /** Regions offered during onboarding. */
  regions(): Region[];
  all(): RulesPack[];
}

export function createPackRegistry(packs: RulesPack[]): PackRegistry {
  const byId = new Map(packs.map((p) => [p.manifest.id, p]));
  return {
    get: (id) => byId.get(id),
    forCity: (city) => packs.find((p) => p.manifest.cities.includes(city)),
    regions: () => packs.map((p) => p.manifest.region),
    all: () => packs,
  };
}

/** Loads every content/<id>/pack.yaml. Any invalid pack aborts startup (PackLoadError). */
export async function loadPackRegistry(contentDir: string = CONTENT_DIR): Promise<PackRegistry> {
  const entries = await readdir(contentDir, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(join(contentDir, entry.name));
    if (files.includes('pack.yaml')) ids.push(entry.name);
  }
  const packs = await Promise.all(ids.sort().map((id) => loadRulesPack(id, contentDir)));
  return createPackRegistry(packs);
}
