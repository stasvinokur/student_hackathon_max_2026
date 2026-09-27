import type { ExpressionSpecification, FilterSpecification, LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { cellCenter, cellRing, type LocationIndex, type RoutePlace } from '@otkryvay/core';
import type { MapCamera, MapSelection } from './model.js';

// What the map canvas draws, as plain data: its colours, its layers over the basemap, the grid of the index and the
// places as GeoJSON, the Russian labels of the basemap, cameras and bounds. Pure, so it is tested without WebGL (the
// style is checked with the MapLibre style specification); only mapView.ts talks to MapLibre.

export type MapScheme = 'light' | 'dark';

/** The colours of one basemap. The legend lays them over `basemap` exactly as the map does. */
export interface MapTheme {
  /** OpenFreeMap style: every resource of it (tiles, fonts, sprites) comes from tiles.openfreemap.org. */
  style: string;
  /** The ground under most cells: the residential land of the basemap. */
  basemap: string;
  /** The five steps of the index, lowest first. A cell that does not pass is not coloured at all. */
  bins: readonly [string, string, string, string, string];
  /**
   * The opacity of the steps over the whole city (zoom 10) and, per step, at street level (zoom 15), where the grid fades
   * so the buildings under it show.
   */
  binOpacity: { city: number; street: readonly [number, number, number, number, number] };
  /** The thin borders of the coloured cells from zoom 13. */
  cellBorder: string;
  /** Places of the route steps: a colour of their own, never one of the index. */
  place: string;
  placeStroke: string;
  label: string;
  labelHalo: string;
  /** The outline of the chosen cell and the ring of the chosen place, over a halo that keeps it off any fill. */
  selection: string;
  selectionHalo: string;
}

/**
 * The index is a percentile, so the colour is a magnitude: one hue, the sage of Organic (its accent-2 ramp, organic.css),
 * light to deep on the light map and deep to light on the dark one, so the best places stand out on either. The steps
 * are finer at the top (BIN_FLOORS): the lower half of the places that pass is one step, the few best per cent the
 * strongest. The ramp is skipped along where the steps would fall too close: on the light map 300, 500, 600, 700 and 800
 * (200 would vanish into the grey ground of Positron), on the dark one 400 to 800 of the dark ramp. Laid over the
 * basemap, neighbouring steps differ in lightness (OKLab L) by at least 0.079 on the light map and 0.089 on the dark one
 * over the whole city (zoom 10). Towards street level the grid fades and the gaps shrink, to at least 0.054 and 0.048 at
 * zoom 15: the light map keeps its strong steps more opaque there, and the thin borders of the cells from zoom 13 tell
 * neighbours apart. One hue, which colour-blind readers see as well; the lowest step may fade towards the ground, as the
 * low end of a sequential scale does. A cell that does not pass is left uncoloured, like the ground without enough
 * buildings for the index: grey would look like the grey ground of the light basemap. The terracotta of Organic marks
 * the places of steps, in a ring of cream; the labels and the chosen card take the text and the ground of Organic. The
 * colours are those of the tokens of organic.css, written out: MapLibre reads no CSS.
 */
export const MAP_THEMES: Readonly<Record<MapScheme, MapTheme>> = {
  light: {
    style: 'https://tiles.openfreemap.org/styles/positron',
    basemap: '#eaeae6',
    bins: ['#ccdbb2', '#8fa073', '#728157', '#56633f', '#3d472b'],
    // At street level the strong steps stay more opaque: over the light ground a uniform fade leaves them too close.
    binOpacity: { city: 0.85, street: [0.36, 0.4, 0.45, 0.5, 0.55] },
    cellBorder: '#f5ead8',
    place: '#c67139',
    placeStroke: '#f5ead8',
    label: '#201e1d',
    labelHalo: '#f5ead8',
    selection: '#201e1d',
    selectionHalo: '#f5ead8',
  },
  dark: {
    style: 'https://tiles.openfreemap.org/styles/dark',
    basemap: '#0c0c0c',
    // The top stops short of the palest sage: a whole city centre in near-white would glare on the dark map.
    bins: ['#4a5536', '#64724b', '#809065', '#a5b589', '#c7d6ae'],
    binOpacity: { city: 0.9, street: [0.45, 0.45, 0.45, 0.45, 0.45] },
    cellBorder: '#1d1a17',
    place: '#ec9661',
    placeStroke: '#f5ead8',
    label: '#f5ead8',
    labelHalo: '#1d1a17',
    selection: '#f5ead8',
    selectionHalo: '#1d1a17',
  },
};

/**
 * Where each step of the map starts on the index. The index is a percentile among the places that pass, so equal
 * fifths would paint the whole centre of a city in one colour: the steps are finer at the top, and the last one holds
 * the few best per cent of the places. Not exactly 3: the percentile is rounded, so 97 and above is about 3.5 % of the
 * places in Kazan, and ties at the top make it more.
 */
export const BIN_FLOORS = [0, 50, 75, 90, 97] as const;

/** The step of a score on the map; none for a place that does not pass. */
export function scoreBin(score: number | null): number | null {
  if (score === null || !Number.isFinite(score)) return null;
  let bin = 0;
  while (bin + 1 < BIN_FLOORS.length && score >= BIN_FLOORS[bin + 1]!) bin++;
  return bin;
}

/** A colour laid over another with an opacity, as a translucent fill looks on the map. */
export function mix(color: string, under: string, opacity: number): string {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const top = channels(color);
  const bottom = channels(under);
  return `#${top.map((c, i) => Math.round(opacity * c + (1 - opacity) * bottom[i]!).toString(16).padStart(2, '0')).join('')}`;
}

// ---------- GeoJSON ----------

type Position = [number, number];

export interface FeatureCollection<G, P> {
  type: 'FeatureCollection';
  features: Array<{ type: 'Feature'; properties: P; geometry: G }>;
}

type Polygon = { type: 'Polygon'; coordinates: Position[][] };
type Point = { type: 'Point'; coordinates: Position };

export type CellCollection = FeatureCollection<Polygon, { cell: number }>;
export type PlaceCollection = FeatureCollection<Point, { id: string; name: string }>;
export type SelectionCollection = FeatureCollection<Polygon | Point, Record<string, never>>;

/** The squares of every snapshot: a map opened anew (another scheme, another visit) does not build 5 000 of them again. */
const gridCache = new WeakMap<LocationIndex, CellCollection>();

/** Every cell of the snapshot as its square; `cell` is its number in the snapshot, the id of its feature on the map. */
export function cellsToGeoJson(ix: LocationIndex): CellCollection {
  const cached = gridCache.get(ix);
  if (cached) return cached;
  const { row, col } = ix.cells;
  const collection: CellCollection = {
    type: 'FeatureCollection',
    features: row.map((r, cell) => ({
      type: 'Feature',
      properties: { cell },
      geometry: { type: 'Polygon', coordinates: [cellRing(ix.grid, r, col[cell]!)] },
    })),
  };
  gridCache.set(ix, collection);
  return collection;
}

/**
 * The places of the route steps as points, labelled by their short names: a full official name would take three or four
 * lines on the map (an API older than short names sends none, and the name stands in). The places of the index facts
 * are not drawn: they only anchor the facts.
 */
export function placesToGeoJson(places: readonly RoutePlace[]): PlaceCollection {
  return {
    type: 'FeatureCollection',
    features: places.map((place) => ({
      type: 'Feature',
      properties: { id: place.id, name: place.shortName ?? place.name },
      geometry: { type: 'Point', coordinates: [place.lon, place.lat] },
    })),
  };
}

// ---------- labels ----------

interface StyleLike {
  layers: ReadonlyArray<{ id: string; type: string; layout?: object }>;
}

/** Russian names where the tiles have them (name:ru), else the name in the local language, which in Kazan is Russian. */
const RUSSIAN_NAME = ['coalesce', ['get', 'name:ru'], ['get', 'name']];

/** A text field that prints a name: `{name…}` tokens or an expression that gets name, name:xx or name_xx. */
function printsName(field: unknown): boolean {
  if (typeof field === 'string') return /\{name(?:[:_][^}]*)?\}/.test(field);
  const getsName = (value: unknown): boolean =>
    Array.isArray(value) &&
    ((value[0] === 'get' && typeof value[1] === 'string' && /^name(?:$|[:_])/.test(value[1])) || value.some(getsName));
  return getsName(field);
}

/**
 * The OpenFreeMap styles label places with a Latin name over the local one («Sheinkman street / проезд Шейнкмана»):
 * every label of a name gets the Russian one instead. Road numbers (ref) and layers without text stay as they are.
 */
export function russianLabels<S extends StyleLike>(style: S): S {
  const layers = style.layers.map((layer) => {
    const layout = layer.layout as Record<string, unknown> | undefined;
    if (layer.type !== 'symbol' || !layout || !printsName(layout['text-field'])) return layer;
    return { ...layer, layout: { ...layout, 'text-field': RUSSIAN_NAME } };
  });
  return { ...style, layers };
}

// ---------- cameras and bounds ----------

// MapLibre counts zoom in tiles of 512 px: on a phone's map (≈ 350 px) zoom 10 holds about 15 km, 14 about 1 km.
/** The zoom a card opened from a list shows: its cell of 300 m and the neighbours to compare it with. */
export const FLY_ZOOM = 14;
/** A city on a phone's map. */
const CITY_ZOOM = 10;
/** Kazan, the city of the only pack with places today; a map is only shown with an index or places to centre on. */
const FALLBACK_CENTER: Position = [49.12, 55.79];
/** How far past the index (or the places) the map may be moved: some context around, not the rest of the world. */
const MARGIN_METRES = 5000;

export type Bounds = [[number, number], [number, number]];

/** The index grid: [[west, south], [east, north]]. */
function gridBounds(ix: LocationIndex): Bounds {
  const { origin, rows, cols, cellMeters, mPerDegLat, mPerDegLon } = ix.grid;
  return [
    [origin.lon, origin.lat],
    [origin.lon + (cols * cellMeters) / mPerDegLon, origin.lat + (rows * cellMeters) / mPerDegLat],
  ];
}

function placeBounds(places: readonly RoutePlace[]): Bounds | null {
  if (places.length === 0) return null;
  const lons = places.map((place) => place.lon);
  const lats = places.map((place) => place.lat);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

/** The squares of some cells: [[west, south], [east, north]]; null without cells the snapshot has. */
export function cellsBounds(ix: LocationIndex, cells: readonly number[]): Bounds | null {
  const known = cells.filter((cell) => Number.isInteger(cell) && cell >= 0 && cell < ix.cells.row.length);
  if (known.length === 0) return null;
  const corners = known.flatMap((cell) => cellRing(ix.grid, ix.cells.row[cell]!, ix.cells.col[cell]!));
  const lons = corners.map(([lon]) => lon);
  const lats = corners.map(([, lat]) => lat);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

/** Where a card is on the map: the centre of a cell or the point of a place; null when the map has no such card. */
export function selectionCenter(selection: MapSelection, ix: LocationIndex | null, places: readonly RoutePlace[]): Position | null {
  if (selection.kind === 'place') {
    const place = places.find((p) => p.id === selection.id);
    return place ? [place.lon, place.lat] : null;
  }
  const { cell } = selection;
  if (!ix || !Number.isInteger(cell) || cell < 0 || cell >= ix.cells.row.length) return null;
  const { lat, lon } = cellCenter(ix.grid, ix.cells.row[cell]!, ix.cells.col[cell]!);
  return [lon, lat];
}

/** The open card on the map: the outline of its cell or the point of its place; nothing when the map has no such card. */
export function selectionToGeoJson(selection: MapSelection | null, ix: LocationIndex | null, places: readonly RoutePlace[]): SelectionCollection {
  const center = selection ? selectionCenter(selection, ix, places) : null;
  if (!selection || !center) return { type: 'FeatureCollection', features: [] };
  const geometry: Polygon | Point =
    selection.kind === 'cell' && ix
      ? { type: 'Polygon', coordinates: [cellRing(ix.grid, ix.cells.row[selection.cell]!, ix.cells.col[selection.cell]!)] }
      : { type: 'Point', coordinates: center };
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry }] };
}

/** A new map: the whole city, around the middle of the index, or of the places when there is no index. */
export function startCamera(ix: LocationIndex | null, places: readonly RoutePlace[]): MapCamera {
  const bounds = ix ? gridBounds(ix) : placeBounds(places);
  if (!bounds) return { center: FALLBACK_CENTER, zoom: CITY_ZOOM };
  const [[west, south], [east, north]] = bounds;
  return { center: [(west + east) / 2, (south + north) / 2], zoom: CITY_ZOOM };
}

/** How far the map may be moved: the index grid, or the places without it, with a margin; null with neither. */
export function mapBounds(ix: LocationIndex | null, places: readonly RoutePlace[]): Bounds | null {
  const bounds = ix ? gridBounds(ix) : placeBounds(places);
  if (!bounds) return null;
  const [[west, south], [east, north]] = bounds;
  const lat = (south + north) / 2;
  const dLat = MARGIN_METRES / 111_320;
  const dLon = MARGIN_METRES / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [
    [west - dLon, south - dLat],
    [east + dLon, north + dLat],
  ];
}

// ---------- the layers of the app ----------

/** The sources and layers the app adds to the basemap. */
export const OVERLAY = {
  sources: { grid: 'otk-grid', places: 'otk-places', selection: 'otk-selection' },
  layers: {
    grid: 'otk-grid-fill',
    cellBorders: 'otk-grid-borders',
    cellHalo: 'otk-selected-cell-halo',
    cell: 'otk-selected-cell',
    places: 'otk-places',
    place: 'otk-selected-place',
    placeLabels: 'otk-place-labels',
  },
} as const;

/** The step of a cell that does not pass the criteria (feature-state `bin`); a cell not coloured yet has none. */
export const EXCLUDED_BIN = -1;
const BIN: ExpressionSpecification = ['coalesce', ['feature-state', 'bin'], EXCLUDED_BIN];
const TRANSPARENT = 'rgba(0,0,0,0)';
const EMPTY = { type: 'FeatureCollection', features: [] } as const;
/** From this zoom the names of the places show, and the borders of the cells. */
const DETAIL_ZOOM = 13;

/**
 * The basemap with the layers of the app, from the bottom up:
 * - the ground, the water and the buildings of the basemap;
 * - the grid (it fades towards street level) and, from zoom 13, the thin borders of its coloured cells;
 * - the roads and lines of the basemap, so the streets stay readable over the colours;
 * - the names of the places of steps, then every label of the basemap: in a collision the city wins, a place name
 *   gives way (Dark puts the names of the water under its buildings; they go up with the other labels);
 * - the chosen cell, the markers of the places and the ring of the chosen one, over everything.
 * A cell that does not pass, or that has no step yet, is fully transparent: the default of the colour is no colour.
 * A zoom in an expression may only be the input of its top-level interpolate: MapLibre rejects anything else, and a
 * rejected layer rejects the whole style.
 */
export function withOverlay(style: StyleSpecification, theme: MapTheme): StyleSpecification {
  const [b0, b1, b2, b3, b4] = theme.bins;
  const { sources, layers: id } = OVERLAY;
  const opacity = (value: number): ExpressionSpecification => ['match', BIN, EXCLUDED_BIN, 0, value];
  const [s0, s1, s2, s3, s4] = theme.binOpacity.street;
  const streetOpacity: ExpressionSpecification = ['match', BIN, 0, s0, 1, s1, 2, s2, 3, s3, 4, s4, 0];
  const grid: LayerSpecification[] = [
    {
      id: id.grid,
      type: 'fill',
      source: sources.grid,
      paint: {
        'fill-color': ['match', BIN, 0, b0, 1, b1, 2, b2, 3, b3, 4, b4, TRANSPARENT],
        // A cell that does not pass stays on the map uncoloured: a tap on it still tells why it does not pass.
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, opacity(theme.binOpacity.city), 15, streetOpacity],
        // Antialiased edges of translucent neighbours overlap into a dark mesh: flat cells read as areas.
        'fill-antialias': false,
      },
    },
    {
      id: id.cellBorders,
      type: 'line',
      source: sources.grid,
      minzoom: DETAIL_ZOOM,
      paint: {
        'line-color': theme.cellBorder,
        'line-width': 1,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], DETAIL_ZOOM, 0, DETAIL_ZOOM + 1, opacity(0.5)],
      },
    },
  ];
  const isPolygon: FilterSpecification = ['==', ['geometry-type'], 'Polygon'];
  const isPoint: FilterSpecification = ['==', ['geometry-type'], 'Point'];
  const placeLabels: LayerSpecification = {
    id: id.placeLabels,
    type: 'symbol',
    source: sources.places,
    minzoom: DETAIL_ZOOM,
    // Under the labels of the basemap: a place name gives way where they collide, the marker always stays. It tries
    // below its marker first, then the other sides: a street name often lies right under it.
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
      'text-radial-offset': 0.9,
      'text-justify': 'auto',
      'text-max-width': 9,
    },
    paint: { 'text-color': theme.label, 'text-halo-color': theme.labelHalo, 'text-halo-width': 1.5 },
  };
  const top: LayerSpecification[] = [
    { id: id.cellHalo, type: 'line', source: sources.selection, filter: isPolygon, paint: { 'line-color': theme.selectionHalo, 'line-width': 5 } },
    { id: id.cell, type: 'line', source: sources.selection, filter: isPolygon, paint: { 'line-color': theme.selection, 'line-width': 2.5 } },
    {
      id: id.places,
      type: 'circle',
      source: sources.places,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 15, 8],
        'circle-color': theme.place,
        'circle-stroke-color': theme.placeStroke,
        'circle-stroke-width': 2,
      },
    },
    {
      id: id.place,
      type: 'circle',
      source: sources.selection,
      filter: isPoint,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 9, 15, 13],
        'circle-opacity': 0,
        'circle-stroke-color': theme.selection,
        'circle-stroke-width': 3,
      },
    },
  ];

  const ground: LayerSpecification[] = style.layers.filter((layer) => layer.type !== 'symbol');
  const labels = style.layers.filter((layer) => layer.type === 'symbol');
  const roads = ground.findIndex((layer) => 'source-layer' in layer && layer['source-layer'] === 'transportation');
  ground.splice(roads >= 0 ? roads : ground.length, 0, ...grid);
  return {
    ...style,
    sources: {
      ...style.sources,
      [sources.grid]: { type: 'geojson', data: EMPTY, promoteId: 'cell' },
      [sources.places]: { type: 'geojson', data: EMPTY },
      [sources.selection]: { type: 'geojson', data: EMPTY },
    },
    layers: [...ground, placeLabels, ...labels, ...top],
  };
}
