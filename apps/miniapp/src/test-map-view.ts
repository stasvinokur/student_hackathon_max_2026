import { vi, type Mock } from 'vitest';
import type { MapStartFailure, MapViewHandle, MapViewOptions } from './screens/map/mapView.js';

// A stand-in for the map canvas (screens/map/mapView.ts) in tests of the screens: jsdom has no WebGL. Every map the
// screen opens is kept with the options it was given, so a test can play a tap on it, a move or a failure, and see
// what the screen asked of it.
//   vi.mock('./screens/map/mapView.js', () => import('./test-map-view.js'));

export interface FakeMapView {
  container: HTMLElement;
  options: MapViewOptions;
  handle: { [K in keyof MapViewHandle]: Mock<MapViewHandle[K]> };
}

export const mapViews: FakeMapView[] = [];

export const createMapView = vi.fn(async (container: HTMLElement, options: MapViewOptions): Promise<MapViewHandle | MapStartFailure> => {
  const handle = {
    setIndex: vi.fn(),
    setPlaces: vi.fn(),
    select: vi.fn(),
    flyTo: vi.fn(),
    showCells: vi.fn(),
    setCooperativeGestures: vi.fn(),
    destroy: vi.fn(),
  };
  mapViews.push({ container, options, handle });
  return handle;
});

/** Whether the browser gives WebGL: yes, unless a test says otherwise. */
export const hasWebGL = vi.fn(() => true);

/** Forgets the maps of the previous test and what it asked of the stand-in: it opens working maps again. */
export function resetMapViews() {
  mapViews.length = 0;
  createMapView.mockReset();
  hasWebGL.mockReset();
}
