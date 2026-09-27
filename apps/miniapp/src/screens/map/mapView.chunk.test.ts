import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MAP_THEMES } from './mapLayers.js';
import type { MapViewOptions } from './mapView.js';

// The MapLibre chunk that does not come: a network that never answers, or an import that fails (a deploy replaced
// the chunk, the network is down). Each case needs its own stand-in of the module, so the adapter is imported anew.

const options = (): MapViewOptions => ({
  theme: MAP_THEMES.light,
  camera: { center: [49.12, 55.79], zoom: 10 },
  onCellClick: vi.fn(),
  onPlaceClick: vi.fn(),
  onCameraChange: vi.fn(),
  onReady: vi.fn(),
  onUnavailable: vi.fn(),
  onOpenLink: vi.fn(),
});

let slot: HTMLElement;

beforeEach(() => {
  vi.resetModules();
  slot = document.createElement('div');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ getExtension: () => null } as never);
});

afterEach(() => {
  vi.doUnmock('maplibre-gl');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('gives up on a MapLibre chunk that does not come in time, counting only the time the app is shown', async () => {
  vi.doMock('maplibre-gl', () => new Promise(() => {}));
  const { createMapView, CHUNK_TIMEOUT_MS } = await import('./mapView.js');
  vi.useFakeTimers();
  let hidden = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  try {
    let result: string | undefined;
    void createMapView(slot, options()).then((made) => (result = typeof made === 'string' ? made : 'map'));
    await vi.advanceTimersByTimeAsync(CHUNK_TIMEOUT_MS * 2);
    expect(result).toBeUndefined();
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(CHUNK_TIMEOUT_MS);
    expect(result).toBe('map_chunk_timeout');
    expect(slot.childElementCount).toBe(0);
  } finally {
    delete (document as { hidden?: boolean }).hidden;
  }
});

it('reports a MapLibre chunk that did not load', async () => {
  vi.doMock('maplibre-gl', () => {
    throw new TypeError('Failed to fetch dynamically imported module');
  });
  const { createMapView } = await import('./mapView.js');
  expect(await createMapView(slot, options())).toBe('map_chunk');
});
