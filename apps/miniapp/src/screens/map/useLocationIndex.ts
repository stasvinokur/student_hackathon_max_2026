import { startTransition, useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api.js';
import { ChunkLoadError, indexFailureKind } from './failures.js';
import type { IndexState } from './model.js';

/**
 * The location index of the route's pack: loaded when the map is first shown (≈ 477 KB, 77–80 KB over the network with
 * gzip or zstd), validated once, off the render, by the code of the map screen, and kept for the session as the
 * validated snapshot only. A load that failed is tried again at the next opening of the map.
 */
export function useLocationIndex(api: ApiClient | null, pack: string | undefined, shown: boolean) {
  const [state, setState] = useState<{ pack: string; index: IndexState } | null>(null);

  const load = useCallback(
    (pack: string) => {
      if (!api) return;
      setState({ pack, index: { status: 'loading' } });
      api
        .getLocationIndex(pack)
        .then(async (data) => {
          // The module of the map screen, loaded already when the map is on screen: a chunk that failed here fails the
          // screen too, and MapShell offers the way back.
          const { parseSnapshot } = await import('../MapScreen.js').catch((error: unknown) => {
            throw new ChunkLoadError(error);
          });
          const ix = parseSnapshot(data);
          if (!ix) api.sendEvent('map_failed', { kind: 'invalid_snapshot' });
          // Drawing the index is the heavy part: it must not hold up a tap.
          startTransition(() => setState({ pack, index: ix ? { status: 'ready', ix } : { status: 'invalid' } }));
        })
        .catch((error: unknown) => {
          const kind = indexFailureKind(error);
          if (kind) api.sendEvent('map_failed', { kind });
          setState({ pack, index: { status: 'failed', error } });
        });
    },
    [api],
  );

  const loadedPack = state?.pack;
  useEffect(() => {
    if (shown && pack && loadedPack !== pack) load(pack);
  }, [shown, pack, loadedPack, load]);

  return {
    /** Undefined when the pack has no index: the map shows the places only. */
    index: pack ? (state?.pack === pack ? state.index : ({ status: 'loading' } as const)) : undefined,
    retry: () => {
      if (pack) load(pack);
    },
    /** For a new opening of the map: a snapshot that did not come is asked for again, a loaded one is kept. */
    retryIfFailed: () => setState((current) => (current?.index.status === 'failed' ? null : current)),
  };
}
