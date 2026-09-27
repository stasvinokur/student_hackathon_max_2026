import { IMPORTANCE, scoreLocations, type Importance, type LocationIndex, type LocationSettings } from '@otkryvay/core';
import { useMemo, useState } from 'react';

// Criteria settings in local storage. Every access is guarded: private modes and embedded browsers may refuse
// storage or throw on it, and the map must work the same, only forgetting the settings.

/**
 * The settings of the snapshot on screen and its scores. They are read once per snapshot, the session memory first
 * (it outlives the screen when storage fails); a change goes to both, and the index is rescored at once (≈ 2 ms for
 * Kazan).
 */
export function useLocationSettings(ix: LocationIndex | null, memory: Map<string, LocationSettings>) {
  const key = ix ? settingsKey(ix) : null;
  const stored = useMemo(() => (ix && key ? (memory.get(key) ?? readSettings(ix)) : {}), [ix, key, memory]);
  const [changed, setChanged] = useState<{ key: string; settings: LocationSettings } | null>(null);
  const settings = changed && changed.key === key ? changed.settings : stored;
  const result = useMemo(() => (ix ? scoreLocations(ix, settings) : null), [ix, settings]);

  const update = (next: LocationSettings) => {
    if (!ix || !key) return;
    setChanged({ key, settings: next });
    memory.set(key, next);
    saveSettings(ix, next);
  };
  return { settings, result, update };
}

/**
 * One key per methodology: the pack and the first 8 hex digits of its config hash. A data refresh with the same
 * methodology keeps the settings; a new methodology starts from its own defaults (known() drops criteria it lacks).
 */
export function settingsKey(ix: LocationIndex): string {
  return `location:${ix.pack}:${ix.source.configSha256.slice(0, 8)}`;
}

/** The stored settings of a methodology; anything unreadable counts as none. */
export function readSettings(ix: LocationIndex): LocationSettings {
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(settingsKey(ix));
  } catch {
    return {};
  }
  if (stored === null) return {};
  try {
    return known(JSON.parse(stored), ix);
  } catch {
    return {};
  }
}

/** Stores the settings; none at all removes the key. */
export function saveSettings(ix: LocationIndex, settings: LocationSettings): void {
  try {
    if (Object.keys(settings).length === 0) window.localStorage.removeItem(settingsKey(ix));
    else window.localStorage.setItem(settingsKey(ix), JSON.stringify(settings));
  } catch {
    // Storage refused: the settings last until the app closes.
  }
}

/** Only the criteria of the snapshot with a known level: old or edited storage must not reach the panel. */
function known(value: unknown, ix: LocationIndex): LocationSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const settings: Record<string, Importance> = {};
  for (const { id } of ix.criteria) {
    const level: unknown = Object.hasOwn(value, id) ? (value as Record<string, unknown>)[id] : undefined;
    if (typeof level === 'string' && (IMPORTANCE as readonly string[]).includes(level)) settings[id] = level as Importance;
  }
  return settings;
}
