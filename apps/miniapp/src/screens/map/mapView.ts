import type { LocationIndex, RoutePlace } from '@otkryvay/core';
import type { GeoJSONSource, Map as MapLibreMap, MapLibreEvent, MapMouseEvent } from 'maplibre-gl';
import {
  cellsBounds,
  cellsToGeoJson,
  EXCLUDED_BIN,
  FLY_ZOOM,
  mapBounds,
  OVERLAY,
  placesToGeoJson,
  russianLabels,
  scoreBin,
  selectionCenter,
  selectionToGeoJson,
  withOverlay,
  type MapTheme,
} from './mapLayers.js';
import type { MapCamera, MapCanvasFailure, MapFailureDetails, MapSelection } from './model.js';

// The map canvas of the «Карта» tab: the only module that touches MapLibre. MapLibre (≈ 273 KB gzip) and its CSS
// come in a chunk of their own, loaded when a map is shown, so the lists never wait for them. Everything that can go
// wrong with a map in a WebView (no WebGL, a chunk or tiles that do not come, a context that is not given back, an
// exception of MapLibre) ends in onUnavailable or in a failed start: the React boundary would not see these
// asynchronous failures, and the lists stand in for the map.

export interface MapViewOptions {
  theme: MapTheme;
  /** Whether the browser gives a WebGL context, when that was asked already (the slot asks before it draws a frame). */
  webgl?: boolean | null | undefined;
  /** Where the map opens. */
  camera: MapCamera;
  /** Whether the page scrolls over the map: two fingers move it then, or the wheel with Ctrl or ⌘ (yes by default). */
  cooperativeGestures?: boolean | undefined;
  onCellClick: (cell: number) => void;
  onPlaceClick: (id: string) => void;
  /** Where the map looks after every move (and where a flight goes), for the history to keep it. */
  onCameraChange: (camera: MapCamera) => void;
  /** The style and the first tiles are on screen. */
  onReady: () => void;
  /** The map cannot be shown after all: called at most once, and the view is to be destroyed. */
  onUnavailable: (reason: MapUnavailable, details: MapFailureDetails) => void;
  /** A link of the attribution: a WebView must not follow it inside the app. */
  onOpenLink: (url: string) => void;
}

/** Why no map started: no WebGL context, MapLibre could not start, its chunk did not load or did not come in time. */
export type MapStartFailure = Extract<MapCanvasFailure, 'webgl' | 'init' | 'map_chunk' | 'map_chunk_timeout'>;

/** What a map that started can still run into. */
export type MapUnavailable = Extract<MapCanvasFailure, 'tiles' | 'tiles_timeout' | 'context_lost' | 'draw'>;

export interface MapIndex {
  ix: LocationIndex;
  /** The scores of the current settings: a new array recolours the grid, the same one does nothing. */
  scores: ReadonlyArray<number | null>;
}

export interface MapViewHandle {
  /** The grid is drawn once per snapshot; new scores only recolour it. */
  setIndex(index: MapIndex | null): void;
  setPlaces(places: readonly RoutePlace[]): void;
  /** Marks the open card; a cell of an index not yet set is marked when it comes. */
  select(selection: MapSelection | null): void;
  /** Shows a card: flies there once the map is on screen, jumps while it loads, waits for the index for a cell. */
  flyTo(target: MapSelection): void;
  /** Shows the area of some cells (the best places) the same way. */
  showCells(cells: readonly number[]): void;
  /**
   * Turns MapLibre's cooperative gestures on or off on the living map (nothing after destroy() or a failure). The screen
   * widens or narrows under an open map; a new map would load its style and tiles again behind the placeholder, and a
   * flight still waiting for the index would be lost.
   */
  setCooperativeGestures(on: boolean): void;
  destroy(): void;
}

/** The style and the first tiles must come in this much visible time, or the lists stand in for the map (doc-3 §8). */
export const LOAD_TIMEOUT_MS = 15_000;
/** The MapLibre chunk (≈ 273 KB gzip) must come in this much visible time. */
export const CHUNK_TIMEOUT_MS = 15_000;
/** A lost WebGL context must be given back in this much visible time; phones take it when the app goes to the background. */
export const RESTORE_TIMEOUT_MS = 5_000;

const SOURCE = OVERLAY.sources;
const LAYER = OVERLAY.layers;

/** A cell not coloured yet. */
const UNSET = -2;
/** A finger is wider than the marker of a place: a tap this close (px) still opens it. */
const TAP_SLOP = 12;
/** Room around an area the map shows, px. */
const AREA_PADDING = 32;
const EMPTY = { type: 'FeatureCollection', features: [] } as const;

/** The strings MapLibre shows, in Russian. */
const LOCALE: Record<string, string> = {
  'AttributionControl.ToggleAttribution': 'Источники карты',
  'AttributionControl.MapFeedback': 'Сообщить об ошибке на карте',
  'Map.Title': 'Карта мест',
  'NavigationControl.ZoomIn': 'Приблизить',
  'NavigationControl.ZoomOut': 'Отдалить',
  'CooperativeGesturesHandler.WindowsHelpText': 'Чтобы изменить масштаб, прокручивайте с нажатой Ctrl',
  'CooperativeGesturesHandler.MacHelpText': 'Чтобы изменить масштаб, прокручивайте с нажатой ⌘',
  'CooperativeGesturesHandler.MobileHelpText': 'Двигайте карту двумя пальцами',
};

/** Whether the browser gives a WebGL context at all; the probe's context is released at once. MapLibre is not needed. */
export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** [longitude, latitude] of what MapLibre gives as a point. */
function lngLat(point: import('maplibre-gl').LngLatLike): [number, number] {
  if (Array.isArray(point)) return [point[0], point[1]];
  return 'lng' in point ? [point.lng, point.lat] : [point.lon, point.lat];
}

/**
 * A timeout that counts only the time the app is shown: a WebView in the background loads and draws nothing, and its
 * deadline starts again when it is shown. Returns what stops it.
 */
function visibleTimeout(ms: number, done: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', arm);
  };
  function arm() {
    clearTimeout(timer);
    timer = document.hidden ? undefined : setTimeout(() => (stop(), done()), ms);
  }
  document.addEventListener('visibilitychange', arm);
  arm();
  return stop;
}

class ChunkTimeout extends Error {}

/** MapLibre and its CSS; a chunk that does not come in time counts as not loaded. */
function loadMapLibre(): Promise<typeof import('maplibre-gl')> {
  return new Promise((resolve, reject) => {
    const stop = visibleTimeout(CHUNK_TIMEOUT_MS, () => reject(new ChunkTimeout('the MapLibre chunk did not come in time')));
    Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl.css')]).then(
      ([module]) => {
        stop();
        // MapLibre is a UMD bundle: the bundler hands it over as the default export.
        resolve(('default' in module && module.default ? module.default : module) as typeof import('maplibre-gl'));
      },
      (error: unknown) => {
        stop();
        reject(error);
      },
    );
  });
}

/**
 * Opens a map in the slot. A start that fails gives its reason: 'webgl' (no WebGL context; MapLibre is not even
 * loaded then), 'map_chunk' or 'map_chunk_timeout', 'init' (MapLibre could not start). The view is returned before the
 * style loads: it keeps what it is given until then.
 */
export async function createMapView(slot: HTMLElement, options: MapViewOptions): Promise<MapViewHandle | MapStartFailure> {
  if (!(options.webgl ?? hasWebGL())) return 'webgl';
  let maplibre: typeof import('maplibre-gl');
  try {
    maplibre = await loadMapLibre();
  } catch (error) {
    console.warn('[map]', error);
    return error instanceof ChunkTimeout ? 'map_chunk_timeout' : 'map_chunk';
  }
  // Every map has a container of its own, removed with it: a map removed while the next one opens in the same slot
  // (a StrictMode double mount, a change of the colour scheme) never touches that one.
  const container = document.createElement('div');
  container.style.cssText = 'width: 100%; height: 100%';
  slot.append(container);
  let map: MapLibreMap;
  try {
    map = new maplibre.Map({
      container,
      center: options.camera.center,
      zoom: options.camera.zoom,
      minZoom: 9,
      maxZoom: 17,
      // Where the page scrolls over the map, one finger scrolls it, two move the map; on a desktop, Ctrl or ⌘ with the
      // wheel. Beside the lists the map is a pane of its own: it takes the wheel and one finger.
      cooperativeGestures: options.cooperativeGestures ?? true,
      // Compact: the «i» keeps OpenFreeMap, OpenMapTiles and OpenStreetMap one tap away on a phone.
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      renderWorldCopies: false,
      locale: LOCALE,
    });
  } catch (error) {
    // A WebGL context was there, but MapLibre could not start on it (a blocklisted GPU, a failed shader).
    console.warn('[map]', error);
    container.remove();
    return 'init';
  }
  try {
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
    return mountView(map, container, options, () => maplibre.prewarm());
  } catch (error) {
    console.warn('[map]', error);
    map.remove();
    container.remove();
    return 'init';
  }
}

function mountView(map: MapLibreMap, container: HTMLElement, options: MapViewOptions, prewarm: () => void): MapViewHandle {
  // What the map is to show…
  let index: MapIndex | null = null;
  let places: readonly RoutePlace[] = [];
  let selection: MapSelection | null = null;
  // Where the map is to go next: a card, or the area of some cells.
  let flight: { to: MapSelection } | { cells: readonly number[] } | null = null;
  // …and what it shows: the grid is drawn once per snapshot, a cell is recoloured only when its step changes.
  let drawnIx: LocationIndex | null = null;
  let drawnScores: MapIndex['scores'] | null = null;
  let drawnBins = new Int8Array(0);
  let styleFetched = false; // the style came (MapLibre handed it to transformStyle)
  let styled = false; // the style with the layers of the app is loaded
  let lost = false; // the WebGL context is lost, and MapLibre is to restore it
  let restyle = false; // the context was lost before the style loaded: MapLibre kept none to set again
  let ready = false; // the first tiles are on screen
  // Failed or destroyed: nothing is drawn or reported any more. MapLibre drops its style on a lost WebGL context and
  // in remove(), and its style methods would throw, while the screen may still push data until it removes the view.
  let over = false;
  let removed = false;
  let basemapTiles = 0;
  let failedTiles = 0;
  let stopDeadline: (() => void) | null = null;
  let stopRestore: (() => void) | null = null;
  // Where the mouse is, and the frame that will tell whether it is over what can be opened.
  let hover: MapMouseEvent['point'] | null = null;
  let hoverFrame = 0;

  /** The sources of the app are no basemap: their tiles and errors say nothing about the tiles of OpenFreeMap. */
  const isBasemap = (sourceId: unknown) => typeof sourceId === 'string' && !sourceId.startsWith('otk-');
  const camera = (): MapCamera => {
    const { lng, lat } = map.getCenter();
    return { center: [lng, lat], zoom: map.getZoom() };
  };
  const source = (id: string) => (styled && !lost && !over ? map.getSource<GeoJSONSource>(id) : undefined);
  /** How far the map got: no style came, the style with the layers of the app was not loaded, or no tile came. */
  const stage = (): NonNullable<MapFailureDetails['stage']> => (!styleFetched ? 'style' : !styled ? 'overlay' : 'tiles');

  function stopWaiting() {
    stopDeadline?.();
    stopDeadline = null;
    stopRestore?.();
    stopRestore = null;
  }
  function fail(reason: MapUnavailable, details: MapFailureDetails = {}) {
    if (over) return;
    over = true;
    stopWaiting();
    options.onUnavailable(reason, details);
  }
  function markReady() {
    if (over || ready) return;
    ready = true;
    stopDeadline?.();
    stopDeadline = null;
    options.onReady();
    options.onCameraChange(camera());
    // MapLibre keeps its workers after the last map is removed: the next opening of the tab starts faster.
    prewarm();
  }
  /** Draws on the map; an exception of MapLibre ends the map, never the screen around it. */
  function guard(work: () => void) {
    if (over) return;
    try {
      work();
    } catch (error) {
      console.warn('[map]', error);
      fail('draw');
    }
  }

  function drawIndex() {
    const grid = source(SOURCE.grid);
    if (!grid) return;
    const ix = index?.ix ?? null;
    if (ix !== drawnIx) {
      drawnIx = ix;
      drawnScores = null;
      drawnBins = new Int8Array(ix ? ix.cells.row.length : 0).fill(UNSET);
      grid.setData(ix ? cellsToGeoJson(ix) : EMPTY);
    }
    if (!index || index.scores === drawnScores) return;
    drawnScores = index.scores;
    for (let cell = 0; cell < drawnBins.length; cell++) {
      const bin = scoreBin(index.scores[cell] ?? null) ?? EXCLUDED_BIN;
      if (drawnBins[cell] === bin) continue;
      drawnBins[cell] = bin;
      map.setFeatureState({ source: SOURCE.grid, id: cell }, { bin });
    }
  }

  function drawPlaces() {
    source(SOURCE.places)?.setData(placesToGeoJson(places));
  }

  function drawSelection() {
    source(SOURCE.selection)?.setData(selectionToGeoJson(selection, index?.ix ?? null, places));
  }

  function limit() {
    map.setMaxBounds(mapBounds(index?.ix ?? null, places));
  }

  /** Where a flight goes: a card at street level (closer, if the map is closer already), or all of an area. */
  function destination(next: NonNullable<typeof flight>): MapCamera | null {
    const ix = index?.ix ?? null;
    if ('to' in next) {
      const center = selectionCenter(next.to, ix, places);
      return center && { center, zoom: Math.max(FLY_ZOOM, map.getZoom()) };
    }
    const bounds = ix && cellsBounds(ix, next.cells);
    const target = bounds && map.cameraForBounds(bounds, { padding: AREA_PADDING, maxZoom: FLY_ZOOM });
    if (!target?.center || target.zoom === undefined) return null;
    return { center: lngLat(target.center), zoom: target.zoom };
  }

  function fly() {
    if (!flight || lost) return; // a flight asked for while the context is lost waits for its restore
    if (!index && !('to' in flight && flight.to.kind === 'place')) return; // the index is still to come
    const camera = destination(flight);
    if (!camera) return; // the place is still to come
    flight = null;
    // Before the first tiles there is nothing to fly over: the map starts right there.
    if (ready) map.flyTo(camera);
    else map.jumpTo(camera);
    // The flight may be cut short by leaving the screen: «Назад» still returns to where it went.
    options.onCameraChange(camera);
  }

  const openLink = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    options.onOpenLink(link.href);
  };
  container.addEventListener('click', openLink);

  map.on('style.load', () =>
    guard(() => {
      styled = true;
      drawIndex();
      drawPlaces();
      drawSelection();
      fly();
    }),
  );
  // The first tile of the basemap is the map on screen: the placeholder goes, the rest comes in.
  map.on('sourcedata', (event) => {
    if (!event.tile || !isBasemap(event.sourceId)) return;
    basemapTiles++;
    markReady();
  });
  // Before the first tiles, an error of the style or of a source (no tile in it) means no map, and so does a basemap
  // that sent no tile at all; a single tile that failed is only a hole, asked for again at the next move, and so it is
  // after the first tiles. MapLibre says nothing of its errors once they are listened to: the adapter says them, all
  // but the holes of a map on screen (a worker that could not take the data of the app, say).
  map.on('error', (event: { error?: unknown; tile?: unknown; sourceId?: unknown }) => {
    if (over) return;
    if (ready) {
      if (!event.tile) console.warn('[map]', event.error);
      return;
    }
    console.warn('[map]', event.error);
    if (event.tile) {
      if (isBasemap(event.sourceId)) failedTiles++;
      return;
    }
    const status = (event.error as { status?: unknown } | undefined)?.status;
    fail('tiles', { stage: stage(), basemapTiles, ...(typeof status === 'number' ? { status } : {}) });
  });
  map.on('load', () => {
    if (over || ready) return;
    if (basemapTiles === 0 && failedTiles > 0) return fail('tiles', { stage: 'tiles', basemapTiles });
    markReady();
  });
  // Phones take the WebGL context of an app in the background. MapLibre keeps a loaded style, the data of its sources
  // included, and sets it again when the context comes back: the grid is not sent to its worker again, only its colours
  // (feature-state) are lost and set anew at the next style.load. A style that had not loaded yet is not kept: the
  // adapter asks for it again, or the placeholder would wait for it until the deadline.
  map.on('webglcontextlost', () => {
    if (over) return;
    lost = true;
    restyle = !styled;
    styled = false;
    drawnScores = null;
    drawnBins.fill(UNSET);
    stopRestore?.();
    stopRestore = visibleTimeout(RESTORE_TIMEOUT_MS, () => fail('context_lost'));
  });
  map.on('webglcontextrestored', () => {
    lost = false;
    stopRestore?.();
    stopRestore = null;
    if (!restyle || over) return;
    restyle = false;
    // A map that was on screen loads anew, as at the start: its first tiles have their deadline, and an error of its
    // style ends it. A network gone now would leave an empty frame otherwise.
    if (ready) {
      ready = false;
      basemapTiles = 0;
      failedTiles = 0;
      startDeadline();
    }
    guard(loadStyle);
  });
  map.on('moveend', () => {
    if (!over && ready) options.onCameraChange(camera());
  });
  map.on('click', (event: MapMouseEvent) =>
    guard(() => {
      if (!styled) return;
      const { x, y } = event.point;
      const near: [[number, number], [number, number]] = [
        [x - TAP_SLOP, y - TAP_SLOP],
        [x + TAP_SLOP, y + TAP_SLOP],
      ];
      // A place wins over the cell it stands in, by its marker only: its name, three or four lines long at times,
      // must not swallow the taps on the cells under it.
      const place: unknown = map.queryRenderedFeatures(near, { layers: [LAYER.places] })[0]?.properties?.id;
      if (typeof place === 'string') return options.onPlaceClick(place);
      const cell: unknown = map.queryRenderedFeatures(event.point, { layers: [LAYER.grid] })[0]?.properties?.cell;
      if (typeof cell === 'number') options.onCellClick(cell);
    }),
  );
  // The attribution shows when the map opens and folds into its «i» after the first touch of the map. MapLibre folds it
  // at a drag only, which takes two fingers here: a tap or a zoom folds it as well. A zoom of the app's own (a flight to
  // a card, the best places) is no touch: only a gesture or a zoom button comes with the event of the browser.
  const foldAttribution = () => {
    container.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact')?.classList.remove('maplibregl-compact-show');
    map.off('click', foldAttribution);
    map.off('zoomstart', foldAtZoom);
  };
  const foldAtZoom = (event: MapLibreEvent<MouseEvent | TouchEvent | WheelEvent | undefined>) => {
    if (event.originalEvent) foldAttribution();
  };
  map.on('click', foldAttribution);
  map.on('zoomstart', foldAtZoom);
  // The pointer over what can be opened. The map is asked once a frame at most, for both layers at once (a listener of
  // a layer asks it at every move of the mouse), and not at all while the context is lost: it has no style then.
  const pointAt = () => {
    hoverFrame = 0;
    if (!hover || !styled || lost || over) return;
    const hit = map.queryRenderedFeatures(hover, { layers: [LAYER.grid, LAYER.places] }).length > 0;
    map.getCanvas().style.cursor = hit ? 'pointer' : '';
  };
  map.on('mousemove', (event: MapMouseEvent) => {
    hover = event.point;
    hoverFrame ||= requestAnimationFrame(pointAt);
  });
  map.on('mouseout', () => {
    hover = null;
    map.getCanvas().style.cursor = '';
  });

  /** Asks for the style of the map. A new style comes with empty sources: nothing of the app is drawn in it yet. */
  function loadStyle() {
    styleFetched = false;
    drawnIx = null;
    drawnScores = null;
    map.setStyle(options.theme.style, {
      transformStyle: (_previous, next) => {
        styleFetched = true;
        return withOverlay(russianLabels(next), options.theme);
      },
    });
  }
  /** The deadline asks for the first tile of the basemap, not for every tile of the view. */
  function startDeadline() {
    stopDeadline?.();
    stopDeadline = visibleTimeout(LOAD_TIMEOUT_MS, () => {
      stopDeadline = null;
      if (!over && !ready) fail('tiles_timeout', { stage: stage(), basemapTiles });
    });
  }
  loadStyle();
  startDeadline();

  return {
    setIndex: (next) =>
      guard(() => {
        const newSnapshot = (next?.ix ?? null) !== (index?.ix ?? null);
        index = next;
        if (newSnapshot) limit();
        drawIndex();
        drawSelection();
        fly();
      }),
    setPlaces: (next) =>
      guard(() => {
        places = next;
        if (!index) limit();
        drawPlaces();
        drawSelection();
        fly();
      }),
    select: (next) =>
      guard(() => {
        selection = next;
        drawSelection();
      }),
    flyTo: (target) =>
      guard(() => {
        flight = { to: target };
        fly();
      }),
    showCells: (cells) =>
      guard(() => {
        flight = { cells };
        fly();
      }),
    setCooperativeGestures: (on) =>
      guard(() => {
        if (on) map.cooperativeGestures.enable();
        else map.cooperativeGestures.disable();
      }),
    destroy() {
      if (removed) return;
      removed = true;
      over = true;
      stopWaiting();
      cancelAnimationFrame(hoverFrame);
      container.removeEventListener('click', openLink);
      try {
        map.remove();
      } catch (error) {
        console.warn('[map]', error);
      }
      container.remove();
    },
  };
}
