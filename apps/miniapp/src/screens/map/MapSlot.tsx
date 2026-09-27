import { useColorScheme } from '@maxhub/max-ui';
import type { LocationIndex, RoutePlace, ScoreResult } from '@otkryvay/core';
import { useEffect, useEffectEvent, useRef, useState, type Ref } from 'react';
import { BIN_FLOORS, FLY_ZOOM, MAP_THEMES, mix, selectionCenter, startCamera, type MapTheme } from './mapLayers.js';
import { createMapView, hasWebGL, type MapViewHandle } from './mapView.js';
import type { MapCamera, MapCanvasFailure, MapCanvasMemory, MapFailureDetails, MapFlight, MapSelection } from './model.js';
// The styles of the canvas come with its chunk: the first screen does not load them.
import './MapSlot.css';

export interface MapSlotProps {
  /** The frame of the map, for the screen to bring into view; null in list mode. Its height is kept while it loads. */
  ref?: Ref<HTMLDivElement> | undefined;
  /** Whether the map is drawn in the frame (its first tiles): a tap in a list brings only a drawn map into view. */
  onReadyChange?: ((ready: boolean) => void) | undefined;
  /** The snapshot on screen: its grid is drawn once. */
  ix: LocationIndex | null;
  /** Its scores under the current settings: a new result recolours the grid, a re-render with the same one does not. */
  result: ScoreResult | null;
  places: readonly RoutePlace[];
  /** The open card, marked on the map. */
  selected: MapSelection | null;
  /** A card opened from a list or by a step, or the best places: the map goes there, once per opening. */
  flight: MapFlight | null;
  /** Where the map was left on this screen (a return from a step or from the route); undefined for a new screen. */
  camera: MapCamera | undefined;
  /** Keeps where the map looks, on every move: not state, nothing re-renders. */
  onCameraChange: (camera: MapCamera) => void;
  /** The map canvas in this session: whether there is WebGL, and a failure that keeps the lists alone. */
  memory: MapCanvasMemory;
  /**
   * Whether the lists are beside the map (a wide screen) rather than under it. Beside them the page does not scroll
   * over the map: the map takes the wheel and one finger. Above them one finger scrolls the page, and two move the map.
   */
  wide: boolean;
  /**
   * A tap on a cell opens its card, as a tap in «Лучшие места» does, but the focus stays on the map, and the page moves
   * only beside the lists, to bring a card out of sight into view.
   */
  onSelectCell: (cell: number) => void;
  /** A tap on a place opens its card, as a tap in «Места для шагов» does. */
  onSelectPlace: (id: string) => void;
  /** The map cannot be shown in this browser or network; reported once per failure. */
  onUnavailable: (kind: MapCanvasFailure, details: MapFailureDetails) => void;
  onOpenLink: (url: string) => void;
}

/** Failures of the network or of a moment: the map is tried once more. */
const TEMPORARY: ReadonlySet<MapCanvasFailure> = new Set(['map_chunk_timeout', 'tiles', 'tiles_timeout', 'context_lost']);

/** Whether a failure may pass. A style of the app that MapLibre rejected fails the same way on every network. */
function mayPass(kind: MapCanvasFailure, details: MapFailureDetails): boolean {
  return TEMPORARY.has(kind) && !(kind === 'tiles' && details.stage === 'overlay');
}

/** Whether the map may be tried once more: a failure that may pass, and the one more attempt not made yet. */
function mayRetry(memory: MapCanvasMemory): boolean {
  return memory.failed !== null && memory.retryable && !memory.retried;
}

/** Makes the one more attempt after a failure of the network. */
function retry(memory: MapCanvasMemory) {
  memory.failed = null;
  memory.retried = true;
}

/**
 * Whether the map is off when the screen opens. WebGL is asked for once per session, before anything of the map is
 * drawn: without it no frame shows up only to vanish. A failure of the network gets its one more attempt here, when
 * the device is online: offline it would only fail again, and the attempt waits for the device to come online.
 */
function offAtStart(memory: MapCanvasMemory): boolean {
  memory.webgl ??= hasWebGL();
  if (!memory.webgl) return true;
  if (mayRetry(memory) && navigator.onLine !== false) retry(memory);
  return memory.failed !== null;
}

/**
 * The map canvas above the lists, or beside them on a wide screen (MapLibre, in a chunk of its own): the index grid
 * coloured by the criteria, the places of the steps, the open card. While MapLibre loads, a placeholder keeps its
 * height, so nothing below moves. Without WebGL or tiles the slot stays empty and takes no space: the lists are the
 * whole map then (list mode), in one column on any screen.
 */
export function MapSlot(props: MapSlotProps) {
  const { ix, result, places, selected, flight, memory, wide } = props;
  const scheme = useColorScheme();
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<MapViewHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(() => offAtStart(memory));
  const shown = !failed && (ix !== null || places.length > 0);

  // Where the map looks: the history's at first, then the map's own. A new map (after a change of the colour scheme)
  // opens there.
  const camera = useRef(props.camera);
  // The flight the map has made: a re-created map does not repeat it.
  const flown = useRef<MapFlight | null>(null);

  const moved = useEffectEvent((next: MapCamera) => {
    camera.current = next;
    props.onCameraChange(next);
  });
  const fail = useEffectEvent((kind: MapCanvasFailure, details: MapFailureDetails = {}) => {
    if (memory.failed) return;
    memory.failed = kind;
    memory.retryable = mayPass(kind, details);
    setFailed(true);
    props.onUnavailable(kind, details);
  });
  const readyChanged = useEffectEvent((next: boolean) => props.onReadyChange?.(next));
  // Asked before the frame was drawn (a frame shows only with WebGL): the map does not ask again.
  const webglKnown = useEffectEvent(() => memory.webgl);
  // The gestures a new map opens with; the size of the screen is no reason for a new map.
  const gestures = useEffectEvent(() => !wide);
  const openCell = useEffectEvent((cell: number) => props.onSelectCell(cell));
  const openPlace = useEffectEvent((id: string) => props.onSelectPlace(id));
  const openLink = useEffectEvent((url: string) => props.onOpenLink(url));
  /**
   * A new map opens where the last one was left, else on the card a step asked for (kept at once: «Назад» returns
   * there even if the map is left before it is ready), else over the whole city; the best places are shown from there
   * as soon as they are known.
   */
  const startAt = useEffectEvent((): MapCamera => {
    if (camera.current) return camera.current;
    const to = flight?.to;
    const center = to && to !== 'best' ? selectionCenter(to, ix, places) : null;
    if (!center) return startCamera(ix, places);
    flown.current = flight;
    camera.current = { center, zoom: FLY_ZOOM };
    props.onCameraChange(camera.current);
    return camera.current;
  });

  // No WebGL is reported once per session, after the render: nothing is sent while rendering.
  useEffect(() => {
    if (memory.webgl === false) fail('webgl');
  }, [memory]);

  useEffect(() => readyChanged(ready), [ready]);

  // A failure of the network gets its one more attempt as soon as the device is back online.
  useEffect(() => {
    if (!failed) return;
    const online = () => {
      if (!mayRetry(memory)) return;
      retry(memory);
      setFailed(false);
    };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [failed, memory]);

  // One map per colour scheme, created after the render and removed in the cleanup (a StrictMode double mount
  // included): a view that arrives after its cleanup is destroyed at once.
  useEffect(() => {
    const element = container.current;
    if (!shown || !element) return;
    let active = true;
    let created: MapViewHandle | null = null;
    createMapView(element, {
      theme: MAP_THEMES[scheme],
      webgl: webglKnown(),
      camera: startAt(),
      cooperativeGestures: gestures(),
      onCellClick: (cell) => openCell(cell),
      onPlaceClick: (id) => openPlace(id),
      onCameraChange: (next) => moved(next),
      onReady: () => {
        if (active) setReady(true);
      },
      onUnavailable: (kind, details) => {
        if (active) fail(kind, details);
      },
      onOpenLink: (url) => openLink(url),
    }).then(
      (made) => {
        if (!active) {
          if (typeof made !== 'string') made.destroy();
          return;
        }
        if (typeof made === 'string') return fail(made);
        created = made;
        setView(made);
      },
      (error: unknown) => {
        console.warn('[map]', error);
        if (active) fail('init');
      },
    );
    return () => {
      active = false;
      created?.destroy();
      setView(null);
      setReady(false);
    };
  }, [shown, scheme]);

  useEffect(() => {
    view?.setIndex(ix && result ? { ix, scores: result.scores } : null);
  }, [view, ix, result]);
  useEffect(() => {
    view?.setPlaces(places);
  }, [view, places]);
  useEffect(() => {
    view?.select(selected);
  }, [view, selected]);
  // MAX widens or narrows its panel under an open map: the same map switches its gestures, and a map that comes once
  // MapLibre has loaded takes those of the screen by then. A new map would load its style and tiles again behind the
  // placeholder, and a flight still waiting for the index would be lost.
  useEffect(() => {
    view?.setCooperativeGestures(!wide);
  }, [view, wide]);
  useEffect(() => {
    if (!view || !flight || flown.current === flight) return;
    if (flight.to !== 'best') {
      flown.current = flight;
      view.flyTo(flight.to);
    } else if (result) {
      // The best places come with the scores: the map shows all of their area, not the whole city.
      flown.current = flight;
      view.showCells(result.top.map((place) => place.cell));
    }
  }, [view, flight, result]);

  if (!shown) return <div className="map-slot" data-testid="map-slot" />;
  return (
    <div className="map-slot map-slot--map" data-testid="map-slot">
      <div ref={props.ref} className={`map-frame map-frame--${scheme}`}>
        <div ref={container} className="map-view" />
        {!ready && (
          <div className="map-frame__loading" aria-hidden="true">
            <span className="map-frame__caption">Загружаем карту…</span>
          </div>
        )}
      </div>
      <MapLegend theme={MAP_THEMES[scheme]} ix={ix} withPlaces={places.length > 0} />
    </div>
  );
}

interface MapLegendProps {
  theme: MapTheme;
  ix: LocationIndex | null;
  withPlaces: boolean;
}

/**
 * What the colours and marks mean, and nothing more: the steps of the index and the marks. The basemap names its
 * sources in the «i» of MapLibre, over the map. The steps are pills across the width of the legend, the marks follow:
 * the places first, then the ground a cell keeps when it is not coloured.
 */
function MapLegend({ theme, ix, withPlaces }: MapLegendProps) {
  return (
    <div className="map-legend">
      {ix && (
        <div className="map-legend__row map-legend__row--scale">
          <span className="map-legend__title">Индекс места</span>
          <span className="map-legend__scale">
            {/* The scale is a picture: a screen reader hears what it says instead of «ниже», the steps and «выше». */}
            <span className="visually-hidden">от 0 до 100, чем выше — тем лучше место</span>
            <span className="muted" aria-hidden="true">ниже</span>
            {/* A swatch per step, as it looks over the whole city, and under it the index where the step starts. */}
            <span className="map-legend__bins" aria-hidden="true">
              {theme.bins.map((color, bin) => (
                <span key={color} className="map-legend__bin">
                  <span className="map-legend__swatch" style={{ background: mix(color, theme.basemap, theme.binOpacity.city) }} />
                  <span className="map-legend__tick">{BIN_FLOORS[bin]}</span>
                </span>
              ))}
            </span>
            <span className="muted" aria-hidden="true">выше</span>
          </span>
        </div>
      )}
      <div className="map-legend__row">
        {withPlaces && (
          <span className="map-legend__key">
            <span className="map-legend__place" style={{ background: theme.place }} aria-hidden="true" />
            Места для шагов
          </span>
        )}
        {ix && (
          <span className="map-legend__key">
            <span className="map-legend__empty" style={{ background: theme.basemap }} aria-hidden="true" />
            Без цвета — не проходит отбор или мало застройки
          </span>
        )}
      </div>
    </div>
  );
}
