import { lazy, Suspense, useRef, useState, type ReactNode } from 'react';
import type { Bridge } from '../bridge.js';
import { FeatureBoundary, LoadingState, MessageState, Screen } from '../components/ui.js';
import { ChunkLoadError } from './map/failures.js';
import type { MapScreenProps } from './MapScreen.js';

// The part of the «Карта» tab that stays in the main chunk: it loads the map screen as a chunk of its own and keeps
// the rest of the app working when the map cannot be shown.

// The route must not wait for the map, and most visits never open it. A failed import stays failed (Chromium does not
// even request the same address again), so the way back to the map is a reload, never another import().
const LazyMapScreen = lazy(() =>
  import('./MapScreen.js').then(
    (module) => ({ default: module.MapScreen }),
    (error: unknown) => {
      throw new ChunkLoadError(error);
    },
  ),
);

export interface MapShellProps extends MapScreenProps {
  /** Leaves a map that cannot be shown for the route. */
  onToRoute: () => void;
  /** The map failed again after its remount: its saved state may be what breaks it, so it must not come back. */
  onGiveUp: () => void;
}

/**
 * The map screen behind an error boundary. A chunk that did not load offers a reload once the server answers. A map
 * that throws while rendering gets one remount (a passing glitch); failing again, it gives way to the route.
 */
export function MapShell({ onToRoute, onGiveUp, ...props }: MapShellProps) {
  const { bridge, tabs, onBack } = props;
  const [attempt, setAttempt] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  // One event per failed opening of the map: a remount that fails too is the same failure.
  const reported = useRef(false);
  const screen = (content: ReactNode) => (
    <Screen onBack={onBack}>
      {tabs}
      {content}
    </Screen>
  );

  return (
    <FeatureBoundary
      key={attempt}
      onError={(error) => {
        const chunk = error instanceof ChunkLoadError;
        if (!reported.current) {
          reported.current = true;
          props.api.sendEvent('map_failed', { kind: chunk ? 'chunk' : 'render' });
        }
        if (chunk) return;
        if (attempt === 0) return setAttempt(1);
        setGaveUp(true);
        onGiveUp();
      }}
      fallback={(error) => {
        if (error instanceof ChunkLoadError) return screen(<ChunkFailure bridge={bridge} />);
        if (!gaveUp) return null; // the remount follows at once
        return screen(
          <MessageState
            title="Карта не открылась"
            text="Маршрут работает как обычно — карту можно открыть позже."
            action={{ label: 'К маршруту', onClick: onToRoute }}
          />,
        );
      }}
    >
      <Suspense fallback={screen(<LoadingState text="Загружаем карту мест…" />)}>
        <LazyMapScreen {...props} />
      </Suspense>
    </FeatureBoundary>
  );
}

/** «Повторить» reloads the app for a fresh chunk, but only when the server answers: offline the route stays. */
function ChunkFailure({ bridge }: { bridge: Bridge }) {
  const [checking, setChecking] = useState(false);
  const [offline, setOffline] = useState(false);
  const retry = () => {
    setChecking(true);
    void bridge.serverReachable().then((reachable) => {
      if (reachable) return bridge.reload();
      setOffline(true);
      setChecking(false);
    });
  };
  return (
    <MessageState
      title="Карта не загрузилась"
      text={
        offline
          ? 'Нет связи с сервером. Маршрут работает — откройте карту, когда связь появится.'
          : 'Маршрут работает как обычно. «Повторить» перезапустит приложение — затем снова откройте «Карту».'
      }
      action={{ label: 'Повторить', onClick: retry, loading: checking }}
    />
  );
}
