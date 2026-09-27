import { parseLocationIndex, type LocationIndex } from '@otkryvay/core';

// Validation of a snapshot, in a chunk of its own: the schema brings zod with it, which the main chunk must not carry.

/** The snapshot the API sent, validated; null when it is not a valid snapshot (a wrong map is worse than none). */
export function parseSnapshot(data: unknown): LocationIndex | null {
  const result = parseLocationIndex(data);
  return result.ok ? result.value : null;
}
