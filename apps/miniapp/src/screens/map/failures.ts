import { ApiError } from '../../api.js';

// What went wrong with the «Карта» tab, for the pilot analytics (map_failed { kind }). Main chunk: small on purpose.
// The map canvas reports its own kinds (MapCanvasFailure in model.ts): the lists stand in for it then.

/** A chunk of the map did not load: no network, or a deploy replaced the chunk with one of another name. */
export class ChunkLoadError extends Error {
  constructor(cause: unknown) {
    super('a chunk of the map did not load', { cause });
    this.name = 'ChunkLoadError';
  }
}

export type MapFailureKind = 'chunk' | 'render' | 'timeout' | 'invalid_snapshot' | 'network';

/**
 * Why the snapshot did not come; null when there is nothing to report here: the pack has no index (404, an answer), or
 * the code of the map did not load, which MapShell reports, its boundary seeing the same failure.
 */
export function indexFailureKind(error: unknown): MapFailureKind | null {
  if (error instanceof ChunkLoadError) return null;
  if (error instanceof ApiError && error.status === 404) return null;
  if (error instanceof ApiError && error.code === 'timeout') return 'timeout';
  return 'network';
}
