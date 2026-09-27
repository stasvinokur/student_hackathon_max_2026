import { describe, expect, it } from 'vitest';
import * as core from './index.js';
import {
  buildingCentres,
  buildLocationIndex,
  CORE_VERSION,
  criterionReach,
  describeCriterion,
  explainCell,
  featuresFromOverpass,
  formatDistance,
  formatRadius,
  importanceLabel,
  indexAttribution,
  KEBAB_ID,
  overpassOsmBase,
  overpassQuery,
  parseLocationCriteria,
  parseLocationIndex,
  placeTitle,
  scoreLocations,
  type OverpassQueryOptions,
} from './index.js';
import { tinyLocationIndex } from './testing.js';

/** The metro of the tiny fixture, as the methodology config writes it. */
const tinyMetroConfig = {
  id: 'metro',
  title: 'Метро',
  role: 'demand',
  model: 'decay',
  default_importance: 'high',
  osm: ['node["railway"="subway_entrance"]', 'node["railway"="station"]["station"="subway"]'],
  decay: { full: 150, zero: 700 },
  cap: 1,
  norm: 'linear',
  fact: { type: 'nearest', max: 1000, text: 'Метро «{name}» — {dist}', unnamed: 'Вход в метро — {dist}', none: 'Метро дальше {max}' },
  title_anchor: { priority: 1, within: 700, text: 'У метро «{name}»' },
  min_features: 1,
};

describe('core', () => {
  it('exposes a version', () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exposes the id rule of packs, actions and criteria to the shell: kebab-case', () => {
    for (const id of ['kazan-coffee', 'lease-premises', 'a1']) expect(KEBAB_ID.test(id), id).toBe(true);
    for (const id of ['Kazan', 'kazan--coffee', '-kazan', 'kazan-', 'kazan_coffee', 'Bad_Id!', '']) expect(KEBAB_ID.test(id), id).toBe(false);
  });

  it('exposes the checks of an opening date that cannot be met to the shell', () => {
    for (const name of ['lateOpeningText', 'openingDelayDays', 'decideReschedule', 'decideKeep']) expect(core, name).toHaveProperty(name, expect.any(Function));
  });

  it('exposes the bot messages about the opening date and their buttons to the shell', () => {
    const names = [
      ...['rescheduleOpeningPayload', 'keepOpeningPayload', 'parseRoutePayload'],
      ...['rescheduleOfferReply', 'rescheduleReplies', 'keepOpeningReplies'],
    ];
    for (const name of names) expect(core, name).toHaveProperty(name, expect.any(Function));
    // The shell tells the route buttons apart by parseRoutePayload alone.
    for (const name of ['ROUTE_FIRST_STEP_PAYLOAD', 'parseRescheduleOpeningPayload', 'parseKeepOpeningPayload']) expect(core, name).not.toHaveProperty(name);
  });

  it('exposes the places of route steps to the shell', () => {
    for (const name of ['PlaceSchema', 'PlaceViewSchema', 'RoutePlaceSchema']) {
      expect(core, name).toHaveProperty(name, expect.objectContaining({ safeParse: expect.any(Function) }));
    }
  });

  it('exposes the location index to the shell', () => {
    const parsed = parseLocationIndex(tinyLocationIndex);
    if (!parsed.ok) throw new Error('the fixture must be valid');
    const result = scoreLocations(parsed.value, { metro: 'required' });
    expect(explainCell(parsed.value, result, result.top[0]!.cell).title).toBe('У метро «Кремлёвская»');
    expect(describeCriterion(parsed.value.criteria[0]!)).toMatch(/^Ближайший объект/);
    expect(criterionReach(parsed.value.criteria[0]!).replace(/\s/g, ' ')).toBe('до 700 м');
    expect(importanceLabel('penalty', 'required')).toBe('Исключать');
    expect(indexAttribution(parsed.value)).toBe('Данные © участники OpenStreetMap (ODbL), срез 23.09.2026 · индекс — расчёт «Открывай»');
    // Parameters of the methodology (the cell size) are printed exactly, measured distances are rounded.
    expect(formatRadius(125).replace(/\s/g, ' ')).toBe('125 м');
    expect(formatDistance(125).replace(/\s/g, ' ')).toBe('130 м');
  });

  it('exposes the offline builder to the CLI of the shell', () => {
    for (const name of ['buildLocationIndex', 'overpassQuery', 'buildingsQuery', 'overpassOsmBase', 'featuresFromOverpass', 'buildingCentres']) {
      expect(core, name).toHaveProperty(name, expect.any(Function));
    }

    // From Overpass answers to a snapshot the API serves, the way the CLI goes.
    const config = parseLocationCriteria({
      format: 'otkryvay.location-criteria/1',
      title: 'Где открыть кофейню в Казани',
      disclaimer: 'Модельная оценка по открытым данным OpenStreetMap.',
      grid: { cell_meters: 300, min_buildings: 3 },
      top: { size: 20, min_spacing_cells: 2 },
      criteria: [tinyMetroConfig],
    });
    if (!config.ok) throw new Error('the config must be valid');
    const bbox = { south: 55.786, west: 49.0965, north: 55.7967, east: 49.1155 };
    const options: OverpassQueryOptions = { date: '2026-09-23T19:28:21Z', timeoutSeconds: 60 };
    expect(overpassQuery(config.value.criteria[0]!, bbox, options)).toMatch(/^\[out:json\]\[timeout:60\]\[bbox:[^\]]+\]\[date:"2026-09-23T19:28:21Z"\];/);
    const station = { type: 'node', id: 9022338990, lat: 55.7951768, lon: 49.1070089, tags: { railway: 'station', station: 'subway', name: 'Кремлёвская' } };
    const answer = { osm3s: { timestamp_osm_base: '2026-09-23T19:28:21Z' }, elements: [station] };
    const ix = buildLocationIndex({
      pack: 'kazan-coffee',
      bbox,
      config: config.value,
      configSha256: tinyLocationIndex.source.configSha256,
      layers: { metro: featuresFromOverpass(answer, config.value.criteria[0]!) },
      buildings: buildingCentres({ elements: [] }),
      source: { ...tinyLocationIndex.source, osmBase: overpassOsmBase(answer)! },
    });
    expect(parseLocationIndex(ix).ok).toBe(true);
    expect(placeTitle(ix, 0)).toBe('У метро «Кремлёвская»');
  });

  it('keeps the internals of the location index and its test data out of the root entry', () => {
    const internals = [
      ...['saturation', 'percentileScores', 'spacedTop', 'decay', 'toLocal', 'metresPerDegree', 'pointInPolygon', 'factColumns', 'inBox'],
      ...['compareKeys', 'lineInside', 'clip', 'merge', 'borrowNames', 'neighbours', 'MAX_GRID_SIDE'],
    ];
    for (const name of [...internals, 'tinyLocationIndex']) {
      expect(core, name).not.toHaveProperty(name);
    }
  });
});
