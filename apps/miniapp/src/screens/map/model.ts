import type { LocationIndex } from '@otkryvay/core';

// State of the «Карта» screen that outlives it. Small on purpose: App imports it, so it is in the main chunk.

/** What the map shows first when a step opens it. */
export type MapFocus = { kind: 'place'; id: string } | { kind: 'cell'; cell: number } | { kind: 'index' };

/** The card open on the map: a cell of the location index or a place of the route. */
export type MapSelection = { kind: 'cell'; cell: number } | { kind: 'place'; id: string };

/**
 * Where a card was opened: from a list (or by a step) it is shown — the map flies to it, it takes the focus; from a tap
 * on the map the focus stays on the map, and the page moves only beside the lists, to bring a card out of sight into
 * view. Closing a card opened on the map does not send the page to the list.
 */
export type MapOpener = 'list' | 'map';

/** A map screen as the history keeps it, so «Назад» from a step returns to the same card and sections. */
export interface MapUi {
  selected: MapSelection | null;
  openedFrom: MapOpener;
  criteriaOpen: boolean;
}

/** Where the map canvas looks: [longitude, latitude] and zoom. Kept per screen, so «Назад» returns to the same view. */
export interface MapCamera {
  center: [number, number];
  zoom: number;
}

/**
 * Where the map is to go: a card opened from a list or by a step, or the area of the best places («Подобрать район на
 * карте»). A new object for every opening, even of the same card.
 */
export interface MapFlight {
  to: MapSelection | 'best';
}

/**
 * The map canvas in this session. A missing WebGL, a MapLibre that cannot start, a chunk that did not load, a style of
 * the app that MapLibre rejected or a map that broke drawing keep the lists alone until the app starts anew; a network
 * that failed the map (tiles, a slow chunk) or a lost WebGL context allow one more attempt, at the next opening of the
 * tab while online, or when the device comes online.
 */
export interface MapCanvasMemory {
  /** Whether the browser gives a WebGL context: asked once, before anything of the map is drawn. */
  webgl: boolean | null;
  failed: MapCanvasFailure | null;
  /** The failure may pass (the network, a moment): the map may be tried once more. */
  retryable: boolean;
  /** The one more attempt after such a failure was made. */
  retried: boolean;
}

/**
 * What stopped the map canvas (map_failed { kind }): no WebGL context, MapLibre could not start (init), its chunk
 * did not load or did not come in time, the style or the first tiles failed or did not come in time, the WebGL
 * context was lost and not given back, MapLibre failed drawing the data of the app.
 */
export type MapCanvasFailure =
  | 'webgl'
  | 'init'
  | 'map_chunk'
  | 'map_chunk_timeout'
  | 'tiles'
  | 'tiles_timeout'
  | 'context_lost'
  | 'draw';

/** What map_failed tells beyond its kind (strings and numbers of the analytics). */
export interface MapFailureDetails {
  /** How far the map got: no style came, the style came but no tile of the basemap, or the style with the app's layers was not valid. */
  stage?: 'style' | 'tiles' | 'overlay';
  /** Tiles of the basemap that came before the failure. */
  basemapTiles?: number;
  /** HTTP status of the request that failed, when there was one. */
  status?: number;
}

/** The location index of the route's pack: only the validated snapshot is kept, not the answer it came in. */
export type IndexState =
  | { status: 'loading' }
  | { status: 'ready'; ix: LocationIndex }
  | { status: 'invalid' }
  | { status: 'failed'; error: unknown };

/**
 * The analytics event of an opened card: `from` tells a tap on the map from a list (a step opens its card as a list
 * does). A cell number means something only within its snapshot, so the event names the version when it is known.
 */
export function cardOpenedEvent(
  selection: MapSelection,
  version: string | undefined,
  from: MapOpener,
): [type: string, props: Record<string, string | number>] {
  if (selection.kind === 'place') return ['place_opened', { place: selection.id, from }];
  return ['location_cell_opened', version ? { cell: selection.cell, version, from } : { cell: selection.cell, from }];
}

/** A new map screen: the card of the focused place or cell; «Подобрать район на карте» opens on the best places. */
export function initialUi(focus: MapFocus | undefined): MapUi {
  switch (focus?.kind) {
    case 'place':
      return { selected: { kind: 'place', id: focus.id }, criteriaOpen: false, openedFrom: 'list' };
    case 'cell':
      return { selected: { kind: 'cell', cell: focus.cell }, criteriaOpen: false, openedFrom: 'list' };
    case 'index':
      // The best places come into view; the criteria stay folded above them, one tap away.
      return { selected: null, criteriaOpen: false, openedFrom: 'list' };
    default:
      return { selected: null, criteriaOpen: false, openedFrom: 'list' };
  }
}
