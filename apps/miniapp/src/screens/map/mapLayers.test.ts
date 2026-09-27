import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expression, latest, validateStyleMin, type StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { cellCenter, cellRing, type RoutePlace } from '@otkryvay/core';
import { tinyLocationIndex } from '@otkryvay/core/testing';
import { describe, expect, it } from 'vitest';
import { darkFixture, positronFixture } from '../../test-basemaps.js';
import {
  BIN_FLOORS,
  cellsBounds,
  cellsToGeoJson,
  FLY_ZOOM,
  MAP_THEMES,
  mapBounds,
  mix,
  OVERLAY,
  placesToGeoJson,
  russianLabels,
  scoreBin,
  selectionCenter,
  selectionToGeoJson,
  startCamera,
  withOverlay,
  type MapScheme,
} from './mapLayers.js';

const ix = tinyLocationIndex;

function place(id: string, lat: number, lon: number, shortName: string | null = null): RoutePlace {
  return {
    id,
    name: `Место ${id}`,
    shortName,
    address: 'Казань',
    lat,
    lon,
    note: null,
    osmUrl: null,
    source: { url: 'https://example.org/', title: 'Источник', checkedAt: '2026-09-23' },
    actions: [{ id: 'register-business', title: 'Зарегистрировать ИП' }],
  };
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** OKLab lightness of a #rrggbb colour, 0 to 1: how far apart two steps look to a reader. */
function oklabL(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

const organicCss = readFileSync(join(import.meta.dirname, '../../organic.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties of the rule of organic.css with exactly this selector. */
function organicTokens(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(organicCss)?.[1];
  if (body === undefined) throw new Error(`no rule ${selector} in organic.css`);
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]));
}

/** The value of a token, var() followed to the end. */
function token(tokens: Map<string, string>, name: string): string {
  let value = tokens.get(name);
  for (let m; value && (m = /^var\((--o-[\w-]+)\)$/.exec(value)); ) value = tokens.get(m[1]!);
  if (!value) throw new Error(`no token ${name}`);
  return value;
}

describe('cellsToGeoJson', () => {
  it('draws every cell of the snapshot as its square, numbered as in the snapshot', () => {
    const grid = cellsToGeoJson(ix);
    expect(grid.type).toBe('FeatureCollection');
    expect(grid.features).toHaveLength(ix.cells.row.length);
    grid.features.forEach((feature, i) => {
      expect(feature.properties).toEqual({ cell: i });
      expect(feature.geometry).toEqual({ type: 'Polygon', coordinates: [cellRing(ix.grid, ix.cells.row[i]!, ix.cells.col[i]!)] });
    });
  });

  it('is built once per snapshot: a map opened anew (another scheme, another visit) takes the same squares', () => {
    expect(cellsToGeoJson(ix)).toBe(cellsToGeoJson(ix));
    const refreshed = structuredClone(ix);
    expect(cellsToGeoJson(refreshed)).not.toBe(cellsToGeoJson(ix));
    expect(cellsToGeoJson(refreshed)).toEqual(cellsToGeoJson(ix));
  });
});

describe('placesToGeoJson', () => {
  it('puts every place of the route at its coordinates with its id and label: the short name, else the name', () => {
    const places = [place('ifns-18', 55.74213, 49.142156, 'ИФНС № 18'), place('cgie-rt', 55.798172, 49.170644)];
    expect(placesToGeoJson(places)).toEqual({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { id: 'ifns-18', name: 'ИФНС № 18' }, geometry: { type: 'Point', coordinates: [49.142156, 55.74213] } },
        { type: 'Feature', properties: { id: 'cgie-rt', name: 'Место cgie-rt' }, geometry: { type: 'Point', coordinates: [49.170644, 55.798172] } },
      ],
    });
  });
});

describe('selectionToGeoJson', () => {
  const ifns = place('ifns-18', 55.74213, 49.142156);

  it('outlines the chosen cell and rings the chosen place; nothing when the map has no such card', () => {
    expect(selectionToGeoJson({ kind: 'cell', cell: 6 }, ix, []).features).toEqual([
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [cellRing(ix.grid, ix.cells.row[6]!, ix.cells.col[6]!)] } },
    ]);
    expect(selectionToGeoJson({ kind: 'place', id: 'ifns-18' }, null, [ifns]).features).toEqual([
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [49.142156, 55.74213] } },
    ]);
    expect(selectionToGeoJson({ kind: 'cell', cell: 99 }, ix, []).features).toEqual([]);
    expect(selectionToGeoJson({ kind: 'place', id: 'gone' }, ix, [ifns]).features).toEqual([]);
    expect(selectionToGeoJson(null, ix, [ifns]).features).toEqual([]);
  });
});

describe('scoreBin', () => {
  it('draws the top of the index finer: the lower half is one step, 97 and above another', () => {
    expect([0, 49, 50, 74, 75, 89, 90, 96, 97, 100].map(scoreBin)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect(BIN_FLOORS).toEqual([0, 50, 75, 90, 97]);
  });

  it('has no step for a place that does not pass the criteria', () => {
    expect(scoreBin(null)).toBeNull();
  });
});

describe('map themes', () => {
  it('take Positron for the light scheme of MAX and Dark for the dark one', () => {
    expect(MAP_THEMES.light.style).toBe('https://tiles.openfreemap.org/styles/positron');
    expect(MAP_THEMES.dark.style).toBe('https://tiles.openfreemap.org/styles/dark');
  });

  it('colour the five steps of the index from faint to strong over their map: darker on the light one, lighter on the dark one', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const theme = MAP_THEMES[scheme];
      const seen = theme.bins.map((color) => luminance(mix(color, theme.basemap, theme.binOpacity.city)));
      expect(seen, scheme).toHaveLength(5);
      const contrast = seen.map((l) => Math.abs(l - luminance(theme.basemap)));
      // Each step stands further from the map than the one below it.
      contrast.slice(1).forEach((c, i) => expect(c, `${scheme} step ${i + 1}`).toBeGreaterThan(contrast[i]!));
    }
  });

  it('take their colours from the tokens of Organic, which MapLibre cannot read: a token changed changes the map', () => {
    // The steps of the sage ramps, the terracotta of the places in a ring of cream, the text and the ground of the
    // theme for the labels, the chosen card and the borders of the cells.
    const light = organicTokens(':root');
    const dark = new Map([...light, ...organicTokens(":root[data-theme='dark']")]);
    expect(MAP_THEMES.light.bins).toEqual([300, 500, 600, 700, 800].map((step) => token(light, `--o-accent-2-${step}`)));
    expect(MAP_THEMES.dark.bins).toEqual([400, 500, 600, 700, 800].map((step) => token(dark, `--o-accent-2-${step}`)));
    expect(MAP_THEMES.light.place).toBe(token(light, '--o-accent'));
    expect(MAP_THEMES.dark.place).toBe(token(dark, '--o-accent-700'));
    for (const [scheme, tokens] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      const theme = MAP_THEMES[scheme];
      expect(theme.placeStroke, scheme).toBe(token(light, '--o-bg'));
      expect([theme.label, theme.selection], scheme).toEqual([token(tokens, '--o-text'), token(tokens, '--o-text')]);
      expect([theme.labelHalo, theme.selectionHalo, theme.cellBorder], scheme).toEqual(Array(3).fill(token(tokens, '--o-bg')));
    }
  });
});

describe('the style of the map', () => {
  const basemaps = { light: positronFixture, dark: darkFixture } as const;
  const styleOf = (scheme: MapScheme) => withOverlay(russianLabels(structuredClone(basemaps[scheme]) as StyleSpecification), MAP_THEMES[scheme]);
  const layer = (style: StyleSpecification, id: string) => style.layers.find((l) => l.id === id)!;

  it('is a valid MapLibre style with the layers of the app, over Positron and over Dark', () => {
    // A layer MapLibre rejects rejects the whole style: every user would get the lists only.
    for (const scheme of ['light', 'dark'] as const) expect(validateStyleMin(styleOf(scheme)), scheme).toEqual([]);
  });

  it('colours the five steps and leaves a cell that does not pass, or is not coloured yet, fully transparent', () => {
    const polygon = { type: 3 as const, properties: {} };
    for (const scheme of ['light', 'dark'] as const) {
      const grid = layer(styleOf(scheme), OVERLAY.layers.grid);
      if (grid.type !== 'fill') throw new Error('the grid is a fill layer');
      const color = expression.createPropertyExpression(grid.paint!['fill-color'], latest.paint_fill['fill-color']);
      const opacity = expression.createPropertyExpression(grid.paint!['fill-opacity'], latest.paint_fill['fill-opacity']);
      if (color.result !== 'success' || opacity.result !== 'success') throw new Error(`${scheme}: an expression MapLibre rejects`);
      for (const zoom of [9, 10, 12.5, 14, 15, 17]) {
        for (const state of [{}, { bin: -1 }]) {
          expect(color.value.evaluate({ zoom }, polygon, state).a, `${scheme} z${zoom} ${JSON.stringify(state)}`).toBe(0);
          expect(opacity.value.evaluate({ zoom }, polygon, state), `${scheme} z${zoom} ${JSON.stringify(state)}`).toBe(0);
        }
        const seen = MAP_THEMES[scheme].bins.map((hex, bin) => {
          const c = color.value.evaluate({ zoom }, polygon, { bin });
          expect([c.r, c.g, c.b, c.a].map((v) => Math.round(v * 255)), `${scheme} bin ${bin}`).toEqual([...channels(hex), 255]);
          expect(opacity.value.evaluate({ zoom }, polygon, { bin }), `${scheme} bin ${bin}`).toBeGreaterThan(0);
          return luminance(hex);
        });
        // Lighter to darker on the light map, darker to lighter on the dark one.
        seen.slice(1).forEach((l, i) => (scheme === 'light' ? expect(l).toBeLessThan(seen[i]!) : expect(l).toBeGreaterThan(seen[i]!)));
      }
    }
  });

  it('fades the grid towards street level, so the buildings under it show, and keeps its steps apart there', () => {
    const polygon = { type: 3 as const, properties: {} };
    for (const scheme of ['light', 'dark'] as const) {
      const theme = MAP_THEMES[scheme];
      const grid = layer(styleOf(scheme), OVERLAY.layers.grid);
      if (grid.type !== 'fill') throw new Error('the grid is a fill layer');
      const opacity = expression.createPropertyExpression(grid.paint!['fill-opacity'], latest.paint_fill['fill-opacity']);
      if (opacity.result !== 'success') throw new Error(`${scheme}: an expression MapLibre rejects`);
      const at = (zoom: number, bin: number) => opacity.value.evaluate({ zoom }, polygon, { bin }) as number;
      theme.bins.forEach((_, bin) => {
        expect(at(10, bin), `${scheme} step ${bin}`).toBeCloseTo(theme.binOpacity.city, 5);
        expect(at(15, bin), `${scheme} step ${bin}`).toBeCloseTo(theme.binOpacity.street[bin]!, 5);
        expect(at(12.5, bin), `${scheme} step ${bin}`).toBeLessThan(at(10, bin));
        expect(at(15, bin), `${scheme} step ${bin}`).toBeLessThan(at(12.5, bin));
      });
      // Each step looks further from the ground than the one below it (OKLab L), by this much over the whole city and,
      // fainter, at street level, where the thin borders of the cells help: a little under what the ramps give (the
      // comment of MAP_THEMES), so a ramp that loses its steps fails here.
      const least = { light: { 10: 0.075, 15: 0.05 }, dark: { 10: 0.085, 15: 0.045 } }[scheme];
      for (const zoom of [10, 15] as const) {
        const seen = theme.bins.map((color, bin) => oklabL(mix(color, theme.basemap, at(zoom, bin))));
        seen.slice(1).forEach((l, i) => {
          const gap = scheme === 'light' ? seen[i]! - l : l - seen[i]!;
          expect(gap, `${scheme} z${zoom} steps ${i} and ${i + 1}`).toBeGreaterThanOrEqual(least[zoom]);
        });
      }
    }
  });

  it('outlines the coloured cells from zoom 13, so neighbours of one step can be told apart', () => {
    const polygon = { type: 3 as const, properties: {} };
    for (const scheme of ['light', 'dark'] as const) {
      const borders = layer(styleOf(scheme), OVERLAY.layers.cellBorders);
      if (borders.type !== 'line') throw new Error('the borders are a line layer');
      expect(borders.minzoom, scheme).toBe(13);
      const opacity = expression.createPropertyExpression(borders.paint!['line-opacity'], latest.paint_line['line-opacity']);
      if (opacity.result !== 'success') throw new Error(`${scheme}: an expression MapLibre rejects`);
      expect(opacity.value.evaluate({ zoom: 15 }, polygon, { bin: 3 }), scheme).toBeGreaterThan(0);
      for (const state of [{}, { bin: -1 }]) expect(opacity.value.evaluate({ zoom: 15 }, polygon, state), scheme).toBe(0);
    }
  });

  it('lays the grid under every label of the basemap, and the names of the places under them: the city wins a collision', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const style = styleOf(scheme);
      const ids = style.layers.map((l) => l.id);
      const grid = ids.indexOf(OVERLAY.layers.grid);
      const firstRoad = style.layers.findIndex((l) => 'source-layer' in l && l['source-layer'] === 'transportation');
      expect(grid, scheme).toBeLessThan(firstRoad);
      expect(ids.indexOf(OVERLAY.layers.cellBorders), scheme).toBe(grid + 1);
      const basemapLabels = style.layers.filter((l) => l.type === 'symbol' && !l.id.startsWith('otk-')).map((l) => ids.indexOf(l.id));
      // Dark puts the names of the water under its buildings: every label of the basemap goes over the grid.
      expect(Math.min(...basemapLabels), scheme).toBeGreaterThan(grid);
      const placeLabels = ids.indexOf(OVERLAY.layers.placeLabels);
      expect(placeLabels, scheme).toBeLessThan(Math.min(...basemapLabels));
      const names = layer(style, OVERLAY.layers.placeLabels);
      expect(names.minzoom, scheme).toBe(13);
      // Before it gives way, a name tries every side of its marker: a street name often lies right under it.
      if (names.type !== 'symbol') throw new Error('the names are a symbol layer');
      expect(names.layout?.['text-variable-anchor'], scheme).toEqual(['top', 'bottom', 'left', 'right']);
      // The markers of the places and the chosen card lie over everything.
      expect(ids.slice(-4), scheme).toEqual([OVERLAY.layers.cellHalo, OVERLAY.layers.cell, OVERLAY.layers.places, OVERLAY.layers.place]);
    }
  });
});

describe('cellsBounds', () => {
  it('holds the squares of the given cells, and nothing without the index or cells', () => {
    const cells = [6, 1];
    const [[west, south], [east, north]] = cellsBounds(ix, cells)!;
    for (const cell of cells) {
      for (const [lon, lat] of cellRing(ix.grid, ix.cells.row[cell]!, ix.cells.col[cell]!)) {
        expect(lon).toBeGreaterThanOrEqual(west);
        expect(lon).toBeLessThanOrEqual(east);
        expect(lat).toBeGreaterThanOrEqual(south);
        expect(lat).toBeLessThanOrEqual(north);
      }
    }
    expect(cellsBounds(ix, [])).toBeNull();
    expect(cellsBounds(ix, [ix.cells.row.length])).toBeNull();
  });
});

/** The channels of a #rrggbb colour, 0–255. */
function channels(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

describe('mix', () => {
  it('lays a colour over another with the given opacity, as the map draws a translucent fill', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#2a78d6', '#eaeae6', 1)).toBe('#2a78d6');
    expect(mix('#2a78d6', '#eaeae6', 0)).toBe('#eaeae6');
  });
});

describe('russianLabels', () => {
  // The label expressions of the OpenFreeMap styles, abridged: a Latin name over the local one where both exist.
  const twoNames = ['case', ['has', 'name:nonlatin'], ['concat', ['get', 'name:latin'], '\n', ['get', 'name:nonlatin']], ['coalesce', ['get', 'name_en'], ['get', 'name']]];
  const style = {
    version: 8,
    sources: {},
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': 'rgb(242,243,240)' } },
      { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': 'rgb(194, 200, 202)' } },
      { id: 'label_city', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', layout: { 'text-field': twoNames, 'text-font': ['Noto Sans Regular'] } },
      { id: 'highway-name-minor', type: 'symbol', source: 'openmaptiles', layout: { 'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']] } },
      { id: 'legacy', type: 'symbol', source: 'openmaptiles', layout: { 'text-field': '{name:latin}\n{name:nonlatin}' } },
      { id: 'highway-shield', type: 'symbol', source: 'openmaptiles', layout: { 'text-field': ['to-string', ['get', 'ref']] } },
      { id: 'road_oneway', type: 'symbol', source: 'openmaptiles', layout: { 'icon-image': 'arrow' } },
    ],
  };

  it('names places in Russian, where the tiles have it, instead of a Latin name over the local one', () => {
    const patched = russianLabels(style);
    const field = (id: string) => patched.layers.find((layer) => layer.id === id)?.layout?.['text-field'];
    const russian = ['coalesce', ['get', 'name:ru'], ['get', 'name']];
    expect(field('label_city')).toEqual(russian);
    expect(field('highway-name-minor')).toEqual(russian);
    expect(field('legacy')).toEqual(russian);
    // The rest of a label layer stays as it was.
    expect(patched.layers.find((layer) => layer.id === 'label_city')?.layout?.['text-font']).toEqual(['Noto Sans Regular']);
  });

  it('keeps road numbers, labels without text and layers that draw no labels', () => {
    const patched = russianLabels(style);
    for (const id of ['background', 'water', 'highway-shield', 'road_oneway']) {
      expect(patched.layers.find((layer) => layer.id === id), id).toBe(style.layers.find((layer) => layer.id === id));
    }
  });

  it('leaves the style it was given as it was', () => {
    const before = structuredClone(style);
    russianLabels(style);
    expect(style).toEqual(before);
  });
});

describe('cameras and bounds', () => {
  const ifns = place('ifns-18', 55.74213, 49.142156);
  const cgie = place('cgie-rt', 55.798172, 49.170644);

  it('find a cell and a place on the map; a cell the snapshot lacks and an unknown place are nowhere', () => {
    const { lat, lon } = cellCenter(ix.grid, ix.cells.row[6]!, ix.cells.col[6]!);
    expect(selectionCenter({ kind: 'cell', cell: 6 }, ix, [])).toEqual([lon, lat]);
    expect(selectionCenter({ kind: 'cell', cell: ix.cells.row.length }, ix, [])).toBeNull();
    expect(selectionCenter({ kind: 'cell', cell: 6 }, null, [])).toBeNull();
    expect(selectionCenter({ kind: 'place', id: 'cgie-rt' }, null, [ifns, cgie])).toEqual([49.170644, 55.798172]);
    expect(selectionCenter({ kind: 'place', id: 'gone' }, null, [ifns])).toBeNull();
    expect(FLY_ZOOM).toBe(14);
  });

  it('start a new map over the middle of the index, or of the places without it, at the zoom of a city', () => {
    const north = ix.grid.origin.lat + (ix.grid.rows * ix.grid.cellMeters) / ix.grid.mPerDegLat;
    const east = ix.grid.origin.lon + (ix.grid.cols * ix.grid.cellMeters) / ix.grid.mPerDegLon;
    const camera = startCamera(ix, [ifns]);
    expect(camera.zoom).toBe(10);
    expect(camera.center[0]).toBeCloseTo((ix.grid.origin.lon + east) / 2, 6);
    expect(camera.center[1]).toBeCloseTo((ix.grid.origin.lat + north) / 2, 6);

    const byPlaces = startCamera(null, [ifns, cgie]);
    expect(byPlaces.center[0]).toBeCloseTo((49.142156 + 49.170644) / 2, 6);
    expect(byPlaces.center[1]).toBeCloseTo((55.74213 + 55.798172) / 2, 6);
  });

  it('keep the map around the index with a margin, or around the places without it', () => {
    const [[west, south], [east, north]] = mapBounds(ix, [])!;
    const gridNorth = ix.grid.origin.lat + (ix.grid.rows * ix.grid.cellMeters) / ix.grid.mPerDegLat;
    const gridEast = ix.grid.origin.lon + (ix.grid.cols * ix.grid.cellMeters) / ix.grid.mPerDegLon;
    expect(west).toBeLessThan(ix.grid.origin.lon);
    expect(south).toBeLessThan(ix.grid.origin.lat);
    expect(east).toBeGreaterThan(gridEast);
    expect(north).toBeGreaterThan(gridNorth);

    const [[pWest, pSouth], [pEast, pNorth]] = mapBounds(null, [ifns, cgie])!;
    expect(pWest).toBeLessThan(49.142156);
    expect(pSouth).toBeLessThan(55.74213);
    expect(pEast).toBeGreaterThan(49.170644);
    expect(pNorth).toBeGreaterThan(55.798172);
    expect(mapBounds(null, [])).toBeNull();
  });
});
