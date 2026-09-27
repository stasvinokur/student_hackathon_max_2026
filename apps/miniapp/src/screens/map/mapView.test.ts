import { scoreLocations, type RoutePlace } from '@otkryvay/core';
import { tinyLocationIndex } from '@otkryvay/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cellsBounds, cellsToGeoJson, mapBounds, MAP_THEMES, placesToGeoJson, russianLabels, scoreBin, selectionToGeoJson } from './mapLayers.js';
import { createMapView, LOAD_TIMEOUT_MS, RESTORE_TIMEOUT_MS, type MapViewHandle, type MapViewOptions } from './mapView.js';

// The adapter over a stand-in of MapLibre: jsdom has no WebGL. The stand-in keeps what the adapter asked of it and
// lets a test play the events of a real map (the style fetched and loaded, the first tiles drawn, a click, an error).

const lib = vi.hoisted(() => {
  type Handler = (event: Record<string, unknown>) => void;
  type Style = { sources: Record<string, unknown>; layers: Array<{ id: string; type: string }> };

  class FakeSource {
    constructor(public data: unknown = undefined) {}
    setData = vi.fn((data: unknown) => {
      this.data = data;
    });
  }

  class FakeMap {
    static instances: FakeMap[] = [];
    static failNext = false;
    static controlsFail = false;
    options: Record<string, unknown>;
    handlers = new Map<string, Handler[]>();
    style: Style | null = null;
    sources = new Map<string, FakeSource>();
    featureState = new Map<string, Record<string, unknown>>();
    setFeatureState = vi.fn((target: { source: string; id: number }, state: Record<string, unknown>) => {
      this.featureState.set(`${target.source}:${target.id}`, state);
    });
    setStyle = vi.fn();
    jumpTo = vi.fn((camera: { center: [number, number]; zoom: number }) => this.moveTo(camera));
    flyTo = vi.fn((camera: { center: [number, number]; zoom: number }) => this.moveTo(camera));
    setMaxBounds = vi.fn();
    cameraForBounds = vi.fn((bounds: [[number, number], [number, number]]) => ({
      center: { lng: (bounds[0][0] + bounds[1][0]) / 2, lat: (bounds[0][1] + bounds[1][1]) / 2 },
      zoom: 13.5,
    }));
    addControl = vi.fn(() => {
      if (FakeMap.controlsFail) throw new Error('no controls today');
    });
    remove = vi.fn();
    touchZoomRotate = { disableRotation: vi.fn() };
    keyboard = { disableRotation: vi.fn() };
    cooperativeGestures = { enable: vi.fn(), disable: vi.fn() };
    canvas = document.createElement('canvas');
    center: [number, number];
    zoom: number;
    /** What queryRenderedFeatures finds, by layer. */
    rendered: Record<string, Array<{ properties: Record<string, unknown> }>> = {};
    /** MapLibre drops its style on a lost WebGL context and in remove(): style methods throw until it is restored. */
    styleLost = false;
    /** The style is loaded (style.load fired): only such a style is kept over a lost context. */
    styleLoaded = false;
    keptStyle = false;

    constructor(options: Record<string, unknown>) {
      if (FakeMap.failNext) {
        FakeMap.failNext = false;
        throw new Error('Failed to initialize WebGL');
      }
      this.options = options;
      this.center = options.center as [number, number];
      this.zoom = options.zoom as number;
      FakeMap.instances.push(this);
    }

    on(type: string, layerOrHandler: string | Handler, handler?: Handler) {
      const key = typeof layerOrHandler === 'string' ? `${type}@${layerOrHandler}` : type;
      const listener = typeof layerOrHandler === 'string' ? handler! : layerOrHandler;
      this.handlers.set(key, [...(this.handlers.get(key) ?? []), listener]);
      return this;
    }
    off(type: string, handler: Handler) {
      this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== handler));
      return this;
    }
    once(type: string, handler: Handler) {
      const wrapped: Handler = (event) => {
        this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== wrapped));
        handler(event);
      };
      return this.on(type, wrapped);
    }
    /** Fires an event of the map, or of a layer: fire('mouseenter', {}, 'otk-grid-fill'). */
    fire(type: string, event: Record<string, unknown> = {}, layer?: string) {
      for (const handler of this.handlers.get(layer ? `${type}@${layer}` : type) ?? []) handler(event);
    }
    /** The style JSON arrives: MapLibre applies transformStyle, then validates and loads it. */
    fetchStyle(style: Style) {
      const [, options] = this.setStyle.mock.calls.at(-1) as [string, { transformStyle: (previous: undefined, next: unknown) => Style }];
      this.style = options.transformStyle(undefined, style);
    }
    /** The style arrives and loads: its sources are added and style.load fires. */
    loadStyle(style: Style) {
      this.fetchStyle(style);
      this.addSources();
      this.styleLoaded = true;
      this.fire('style.load');
    }
    addSources() {
      this.sources = new Map(Object.keys(this.style!.sources).map((id) => [id, new FakeSource()]));
    }
    getSource(id: string) {
      if (this.styleLost) throw new TypeError("Cannot read properties of null (reading 'getSource')");
      return this.sources.get(id);
    }
    /** MapLibre keeps a loaded style (style.serialize(), the data of its sources included) and drops the style. */
    loseContext() {
      this.keptStyle = this.styleLoaded;
      this.styleLoaded = false;
      this.styleLost = true;
      this.fire('webglcontextlost');
    }
    /**
     * The browser gives the context back: MapLibre sets the style it kept, with the data of its sources; the
     * feature-state is gone. A style that had not loaded was not kept: there is none to set.
     */
    restoreContext() {
      this.styleLost = false;
      this.featureState.clear();
      this.fire('webglcontextrestored');
      if (!this.keptStyle) return;
      this.sources = new Map([...this.sources].map(([id, source]) => [id, new FakeSource(source.data)]));
      this.styleLoaded = true;
      this.fire('style.load');
    }
    queryRenderedFeatures(_where: unknown, options: { layers: string[] }) {
      if (this.styleLost) throw new TypeError("Cannot read properties of null (reading 'queryRenderedFeatures')");
      return options.layers.flatMap((layer) => this.rendered[layer] ?? []);
    }
    getCenter() {
      return { lng: this.center[0], lat: this.center[1] };
    }
    getZoom() {
      return this.zoom;
    }
    getCanvas() {
      return this.canvas;
    }
    moveTo({ center, zoom }: { center: [number, number]; zoom: number }) {
      this.center = center;
      this.zoom = zoom;
    }
  }

  class NavigationControl {
    constructor(public options: unknown) {}
  }

  return { FakeMap, NavigationControl, prewarm: vi.fn() };
});

vi.mock('maplibre-gl', () => ({ Map: lib.FakeMap, NavigationControl: lib.NavigationControl, prewarm: lib.prewarm }));

const ix = tinyLocationIndex;
const { FakeMap } = lib;
type FakeMap = InstanceType<typeof FakeMap>;

/** A basemap in the shape of the OpenFreeMap styles: ground, buildings, roads, then labels. */
const basemap = () => ({
  version: 8,
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [
    { id: 'background', type: 'background' },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' },
    { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building' },
    { id: 'highway_minor', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' },
    { id: 'highway-name-minor', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', layout: { 'text-field': ['get', 'name:latin'] } },
    { id: 'label_city', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', layout: { 'text-field': ['get', 'name'] } },
  ],
});

function place(id: string, lat: number, lon: number): RoutePlace {
  return {
    id, name: `Место ${id}`, shortName: null, address: 'Казань', lat, lon, note: null, osmUrl: null,
    source: { url: 'https://example.org/', title: 'Источник', checkedAt: '2026-09-23' },
    actions: [{ id: 'register-business', title: 'Зарегистрировать ИП' }],
  };
}
const ifns = place('ifns-18', 55.7925, 49.1025);

function optionsOf(overrides: Partial<MapViewOptions> = {}): MapViewOptions {
  return {
    theme: MAP_THEMES.light,
    camera: { center: [49.12, 55.79], zoom: 11 },
    onCellClick: vi.fn(),
    onPlaceClick: vi.fn(),
    onCameraChange: vi.fn(),
    onReady: vi.fn(),
    onUnavailable: vi.fn(),
    onOpenLink: vi.fn(),
    ...overrides,
  };
}

let container: HTMLElement;

async function create(overrides: Partial<MapViewOptions> = {}) {
  const options = optionsOf(overrides);
  const view = await createMapView(container, options);
  if (typeof view === 'string') throw new Error(`a map was expected, not ${view}`);
  return { view, options, map: FakeMap.instances.at(-1)! };
}

/** The style comes and the first tiles are drawn. */
function load(map: FakeMap) {
  map.loadStyle(basemap());
  map.fire('sourcedata', { sourceId: 'openmaptiles', tile: {} });
  map.fire('load');
}

const grid = (map: FakeMap) => map.getSource('otk-grid')!;
const binOf = (map: FakeMap, cell: number) => map.featureState.get(`otk-grid:${cell}`)?.bin;
const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

beforeEach(() => {
  FakeMap.instances = [];
  lib.prewarm.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  // A context of WebGL: the adapter only asks whether there is one.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ getExtension: () => null } as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createMapView', () => {
  it('reports a browser without a WebGL context, and loads no MapLibre for it', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    expect(await createMapView(container, optionsOf())).toBe('webgl');
    expect(FakeMap.instances).toHaveLength(0);
  });

  it('trusts a WebGL check the slot made before, instead of a probe context of its own', async () => {
    const probe = vi.mocked(HTMLCanvasElement.prototype.getContext);
    probe.mockClear();
    const view = await createMapView(container, optionsOf({ webgl: true }));
    expect(typeof view).toBe('object');
    expect(probe).not.toHaveBeenCalled();
    // A check that found none needs no MapLibre either.
    expect(await createMapView(container, optionsOf({ webgl: false }))).toBe('webgl');
    expect(FakeMap.instances).toHaveLength(1);
  });

  it('reports a MapLibre that cannot start apart from a missing WebGL, and leaves the slot empty', async () => {
    FakeMap.failNext = true;
    expect(await createMapView(container, optionsOf())).toBe('init');
    expect(container.childElementCount).toBe(0);
    expect(console.warn).toHaveBeenCalledWith('[map]', expect.any(Error));
  });

  it('removes a map whose setup fails after it was created, and reports it once', async () => {
    vi.useFakeTimers();
    const options = optionsOf();
    FakeMap.controlsFail = true;
    try {
      expect(await createMapView(container, options)).toBe('init');
    } finally {
      FakeMap.controlsFail = false;
    }
    const map = FakeMap.instances.at(-1)!;
    expect(map.remove).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(0);
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS * 2);
    expect(options.onUnavailable).not.toHaveBeenCalled();
  });

  it('opens a map that the page scrolls past: two fingers or Ctrl move it, no rotation, a compact attribution', async () => {
    const { map } = await create({ camera: { center: [49.1, 55.8], zoom: 13 } });
    expect(map.options).toMatchObject({
      center: [49.1, 55.8],
      zoom: 13,
      cooperativeGestures: true,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      minZoom: 9,
      maxZoom: 17,
    });
    expect(map.touchZoomRotate.disableRotation).toHaveBeenCalled();
    // MapLibre speaks Russian: the hint of the cooperative gestures, the buttons, the attribution.
    const locale = map.options.locale as Record<string, string>;
    expect(locale['CooperativeGesturesHandler.MobileHelpText']).toBe('Двигайте карту двумя пальцами');
    expect(locale['AttributionControl.ToggleAttribution']).toBe('Источники карты');
    expect(map.setStyle).toHaveBeenCalledWith(MAP_THEMES.light.style, expect.anything());
  });

  it('opens with the gestures the screen asks for and switches them while the map lives', async () => {
    // Beside the lists the map is a pane of its own: the wheel and one finger move it, not the page.
    const { view, map } = await create({ cooperativeGestures: false });
    expect(map.options).toMatchObject({ cooperativeGestures: false });
    // The panel of MAX is widened or narrowed under an open map: the same map switches.
    view.setCooperativeGestures(true);
    expect(map.cooperativeGestures.enable).toHaveBeenCalledTimes(1);
    expect(map.cooperativeGestures.disable).not.toHaveBeenCalled();
    view.setCooperativeGestures(false);
    expect(map.cooperativeGestures.disable).toHaveBeenCalledTimes(1);
    expect(map.cooperativeGestures.enable).toHaveBeenCalledTimes(1);

    // A removed map is let be.
    view.destroy();
    view.setCooperativeGestures(true);
    view.setCooperativeGestures(false);
    expect(map.cooperativeGestures.enable).toHaveBeenCalledTimes(1);
    expect(map.cooperativeGestures.disable).toHaveBeenCalledTimes(1);
  });

  it('opens every map in a container of its own inside the slot, and removes it with the map', async () => {
    const first = await create();
    const second = await create();
    const own = (map: FakeMap) => map.options.container as HTMLElement;
    expect(own(first.map)).toBeInstanceOf(HTMLDivElement);
    expect(own(first.map).parentElement).toBe(container);
    expect(own(second.map)).not.toBe(own(first.map));
    // A map removed while the next one opens in the same slot (StrictMode, a change of scheme) leaves that one alone.
    first.view.destroy();
    expect(own(first.map).isConnected).toBe(false);
    expect([...container.children]).toEqual([own(second.map)]);
  });

  it('takes the dark style for the dark scheme', async () => {
    const { map } = await create({ theme: MAP_THEMES.dark });
    expect(map.setStyle).toHaveBeenCalledWith('https://tiles.openfreemap.org/styles/dark', expect.anything());
  });

  it('labels the basemap in Russian and lays the grid over the buildings, under the roads and labels', async () => {
    const { map } = await create();
    map.loadStyle(basemap());
    const style = map.style!;
    const ids = style.layers.map((layer) => layer.id);
    expect(ids.indexOf('otk-grid-fill')).toBe(ids.indexOf('building') + 1);
    expect(ids.indexOf('otk-grid-fill')).toBeLessThan(ids.indexOf('highway_minor'));
    const labels = russianLabels(basemap());
    for (const id of ['highway-name-minor', 'label_city']) {
      expect(style.layers.find((layer) => layer.id === id)).toEqual(labels.layers.find((layer) => layer.id === id));
    }
    expect(style.sources['otk-grid']).toMatchObject({ type: 'geojson', promoteId: 'cell' });
  });

  it('keeps MapLibre warm after the first map is ready: the next opening does not start its workers anew', async () => {
    const { map } = await create();
    expect(lib.prewarm).not.toHaveBeenCalled();
    load(map);
    expect(lib.prewarm).toHaveBeenCalled();
  });
});

describe('the index on the map', () => {
  it('draws the grid once the style is there, and colours every cell by its step', async () => {
    const { view, map } = await create();
    const result = scoreLocations(ix);
    view.setIndex({ ix, scores: result.scores });
    expect(map.setFeatureState).not.toHaveBeenCalled();

    map.loadStyle(basemap());
    expect(grid(map).setData).toHaveBeenCalledExactlyOnceWith(cellsToGeoJson(ix));
    result.scores.forEach((score, cell) => expect(binOf(map, cell), `cell ${cell}`).toBe(scoreBin(score) ?? -1));
    expect(map.setMaxBounds).toHaveBeenCalledWith(mapBounds(ix, []));
  });

  it('recolours only the cells whose step changed, and never draws the grid again for the same snapshot', async () => {
    const { view, map } = await create();
    load(map);
    view.setIndex({ ix, scores: scoreLocations(ix).scores });
    map.setFeatureState.mockClear();

    const required = scoreLocations(ix, { metro: 'required' });
    view.setIndex({ ix, scores: required.scores });
    expect(grid(map).setData).toHaveBeenCalledTimes(1);
    const changed = required.scores.filter((score, cell) => scoreBin(score) !== scoreBin(scoreLocations(ix).scores[cell]!)).length;
    expect(changed).toBeGreaterThan(0);
    expect(map.setFeatureState).toHaveBeenCalledTimes(changed);
    // The cells without metro do not pass: no step.
    required.scores.forEach((score, cell) => expect(binOf(map, cell), `cell ${cell}`).toBe(scoreBin(score) ?? -1));

    // The same scores again: nothing to do.
    map.setFeatureState.mockClear();
    view.setIndex({ ix, scores: required.scores });
    expect(map.setFeatureState).not.toHaveBeenCalled();
  });

  it('draws a new snapshot anew and clears the grid without one', async () => {
    const { view, map } = await create();
    load(map);
    view.setIndex({ ix, scores: scoreLocations(ix).scores });
    const refreshed = structuredClone(ix);
    view.setIndex({ ix: refreshed, scores: scoreLocations(refreshed).scores });
    expect(grid(map).setData).toHaveBeenCalledTimes(2);
    view.setIndex(null);
    expect(grid(map).setData).toHaveBeenLastCalledWith({ type: 'FeatureCollection', features: [] });
  });
});

describe('places and the chosen card', () => {
  it('draws the places of the steps and marks the chosen cell or place', async () => {
    const { view, map } = await create();
    view.setPlaces([ifns]);
    view.select({ kind: 'cell', cell: 6 });
    load(map);
    expect(map.getSource('otk-places')!.setData).toHaveBeenLastCalledWith(placesToGeoJson([ifns]));
    // The index is not there yet: the cell is outlined once it comes.
    expect(map.getSource('otk-selection')!.setData).toHaveBeenLastCalledWith({ type: 'FeatureCollection', features: [] });
    view.setIndex({ ix, scores: scoreLocations(ix).scores });
    expect(map.getSource('otk-selection')!.setData).toHaveBeenLastCalledWith(selectionToGeoJson({ kind: 'cell', cell: 6 }, ix, []));

    view.select({ kind: 'place', id: 'ifns-18' });
    expect(map.getSource('otk-selection')!.setData).toHaveBeenLastCalledWith(selectionToGeoJson({ kind: 'place', id: 'ifns-18' }, ix, [ifns]));
    view.select(null);
    expect(map.getSource('otk-selection')!.setData).toHaveBeenLastCalledWith({ type: 'FeatureCollection', features: [] });
  });

  it('keeps a map of places alone around the places', async () => {
    const { view, map } = await create();
    view.setPlaces([ifns]);
    expect(map.setMaxBounds).toHaveBeenLastCalledWith(mapBounds(null, [ifns]));
  });

  it('shows the area of some cells, the best places: waits for the index, jumps while the map loads, flies after', async () => {
    const { view, map, options } = await create();
    view.showCells([6, 1]);
    expect(map.jumpTo).not.toHaveBeenCalled(); // the index is not there yet
    view.setIndex({ ix, scores: scoreLocations(ix).scores });
    const bounds = cellsBounds(ix, [6, 1])!;
    expect(map.cameraForBounds).toHaveBeenCalledWith(bounds, expect.objectContaining({ padding: expect.any(Number) }));
    const center = [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2];
    expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center, zoom: 13.5 });
    expect(options.onCameraChange).toHaveBeenLastCalledWith({ center, zoom: 13.5 });

    load(map);
    view.showCells([3]);
    expect(map.flyTo).toHaveBeenCalledTimes(1);
  });

  it('jumps to a card while the map loads, flies to it once it is on screen, and remembers where it went', async () => {
    const { view, map, options } = await create();
    view.setPlaces([ifns]);
    view.flyTo({ kind: 'place', id: 'ifns-18' });
    expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [49.1025, 55.7925], zoom: 14 });
    expect(options.onCameraChange).toHaveBeenLastCalledWith({ center: [49.1025, 55.7925], zoom: 14 });

    load(map);
    // A map zoomed in closer keeps its zoom.
    map.zoom = 16;
    view.flyTo({ kind: 'cell', cell: 6 });
    expect(map.flyTo).not.toHaveBeenCalled(); // the index is not there yet
    view.setIndex({ ix, scores: scoreLocations(ix).scores });
    expect(map.flyTo).toHaveBeenCalledExactlyOnceWith({ center: expect.any(Array), zoom: 16 });
    expect(map.jumpTo).toHaveBeenCalledTimes(1);
  });
});

describe('taps on the map', () => {
  it('open a place by its marker only: a long name over a cell does not swallow the tap', async () => {
    const { map, options } = await create();
    load(map);
    map.rendered = { 'otk-grid-fill': [{ properties: { cell: 6 } }], 'otk-place-labels': [{ properties: { id: 'ifns-18', name: 'ИФНС' } }] };
    map.fire('click', { point: { x: 10, y: 10 } });
    expect(options.onPlaceClick).not.toHaveBeenCalled();
    expect(options.onCellClick).toHaveBeenCalledExactlyOnceWith(6);
  });

  it('fold the attribution at the first tap or zoom: MapLibre folds it only at a drag, which needs two fingers here', async () => {
    const touches = [
      ['click', { point: { x: 10, y: 10 } }],
      ['zoomstart', { originalEvent: new WheelEvent('wheel') }], // a gesture, or the zoom buttons
    ] as const;
    for (const [type, event] of touches) {
      const { map } = await create();
      load(map);
      const attribution = document.createElement('details');
      attribution.className = 'maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show';
      (map.options.container as HTMLElement).append(attribution);
      // A flight of the app (a card from a list, the best places) zooms without a touch: the attribution stays.
      map.fire('zoomstart', {});
      expect(attribution.classList.contains('maplibregl-compact-show'), type).toBe(true);
      map.fire(type, event);
      expect(attribution.classList.contains('maplibregl-compact-show'), type).toBe(false);
      expect(attribution.classList.contains('maplibregl-compact'), type).toBe(true);
    }
  });

  it('open a place before the cell under it, a cell otherwise, and nothing on empty ground', async () => {
    const { map, options } = await create();
    load(map);
    map.rendered = { 'otk-grid-fill': [{ properties: { cell: 6 } }], 'otk-places': [{ properties: { id: 'ifns-18', name: 'ИФНС' } }] };
    map.fire('click', { point: { x: 10, y: 10 } });
    expect(options.onPlaceClick).toHaveBeenCalledExactlyOnceWith('ifns-18');
    expect(options.onCellClick).not.toHaveBeenCalled();

    map.rendered = { 'otk-grid-fill': [{ properties: { cell: 6 } }] };
    map.fire('click', { point: { x: 10, y: 10 } });
    expect(options.onCellClick).toHaveBeenCalledExactlyOnceWith(6);

    map.rendered = {};
    map.fire('click', { point: { x: 10, y: 10 } });
    expect(options.onCellClick).toHaveBeenCalledTimes(1);
    expect(options.onPlaceClick).toHaveBeenCalledTimes(1);
  });

  it('point at what can be opened, asking the map once a frame at most, and not at all while the context is lost', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
    const nextFrame = () => frames.splice(0).forEach((callback) => callback(0));
    const { map } = await create();
    load(map);
    const query = vi.spyOn(map, 'queryRenderedFeatures');
    map.rendered = { 'otk-grid-fill': [{ properties: { cell: 6 } }] };
    for (const x of [1, 2, 3]) map.fire('mousemove', { point: { x, y: 1 } });
    nextFrame();
    expect(query).toHaveBeenCalledExactlyOnceWith({ x: 3, y: 1 }, { layers: ['otk-grid-fill', 'otk-places'] });
    expect(map.canvas.style.cursor).toBe('pointer');

    map.rendered = {};
    map.fire('mousemove', { point: { x: 4, y: 1 } });
    nextFrame();
    expect(map.canvas.style.cursor).toBe('');
    map.rendered = { 'otk-places': [{ properties: { id: 'ifns-18' } }] };
    map.fire('mousemove', { point: { x: 5, y: 1 } });
    nextFrame();
    expect(map.canvas.style.cursor).toBe('pointer');
    map.fire('mouseout');
    expect(map.canvas.style.cursor).toBe('');

    // MapLibre has no style to ask while the context is lost: the moves are let be.
    query.mockClear();
    map.loseContext();
    map.fire('mousemove', { point: { x: 6, y: 1 } });
    expect(nextFrame).not.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('open the links of the attribution through the app, not inside it', async () => {
    const { options, map } = await create();
    const link = document.createElement('a');
    link.href = 'https://www.openstreetmap.org/copyright';
    link.target = '_blank';
    (map.options.container as HTMLElement).append(link);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(options.onOpenLink).toHaveBeenCalledExactlyOnceWith('https://www.openstreetmap.org/copyright');
  });
});

describe('when the map does not come', () => {
  it('is ready once the style and the first tiles are drawn, and remembers where it looks', async () => {
    const { map, options } = await create({ camera: { center: [49.1, 55.8], zoom: 12 } });
    map.loadStyle(basemap());
    expect(options.onReady).not.toHaveBeenCalled();
    map.fire('sourcedata', { sourceId: 'openmaptiles', tile: {} });
    map.fire('load');
    expect(options.onReady).toHaveBeenCalledTimes(1);
    expect(options.onCameraChange).toHaveBeenLastCalledWith({ center: [49.1, 55.8], zoom: 12 });
    map.moveTo({ center: [49.2, 55.7], zoom: 14 });
    map.fire('moveend');
    expect(options.onCameraChange).toHaveBeenLastCalledWith({ center: [49.2, 55.7], zoom: 14 });
  });

  it('gives up when no style comes in time, and says how far it got', async () => {
    vi.useFakeTimers();
    const { map, options } = await create();
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS - 1);
    expect(options.onUnavailable).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(options.onUnavailable).toHaveBeenCalledExactlyOnceWith('tiles_timeout', { stage: 'style', basemapTiles: 0 });
    // Whatever MapLibre says next, the failure was reported once.
    map.fire('error', { error: new Error('late') });
    expect(options.onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('gives up when the style came but no tile of the basemap in time', async () => {
    vi.useFakeTimers();
    const { map, options } = await create();
    map.loadStyle(basemap());
    // The tiles of the app's own sources are no basemap.
    map.fire('sourcedata', { sourceId: 'otk-grid', tile: {} });
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS);
    expect(options.onUnavailable).toHaveBeenCalledExactlyOnceWith('tiles_timeout', { stage: 'tiles', basemapTiles: 0 });
  });

  it('is ready with the first tile of the basemap, though the others are still loading', async () => {
    vi.useFakeTimers();
    const { map, options } = await create();
    map.loadStyle(basemap());
    map.fire('sourcedata', { sourceId: 'otk-grid', tile: {} }); // the app's own grid is no basemap
    expect(options.onReady).not.toHaveBeenCalled();
    map.fire('sourcedata', { sourceId: 'openmaptiles', tile: {} });
    expect(options.onReady).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS);
    expect(options.onUnavailable).not.toHaveBeenCalled();
    // The last tiles come later: the map was ready already, and a tile lost now is only a hole.
    map.fire('load');
    map.fire('error', { error: new Error('Failed to fetch') });
    expect(options.onReady).toHaveBeenCalledTimes(1);
    expect(options.onUnavailable).not.toHaveBeenCalled();
  });

  it('does not count the time the app is hidden: a WebView in the background draws nothing', async () => {
    vi.useFakeTimers();
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    try {
      const { map, options } = await create();
      map.loadStyle(basemap());
      vi.advanceTimersByTime(LOAD_TIMEOUT_MS * 3);
      expect(options.onUnavailable).not.toHaveBeenCalled();

      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(LOAD_TIMEOUT_MS - 1);
      expect(options.onUnavailable).not.toHaveBeenCalled();
      // Hidden again for a while, then back: the deadline counts from the return.
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(LOAD_TIMEOUT_MS * 2);
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(LOAD_TIMEOUT_MS - 1);
      expect(options.onUnavailable).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(options.onUnavailable).toHaveBeenCalledExactlyOnceWith('tiles_timeout', { stage: 'tiles', basemapTiles: 0 });
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
  });

  it('tells a style that did not come from a style of the app that is not valid, with the status of the request', async () => {
    let { map, options } = await create();
    map.fire('error', { error: notFound() });
    expect(options.onUnavailable).toHaveBeenCalledExactlyOnceWith('tiles', { stage: 'style', basemapTiles: 0, status: 404 });
    // MapLibre stays silent once there is a listener of its errors: the adapter says them itself.
    expect(console.warn).toHaveBeenCalledWith('[map]', expect.any(Error));

    ({ map, options } = await create());
    map.fetchStyle(basemap()); // the style came, but MapLibre rejects it with the layers of the app
    map.fire('error', { error: new Error('layers[7]: source "otk-grid" not found') });
    expect(options.onUnavailable).toHaveBeenCalledExactlyOnceWith('tiles', { stage: 'overlay', basemapTiles: 0 });

    ({ map, options } = await create());
    map.loadStyle(basemap());
    map.fire('error', { error: notFound(), sourceId: 'openmaptiles' }); // the TileJSON of the basemap
    expect(options.onUnavailable).toHaveBeenCalledExactlyOnceWith('tiles', { stage: 'tiles', basemapTiles: 0, status: 404 });
  });

  it('shows a map with a hole for a tile that failed, but gives up when no tile of the basemap came', async () => {
    let { map, options } = await create();
    map.loadStyle(basemap());
    map.fire('sourcedata', { sourceId: 'openmaptiles', tile: {} });
    map.fire('error', { error: new Error('Failed to fetch'), sourceId: 'openmaptiles', tile: {} });
    map.fire('load');
    expect(options.onUnavailable).not.toHaveBeenCalled();
    expect(options.onReady).toHaveBeenCalledTimes(1);

    ({ map, options } = await create());
    map.loadStyle(basemap());
    // A failed tile of the app's own sources is no basemap tile either.
    map.fire('error', { error: new Error('Failed to fetch'), sourceId: 'otk-grid', tile: {} });
    map.fire('error', { error: new Error('Failed to fetch'), sourceId: 'openmaptiles', tile: {} });
    map.fire('error', { error: new Error('Failed to fetch'), sourceId: 'openmaptiles', tile: {} });
    expect(options.onUnavailable).not.toHaveBeenCalled();
    map.fire('load');
    expect(options.onUnavailable).toHaveBeenCalledExactlyOnceWith('tiles', { stage: 'tiles', basemapTiles: 0 });
    expect(options.onReady).not.toHaveBeenCalled();
  });

  it('ignores errors after the first tiles: a tile lost while panning', async () => {
    vi.useFakeTimers();
    const { map, options } = await create();
    load(map);
    map.fire('error', { error: new Error('Failed to fetch'), sourceId: 'openmaptiles' });
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS * 2);
    expect(options.onUnavailable).not.toHaveBeenCalled();
  });

  it('still says the errors of MapLibre after the first tiles, all but a lost tile', async () => {
    const { map, options } = await create();
    load(map);
    vi.mocked(console.warn).mockClear();
    map.fire('error', { error: new Error('Failed to fetch'), sourceId: 'openmaptiles', tile: {} });
    expect(console.warn).not.toHaveBeenCalled();
    // A worker that could not take the data of the grid, say: nobody else would tell.
    const broken = new Error('could not parse the GeoJSON');
    map.fire('error', { error: broken, sourceId: 'otk-grid' });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('[map]', broken);
    expect(options.onUnavailable).not.toHaveBeenCalled();
  });
});

describe('a lost WebGL context', () => {
  it('is waited for: MapLibre restores the style, and the grid gets its colours back', async () => {
    vi.useFakeTimers();
    const { view, map, options } = await create();
    view.setPlaces([ifns]);
    view.setIndex({ ix, scores: scoreLocations(ix).scores });
    load(map);
    view.select({ kind: 'cell', cell: 6 });

    map.loseContext();
    // The screen may still push data while the context is lost: it waits for the restore, nothing throws.
    const required = scoreLocations(ix, { metro: 'required' });
    expect(() => {
      view.setIndex({ ix, scores: required.scores });
      view.select({ kind: 'place', id: 'ifns-18' });
      view.flyTo({ kind: 'place', id: 'ifns-18' });
      map.fire('click', { point: { x: 1, y: 1 } });
    }).not.toThrow();
    vi.advanceTimersByTime(RESTORE_TIMEOUT_MS - 1);
    map.restoreContext();
    vi.advanceTimersByTime(RESTORE_TIMEOUT_MS * 2);
    expect(options.onUnavailable).not.toHaveBeenCalled();

    // MapLibre set the style it kept, the squares of the grid included: they are not sent to its worker again. Only the
    // colours (feature-state) were lost: every cell is coloured again, with the new scores.
    expect(map.setStyle).toHaveBeenCalledTimes(1);
    expect(grid(map).data).toBe(cellsToGeoJson(ix));
    expect(grid(map).setData).not.toHaveBeenCalled();
    required.scores.forEach((score, cell) => expect(binOf(map, cell), `cell ${cell}`).toBe(scoreBin(score) ?? -1));
    expect(map.getSource('otk-selection')!.setData).toHaveBeenLastCalledWith(selectionToGeoJson({ kind: 'place', id: 'ifns-18' }, ix, [ifns]));
    expect(map.flyTo).toHaveBeenCalledTimes(1); // the flight asked for during the loss
  });

  it('asks for its style again when the context was lost before the style came: MapLibre has none to set', async () => {
    vi.useFakeTimers();
    const { view, map, options } = await create();
    view.setIndex({ ix, scores: scoreLocations(ix).scores });
    map.loseContext();
    map.restoreContext();
    expect(map.setStyle).toHaveBeenCalledTimes(2);
    expect(map.setStyle).toHaveBeenLastCalledWith(MAP_THEMES.light.style, expect.objectContaining({ transformStyle: expect.any(Function) }));
    load(map);
    expect(options.onReady).toHaveBeenCalledTimes(1);
    expect(grid(map).setData).toHaveBeenCalledExactlyOnceWith(cellsToGeoJson(ix));
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS * 2);
    expect(options.onUnavailable).not.toHaveBeenCalled();
  });

  /** A second loss comes before MapLibre loaded the style it kept at the first one: it has no loaded style to keep. */
  function loseTwice(map: FakeMap) {
    map.loseContext();
    // The first restore: MapLibre sets the style it kept, and loads it at the next frame (none in a hidden WebView).
    map.styleLost = false;
    map.featureState.clear();
    map.fire('webglcontextrestored');
    map.loseContext();
    map.restoreContext();
  }

  it('draws the grid anew when the context is lost twice in a row: the style asked for again comes with an empty grid', async () => {
    vi.useFakeTimers();
    const { view, map, options } = await create();
    view.setIndex({ ix, scores: scoreLocations(ix).scores });
    load(map);
    loseTwice(map);
    expect(map.setStyle).toHaveBeenCalledTimes(2);
    map.loadStyle(basemap());
    map.fire('sourcedata', { sourceId: 'openmaptiles', tile: {} });
    expect(grid(map).setData).toHaveBeenCalledExactlyOnceWith(cellsToGeoJson(ix));
    scoreLocations(ix).scores.forEach((score, cell) => expect(binOf(map, cell), `cell ${cell}`).toBe(scoreBin(score) ?? -1));
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS * 2);
    expect(options.onUnavailable).not.toHaveBeenCalled();
  });

  it('gives way to the lists when a map that was on screen loads its style again and the network fails it', async () => {
    vi.useFakeTimers();
    let { map, options } = await create();
    load(map);
    loseTwice(map);
    // Nothing comes: the deadline of the first tiles counts again, as at the start.
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS - 1);
    expect(options.onUnavailable).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(options.onUnavailable).toHaveBeenCalledExactlyOnceWith('tiles_timeout', { stage: 'style', basemapTiles: 0 });

    // The style request fails: at once, as at the start.
    ({ map, options } = await create());
    load(map);
    loseTwice(map);
    map.fire('error', { error: notFound() });
    expect(options.onUnavailable).toHaveBeenCalledExactlyOnceWith('tiles', { stage: 'style', basemapTiles: 0, status: 404 });
  });

  it('gives up when the context does not come back', async () => {
    vi.useFakeTimers();
    const { view, map, options } = await create();
    load(map);
    map.loseContext();
    vi.advanceTimersByTime(RESTORE_TIMEOUT_MS);
    expect(options.onUnavailable).toHaveBeenCalledExactlyOnceWith('context_lost', {});
    expect(() => view.setIndex({ ix, scores: scoreLocations(ix).scores })).not.toThrow();
  });
});

describe('an exception of MapLibre', () => {
  it('ends the map, never the screen: drawing the data or the style fails into the lists', async () => {
    let { view, map, options } = await create();
    load(map);
    grid(map).setData.mockImplementation(() => {
      throw new Error('out of memory');
    });
    expect(() => view.setIndex({ ix, scores: scoreLocations(ix).scores })).not.toThrow();
    expect(options.onUnavailable).toHaveBeenCalledExactlyOnceWith('draw', {});

    ({ view, map, options } = await create());
    view.setIndex({ ix, scores: scoreLocations(ix).scores });
    map.fetchStyle(basemap());
    map.addSources();
    grid(map).setData.mockImplementation(() => {
      throw new Error('out of memory');
    });
    expect(() => map.fire('style.load')).not.toThrow();
    expect(options.onUnavailable).toHaveBeenCalledExactlyOnceWith('draw', {});
  });

  it('removes the map on destroy, once, and says nothing after it', async () => {
    vi.useFakeTimers();
    const { view, map, options } = await create();
    (view as MapViewHandle).destroy();
    view.destroy();
    expect(map.remove).toHaveBeenCalledTimes(1);
    map.styleLost = true; // MapLibre deletes its style in remove()
    expect(() => {
      view.setIndex({ ix, scores: scoreLocations(ix).scores });
      view.setPlaces([ifns]);
      view.select({ kind: 'cell', cell: 6 });
      view.flyTo({ kind: 'cell', cell: 6 });
    }).not.toThrow();
    expect(map.setMaxBounds).not.toHaveBeenCalled();
    expect(map.jumpTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS);
    map.fire('load');
    map.fire('webglcontextlost');
    expect(options.onUnavailable).not.toHaveBeenCalled();
    expect(options.onReady).not.toHaveBeenCalled();
  });
});
