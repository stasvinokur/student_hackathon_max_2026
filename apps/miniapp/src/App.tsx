import { shareText, type LocationSettings, type RouteView } from '@otkryvay/core';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, NO_FEATURES, readFeatures, type ApiClient, type Features } from './api.js';
import type { Bridge } from './bridge.js';
import { LoadingState, MessageState, Screen, SectionNav } from './components/ui.js';
import { cardOpenedEvent, type MapCamera, type MapCanvasMemory, type MapFocus, type MapUi } from './screens/map/model.js';
import { useLocationIndex } from './screens/map/useLocationIndex.js';
import { MapShell } from './screens/MapShell.js';
import { ReadinessScreen } from './screens/ReadinessScreen.js';
import { RouteScreen } from './screens/RouteScreen.js';
import { TaskScreen } from './screens/TaskScreen.js';
import { ThemeToggle } from './theme.js';

type View = { name: 'route' } | { name: 'task'; id: string } | { name: 'readiness' } | { name: 'map'; focus?: MapFocus };
type RouteState = { status: 'loading' } | { status: 'ready'; route: RouteView } | { status: 'empty' } | { status: 'error'; message: string };

type Tab = 'route' | 'map';
const SECTIONS = [
  { id: 'route', label: 'Маршрут' },
  { id: 'map', label: 'Карта' },
] as const;

export interface AppProps {
  /** API client for the verified MAX user; null when the app is opened outside MAX. */
  api: ApiClient | null;
  bridge: Bridge;
  /** Deep link payload (MAX start_param): an action id opens its card directly. */
  startParam?: string | undefined;
  /** Link to the bot included in shared status cards. */
  botLink?: string | undefined;
}

function initialView(startParam: string | undefined): View {
  return startParam && /^[a-z0-9-]{1,64}$/.test(startParam) ? { name: 'task', id: startParam } : { name: 'route' };
}

export function App({ api, bridge, startParam, botLink }: AppProps) {
  const [history, setHistory] = useState<View[]>(() => [initialView(startParam)]);
  const [routeState, setRouteState] = useState<RouteState>({ status: 'loading' });
  const [features, setFeatures] = useState<Features>(NO_FEATURES);
  // A section switch replaces the screen together with its switch: the new one takes the focus back.
  const [focusSections, setFocusSections] = useState(false);
  const view = history.at(-1)!;

  const loadRoute = useCallback(
    (silent = false) => {
      if (!api) return;
      if (!silent) setRouteState({ status: 'loading' });
      api
        .getRoute()
        .then((route) => setRouteState({ status: 'ready', route }))
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 404) setRouteState({ status: 'empty' });
          else if (!silent) setRouteState({ status: 'error', message: error instanceof Error ? error.message : 'Не удалось загрузить маршрут.' });
        });
    },
    [api],
  );

  useEffect(() => {
    bridge.ready();
    if (!api) return;
    api.sendEvent('miniapp_opened', { deepLink: history[0]?.name === 'task' });
    loadRoute();
    // Optional features never block the main scenario: on any error they stay off.
    api
      .getConfig()
      .then((config) => setFeatures(readFeatures(config)))
      .catch(() => setFeatures(NO_FEATURES));
    // Run once on launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // «Карта» shows the location index of the route's pack and the places of its steps (an API older than the map
  // sends no places); without either there is no tab at all.
  const route = routeState.status === 'ready' ? routeState.route : null;
  const indexFeature = route ? features.locationIndex.find((feature) => feature.pack === route.pack.id) : undefined;
  const hasMap = indexFeature !== undefined || (route?.places ?? []).length > 0;

  const locationIndex = useLocationIndex(api, indexFeature?.pack, view.name === 'map');

  // Scroll position of every screen in the history, so «Назад» returns to the same place.
  const scrollPositions = useRef<number[]>([]);
  // The state of every map screen in the history (its card, its open sections), for the same reason. The root map
  // keeps its own: a section switch makes a new root, and the map must come back as it was left.
  const mapUi = useRef(new WeakMap<View, MapUi>());
  const mapRootUi = useRef<MapUi | undefined>(undefined);
  // Where the map canvas of each of them was left, written on every move without a render.
  const mapCamera = useRef(new WeakMap<View, MapCamera>());
  const mapRootCamera = useRef<MapCamera | undefined>(undefined);
  // Criteria settings by snapshot for the session: they survive the map screen even when local storage fails.
  const mapSettings = useRef(new Map<string, LocationSettings>());
  // A map canvas that failed (no WebGL, no tiles) is not tried again in the session: the lists stand in for it.
  const mapCanvas = useRef<MapCanvasMemory>({ webgl: null, failed: null, retryable: false, retried: false });

  const open = (next: View) => {
    bridge.haptic('tap');
    scrollPositions.current[history.length - 1] = window.scrollY;
    setFocusSections(false);
    setHistory((h) => [...h, next]);
  };
  const back = useCallback(() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : [{ name: 'route' }])), []);
  // Sections replace the root: there is no way back from one to the other, and each opens at the top.
  const switchTab = (tab: Tab) => {
    bridge.haptic('tap');
    if (tab === 'map') {
      api?.sendEvent('map_opened', { source: 'tab' });
      locationIndex.retryIfFailed();
    }
    setFocusSections(true);
    setHistory([tab === 'map' ? { name: 'map' } : { name: 'route' }]);
  };
  // The step the map was opened from lies just below it: going back is opening it, and step → map → step loops of
  // the same step do not pile up in the history.
  const openTaskFromMap = (id: string) => {
    const below = history.at(-2);
    if (below?.name === 'task' && below.id === id) back();
    else open({ name: 'task', id });
  };
  const openMap = (focus: MapFocus) => {
    api?.sendEvent('map_opened', { source: 'task' });
    // A card counts as opened when the map can show it: a place the route does not have is not.
    const shown = focus.kind === 'place' ? (route?.places ?? []).some((place) => place.id === focus.id) : focus.kind === 'cell';
    const index = locationIndex.index;
    if (focus.kind !== 'index' && shown) api?.sendEvent(...cardOpenedEvent(focus, index?.status === 'ready' ? index.ix.version : undefined, 'list'));
    locationIndex.retryIfFailed();
    open({ name: 'map', focus });
  };

  const isRoot = history.length === 1 && (view.name === 'route' || view.name === 'map');
  const canGoBack = !isRoot;

  // The page scrolls as a whole: a new screen starts at the top, a returning one where it was left.
  // Only a shorter history is a return: «Назад» from a deep-linked card and a tab switch swap in a new root.
  const shownLength = useRef(history.length);
  useLayoutEffect(() => {
    const returned = history.length < shownLength.current;
    window.scrollTo(0, returned ? (scrollPositions.current[history.length - 1] ?? 0) : 0);
    scrollPositions.current.length = history.length;
    shownLength.current = history.length;
  }, [history]);

  // The platform back button is shown on inner screens only.
  useEffect(() => {
    bridge.setBackHandler(canGoBack ? back : null);
  }, [bridge, canGoBack, back]);

  if (!api) {
    return (
      <Screen>
        <MessageState title="Откройте в MAX" text="Маршрут открывается из чата с ботом «Открывай» в MAX — вне мессенджера мы не можем узнать, чей он." />
      </Screen>
    );
  }

  if (view.name === 'task') {
    return (
      <TaskScreen
        key={view.id}
        taskId={view.id}
        api={api}
        bridge={bridge}
        route={route}
        onBack={back}
        onToRoute={() => switchTab('route')}
        onOpenTask={(id) => open({ name: 'task', id })}
        onChanged={() => loadRoute(true)}
        explainEnabled={features.explain}
        // The map is drawn from the route: until it loads there is nothing to show the place on.
        onShowPlace={route ? (id) => openMap({ kind: 'place', id }) : undefined}
        onPickArea={indexFeature?.actions.includes(view.id) ? () => openMap({ kind: 'index' }) : undefined}
      />
    );
  }

  const tabs =
    isRoot && (hasMap || view.name === 'map') ? (
      <SectionNav
        label="Разделы"
        items={SECTIONS}
        current={view.name === 'map' ? 'map' : 'route'}
        onSelect={switchTab}
        focusCurrent={focusSections}
        end={<ThemeToggle onToggle={() => bridge.haptic('tap')} />}
      />
    ) : undefined;

  switch (routeState.status) {
    case 'loading':
      return (
        <Screen onBack={canGoBack ? back : undefined}>
          <LoadingState text="Строим ваш маршрут…" />
        </Screen>
      );
    case 'empty':
      return (
        <Screen>
          <MessageState title="Маршрута пока нет" text="Ответьте на 7 вопросов в чате с ботом «Открывай» — маршрут появится здесь автоматически." action={{ label: 'Проверить снова', onClick: () => loadRoute() }} />
        </Screen>
      );
    case 'error':
      return (
        <Screen>
          <MessageState title="Не удалось загрузить" text={routeState.message} action={{ label: 'Повторить', onClick: () => loadRoute() }} />
        </Screen>
      );
    case 'ready':
      if (view.name === 'readiness') {
        // One text for the card the screen shows and for the chat.
        const statusCard = shareText(routeState.route, botLink);
        return (
          <ReadinessScreen
            route={routeState.route}
            statusCard={statusCard}
            onBack={back}
            onOpenTask={(id) => open({ name: 'task', id })}
            onShare={async () => {
              const { result, error } = await bridge.share(statusCard);
              api.sendEvent('share_clicked', { shared: result === 'shared', result, ...(error ? { error } : {}) });
              return result;
            }}
          />
        );
      }
      if (view.name === 'map') {
        const isMapRoot = history.length === 1;
        return (
          <MapShell
            route={routeState.route}
            index={locationIndex.index}
            onRetryIndex={locationIndex.retry}
            focus={view.focus}
            savedUi={isMapRoot ? mapRootUi.current : mapUi.current.get(view)}
            onUiChange={(ui) => {
              if (isMapRoot) mapRootUi.current = ui;
              else mapUi.current.set(view, ui);
            }}
            savedCamera={isMapRoot ? mapRootCamera.current : mapCamera.current.get(view)}
            onCameraChange={(camera) => {
              if (isMapRoot) mapRootCamera.current = camera;
              else mapCamera.current.set(view, camera);
            }}
            settingsMemory={mapSettings.current}
            canvasMemory={mapCanvas.current}
            api={api}
            bridge={bridge}
            tabs={tabs}
            onBack={canGoBack ? back : undefined}
            onOpenTask={openTaskFromMap}
            onToRoute={() => switchTab('route')}
            onGiveUp={() => {
              if (isMapRoot) {
                mapRootUi.current = undefined;
                mapRootCamera.current = undefined;
              } else {
                mapUi.current.delete(view);
                mapCamera.current.delete(view);
              }
            }}
          />
        );
      }
      return <RouteScreen route={routeState.route} tabs={tabs} onOpenTask={(id) => open({ name: 'task', id })} onOpenReadiness={() => open({ name: 'readiness' })} />;
  }
}
