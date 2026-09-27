import { Button } from '@maxhub/max-ui';
import { explainCell, type LocationIndex, type LocationSettings, type RoutePlace, type RouteView } from '@otkryvay/core';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ApiError, type ApiClient } from '../api.js';
import type { Bridge } from '../bridge.js';
import { MessageState, Screen } from '../components/ui.js';
import { CellCard } from './map/CellCard.js';
import { CriteriaPanel } from './map/CriteriaPanel.js';
import { IndexHeader, IndexProblemHeader, IndexSkeleton, PlacesHeader } from './map/Headers.js';
import { MapSlot } from './map/MapSlot.js';
import {
  cardOpenedEvent,
  initialUi,
  type IndexState,
  type MapCamera,
  type MapCanvasMemory,
  type MapFlight,
  type MapFocus,
  type MapOpener,
  type MapSelection,
  type MapUi,
} from './map/model.js';
import { PlaceCard, PlaceList } from './map/Places.js';
import { useLocationSettings } from './map/settings.js';
import { TopList } from './map/TopList.js';
import { useWideScreen } from './map/wide.js';
// The layout of the tab and the styles of its lists and cards come with its chunk, as the styles of the canvas do: the
// first screen does not load them.
import './map/map.css';
import './MapScreen.css';

// The index loader takes the validation from this module: no chunk of its own, which Chromium would remember as failed.
export { parseSnapshot } from './map/snapshot.js';

// The «Карта» tab (doc-3 §8), loaded as a separate chunk: the map canvas over the lists of the location index of the
// route's pack and of the places of its steps, or beside them on a wide screen (the panel of MAX widened to the window
// of the web client). The lists work without the canvas (list mode: no WebGL, no tiles).

export interface MapScreenProps {
  route: RouteView;
  /** The index of the route's pack; undefined when the pack has none, and the map shows the places only. */
  index: IndexState | undefined;
  onRetryIndex: () => void;
  /** What a step asked to show; ignored when the screen comes back with its saved state. */
  focus: MapFocus | undefined;
  savedUi: MapUi | undefined;
  onUiChange: (ui: MapUi) => void;
  /** Where the map canvas was left on this screen; undefined for a new screen. */
  savedCamera: MapCamera | undefined;
  onCameraChange: (camera: MapCamera) => void;
  settingsMemory: Map<string, LocationSettings>;
  /** Whether the map canvas failed in this session. */
  canvasMemory: MapCanvasMemory;
  api: ApiClient;
  bridge: Bridge;
  tabs: ReactNode;
  onBack: (() => void) | undefined;
  onOpenTask: (id: string) => void;
}

/** A route without places (an API older than the map): the same empty list on every render. */
const NO_PLACES: readonly RoutePlace[] = [];

/** The selected cell when the snapshot has it: a focus from outside may name a cell of another snapshot. */
function selectedCell(ix: LocationIndex, selected: MapSelection | null): number | null {
  if (selected?.kind !== 'cell') return null;
  const { cell } = selected;
  return Number.isInteger(cell) && cell >= 0 && cell < ix.cells.row.length ? cell : null;
}

function sameSelection(a: MapSelection | null, b: MapSelection): boolean {
  if (a?.kind === 'cell' && b.kind === 'cell') return a.cell === b.cell;
  if (a?.kind === 'place' && b.kind === 'place') return a.id === b.id;
  return false;
}

/** The row of a card in «Лучшие места» or «Места для шагов», if the list shows it. */
function rowOf(selection: MapSelection): HTMLElement | undefined {
  const rows = document.querySelectorAll<HTMLElement>(selection.kind === 'cell' ? '[data-cell]' : '[data-place]');
  return [...rows].find((row) =>
    selection.kind === 'cell' ? row.dataset.cell === String(selection.cell) : row.dataset.place === selection.id,
  );
}

/** An element the focus can go back to: still on the page, and not the page itself. */
function focusable(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.isConnected && element !== document.body;
}

/** How much of a card must show above the bottom of the screen, px: enough to see that it opened. */
const PEEK = 96;

/** Who asked to show a card or the best places: a step (from another screen), or a tap in a list or on the map. */
type Asker = 'step' | 'list' | 'map';

/**
 * The map to bring into view with what was asked for: 'beside' when it is in view already, pinned beside the lists (a
 * wide screen), drawn or not; none in list mode. Above the lists a step asked to see its place or area on the map: the
 * map comes into view even while it loads, it keeps its height and opens right there. A tap in a list shows the map
 * only once it is drawn: until then a placeholder is no sight to scroll to, and the card itself comes into view.
 */
function mapFor(
  asker: Asker,
  frame: RefObject<HTMLElement | null>,
  drawn: RefObject<boolean>,
  wide: boolean,
): HTMLElement | 'beside' | null {
  if (wide && frame.current) return 'beside';
  return asker === 'step' || drawn.current ? frame.current : null;
}

/**
 * Whether a card (or a list) is in sight beside the map: its top no higher than the top of the pinned map (the scroll
 * padding of the page, under the section switch or «Назад»), and high enough for PEEK of it to show above the bottom
 * of the screen. The padding is read in px, as the app sets it: a percentage would stay one in the computed value.
 */
function inSight(target: HTMLElement): boolean {
  const { top } = target.getBoundingClientRect();
  const padding = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
  return top >= padding && top + PEEK <= window.innerHeight;
}

/** Brings a card (or a list) out of sight beside the map into view, its top level with the top of the map. */
function bringIntoSight(target: HTMLElement) {
  if (!inSight(target)) target.scrollIntoView({ block: 'start' });
}

/**
 * Brings what a list or a step asked for into view and gives it the focus. Beside the lists the map, which flies to the
 * card, is in view already: the card (or the list) comes into view only when it is out of sight. Above them the map
 * comes into view, and the card takes the focus under it without a second scroll; a short screen (a phone on its side)
 * scrolls on until the top of the card shows too. Without the map the card itself comes into view. Its top shows below
 * the section switch, level with the top of a pinned map (the page keeps a scroll padding for them): a card may be
 * taller than the screen, and focus() alone would centre it.
 */
function reveal(target: HTMLElement, map: HTMLElement | 'beside' | null) {
  if (map === 'beside') {
    bringIntoSight(target);
  } else if (map) {
    map.scrollIntoView({ block: 'start' });
    const hidden = target.getBoundingClientRect().top + PEEK - window.innerHeight;
    if (hidden > 0) window.scrollBy(0, hidden);
  } else {
    target.scrollIntoView({ block: 'start' });
  }
  target.focus({ preventScroll: true });
}

/**
 * A card opened from a list comes into view and takes the focus (so does a place a step asked to show). Closing it
 * gives the focus back to the row that opened it, or, when nothing on this screen did (a step asked for the card, or it
 * came back with the screen), to the row of the card. A card opened on the map leaves the focus on the map. In one
 * column it does not move the page either: the map stays under the finger. Beside the lists it comes into view when it
 * is out of sight (the lists scrolled down), at a new tap on it too, the map pinned beside it. Closing it leaves the
 * page where it is, after a return from a step too.
 */
function useCardFocus(
  selected: MapSelection | null,
  focusFirst: boolean,
  frame: RefObject<HTMLElement | null>,
  drawn: RefObject<boolean>,
  wide: boolean,
) {
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);
  // Who asked for the card, while it is still to come.
  const pending = useRef<Asker | null>(focusFirst ? 'step' : null);
  useEffect(() => {
    const card = ref.current;
    const asker = pending.current;
    if (!asker || !card) return;
    pending.current = null;
    const map = mapFor(asker, frame, drawn, wide);
    if (asker !== 'map') reveal(card, map);
    else if (map === 'beside') bringIntoSight(card);
  }, [selected, frame, drawn, wide]);
  return {
    ref,
    opening: (from: MapOpener) => {
      opener.current = document.activeElement;
      pending.current = from;
    },
    reopened: () => {
      opener.current = document.activeElement;
      const card = ref.current;
      if (!card) return;
      // In list mode, and in one column before the map is drawn, the focus alone brings the card back into view, as it
      // always did.
      const map = mapFor('list', frame, drawn, wide);
      if (map) reveal(card, map);
      else card.focus();
    },
    reshown: () => {
      // A new tap on the open card on the map: only beside the lists does the page move, and the focus stays there.
      const card = ref.current;
      if (card && mapFor('map', frame, drawn, wide) === 'beside') bringIntoSight(card);
    },
    closed: (closing: MapSelection | null, from: MapOpener) => {
      const element = opener.current;
      opener.current = null;
      if (from === 'map') {
        if (focusable(element)) element.focus({ preventScroll: true });
        else if (closing) rowOf(closing)?.focus({ preventScroll: true });
        return;
      }
      if (focusable(element)) return element.focus();
      if (closing) rowOf(closing)?.focus();
    },
  };
}

export function MapScreen({
  route,
  index,
  onRetryIndex,
  focus,
  savedUi,
  onUiChange,
  savedCamera,
  onCameraChange,
  settingsMemory,
  canvasMemory,
  api,
  bridge,
  tabs,
  onBack,
  onOpenTask,
}: MapScreenProps) {
  const [ui, setUi] = useState<MapUi>(() => savedUi ?? initialUi(focus));
  useEffect(() => {
    onUiChange(ui);
  }, [ui, onUiChange]);
  // A card a step asked to show: the map opens on it; «Подобрать район на карте» opens it on the best places. A screen
  // that comes back keeps the map where it was left.
  const [flight, setFlight] = useState<MapFlight | null>(() => {
    if (savedUi !== undefined) return null;
    if (ui.selected) return { to: ui.selected };
    return focus?.kind === 'index' ? { to: 'best' } : null;
  });
  // The frame of the map canvas (none in list mode), and whether the map is drawn in it.
  const mapFrame = useRef<HTMLDivElement>(null);
  const mapDrawn = useRef(false);
  // The lists beside the map rather than under it: the layout rendered, which the scrolling to a card follows too.
  const wide = useWideScreen();
  const card = useCardFocus(ui.selected, savedUi === undefined && focus?.kind === 'place', mapFrame, mapDrawn, wide);
  const ix = index?.status === 'ready' ? index.ix : null;
  const { settings, result, update } = useLocationSettings(ix, settingsMemory);

  // «Подобрать район на карте» wants the best places: the map shows their area, and they take the focus under it (or
  // beside it) as soon as the index is there, with the criteria one tap away above them.
  const topList = useRef<HTMLElement>(null);
  const showTop = useRef(savedUi === undefined && focus?.kind === 'index');
  useEffect(() => {
    if (!showTop.current || !result) return;
    showTop.current = false;
    const list = topList.current;
    if (list) reveal(list, mapFor('step', mapFrame, mapDrawn, wide));
  }, [result, wide]);

  const places = route.places ?? NO_PLACES;
  const tasks = new Map([...route.lanes.critical, ...route.lanes.ops, ...route.lanes.support].map((task) => [task.id, task]));

  const select = (selected: MapSelection, from: MapOpener) => {
    // Every tap in a list shows its card on the map, the card already open included.
    if (from === 'list') setFlight({ to: selected });
    if (sameSelection(ui.selected, selected)) {
      // The card is open already, and it is not a new opening: a list brings it back into view, and so does the map
      // beside the lists when the card is out of sight.
      if (from === 'list') card.reopened();
      else card.reshown();
      return;
    }
    card.opening(from);
    setUi((current) => ({ ...current, selected, openedFrom: from }));
    api.sendEvent(...cardOpenedEvent(selected, ix?.version, from));
  };
  const openCell = (cell: number) => select({ kind: 'cell', cell }, 'list');
  const openPlace = (id: string) => select({ kind: 'place', id }, 'list');
  const closeCard = () => {
    const closing = ui.selected;
    setUi((current) => ({ ...current, selected: null }));
    card.closed(closing, ui.openedFrom);
  };

  if (!index && places.length === 0) {
    return (
      <Screen onBack={onBack}>
        {tabs}
        <MessageState title="Карта пока пуста" text="Для вашего маршрута на карте ещё нет мест." />
      </Screen>
    );
  }

  const { selected } = ui;
  const cell = ix ? selectedCell(ix, selected) : null;
  const place = selected?.kind === 'place' ? places.find((p) => p.id === selected.id) : undefined;
  const linkedStep = ix?.linkedActions.find((id) => tasks.has(id));

  let opened: ReactNode = null;
  if (ix && result && cell !== null) {
    opened = (
      <CellCard
        ref={card.ref}
        explanation={explainCell(ix, result, cell)}
        saturationId={ix.criteria.find((criterion) => criterion.model === 'saturation')?.id}
        onCheckPremises={linkedStep ? () => onOpenTask(linkedStep) : undefined}
        onClose={closeCard}
      />
    );
  } else if (place) {
    opened = (
      <PlaceCard
        ref={card.ref}
        place={place}
        tasks={tasks}
        today={route.today}
        onOpenStep={onOpenTask}
        onOpenLink={(url) => bridge.openLink(url)}
        onClose={closeCard}
      />
    );
  }

  let indexPart: ReactNode = null;
  if (index?.status === 'loading') {
    indexPart = <IndexSkeleton />;
  } else if (ix && result) {
    indexPart = (
      <>
        <CriteriaPanel
          ix={ix}
          result={result}
          open={ui.criteriaOpen}
          onToggle={() => setUi((current) => ({ ...current, criteriaOpen: !current.criteriaOpen }))}
          onChange={(criterion, importance) => update({ ...settings, [criterion]: importance })}
          onReset={() => update({})}
        />
        {result.top.length > 0 && <TopList ref={topList} top={result.top} onOpen={openCell} />}
      </>
    );
  } else if (index?.status === 'failed' || index?.status === 'invalid') {
    indexPart = <IndexProblem load={index} onRetry={onRetryIndex} />;
  }

  // Every part keeps its place whatever the state, so an open card keeps its focus and the map slot stays mounted
  // when the snapshot arrives. The wrappers are there on any screen (in one column they take no box, MapScreen.css):
  // only their class follows the size of the screen, so the map, the open card and the focus live through a change.
  return (
    <Screen onBack={onBack} className="map-page">
      {tabs}
      <div className={wide ? 'map-screen map-screen--wide' : 'map-screen'}>
        <MapHeader ix={ix} index={index} withPlaces={places.length > 0} />
        <MapSlot
          ref={mapFrame}
          onReadyChange={(drawn) => {
            mapDrawn.current = drawn;
          }}
          ix={ix}
          result={result}
          places={places}
          selected={selected}
          flight={flight}
          camera={savedCamera}
          onCameraChange={onCameraChange}
          memory={canvasMemory}
          wide={wide}
          onSelectCell={(cell) => select({ kind: 'cell', cell }, 'map')}
          onSelectPlace={(id) => select({ kind: 'place', id }, 'map')}
          onUnavailable={(kind, details) => api.sendEvent('map_failed', { kind, ...details })}
          onOpenLink={(url) => bridge.openLink(url)}
        />
        <div className="map-screen__info">
          {opened}
          {indexPart}
          {places.length > 0 && <PlaceList places={places} onOpen={openPlace} />}
        </div>
      </div>
    </Screen>
  );
}

/**
 * The heading of the tab: the title of the index, else the places; while the index loads its skeleton holds the
 * heading, and an index that did not come, with no places, titles the tab by the index.
 */
function MapHeader({ ix, index, withPlaces }: { ix: LocationIndex | null; index: IndexState | undefined; withPlaces: boolean }) {
  if (ix) return <IndexHeader ix={ix} />;
  if (index?.status === 'loading') return null;
  if (withPlaces) return <PlacesHeader />;
  return index ? <IndexProblemHeader /> : null;
}

/** The index did not come: a network error can be retried, a missing or invalid snapshot cannot. */
function IndexProblem({ load, onRetry }: { load: Exclude<IndexState, { status: 'loading' | 'ready' }>; onRetry: () => void }) {
  if (load.status === 'failed' && !(load.error instanceof ApiError && load.error.status === 404)) {
    // The messages of the API are written for users; anything else (a chunk that did not load) is not.
    const reason = load.error instanceof ApiError ? load.error.message : 'Проверьте интернет и попробуйте ещё раз.';
    return (
      <div className="notice notice--error map-problem" role="alert">
        <span>{`Не удалось загрузить индекс мест. ${reason}`}</span>
        <Button size="small" variant="secondary" onClick={onRetry}>
          Повторить
        </Button>
      </div>
    );
  }
  return (
    <div className="notice notice--calm" role="status">
      Индекс мест сейчас недоступен — попробуйте позже.
    </div>
  );
}
