import { useSyncExternalStore } from 'react';

// Whether the «Карта» tab lays its lists beside the map (MapScreen.css). The MAX bridge tells nothing of a panel
// widened to the window of the web client: the size of the iframe itself is the only sign, and the browser tells it.

/**
 * A screen wide and tall enough for the lists and the map side by side: the web client of MAX widened to its window, a
 * tablet. The height keeps a phone on its side (932×430) in one column: beside the lists the map would be a strip.
 */
export const WIDE_QUERY = '(min-width: 900px) and (min-height: 500px)';

/**
 * Whether the browser takes :has(). The wide rules of MapScreen.css ask for it (they apply only with a map in the
 * slot): without it the map stays above the lists in one column, and so it keeps the gestures of one column.
 */
function supportsHas(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('selector(:has(*))');
}

/** Whether the lists are beside the map now. */
export function isWideScreen(): boolean {
  return window.matchMedia(WIDE_QUERY).matches && supportsHas();
}

/**
 * Listens to the size of the iframe: MAX widens and narrows its panel under an open screen. The list is asked for
 * anew at every subscription and the listener is removed from that same list; none is kept in the module, where it
 * would outlive a matchMedia() replaced by a test. A change is only a signal: React asks isWideScreen() again, the one
 * source of the answer.
 */
function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(WIDE_QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/** Whether the lists are beside the map, following the size of the iframe. */
export function useWideScreen(): boolean {
  return useSyncExternalStore(subscribe, isWideScreen);
}
