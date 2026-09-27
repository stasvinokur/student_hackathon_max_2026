import { z } from 'zod';
import { KEBAB_ID } from '../rules/schema.js';

// Two formats (doc-3 §4.2, §4.5):
// - LocationCriteria — the methodology a person edits (content/<pack>/location-criteria.yaml, snake_case);
// - LocationIndex — the snapshot the offline builder makes from it and OpenStreetMap (location-index.json,
//   camelCase). The runtime scores only the snapshot, so it carries everything scoring and explanation need.

// ---------- importance ----------

export const IMPORTANCE = ['off', 'low', 'medium', 'high', 'required'] as const;
export type Importance = (typeof IMPORTANCE)[number];

/** Weight of a criterion; `required` also drops the cells that fail it (doc-3 §3.6). */
export const IMPORTANCE_WEIGHT: Readonly<Record<Importance, number>> = { off: 0, low: 1, medium: 2, high: 3, required: 3 };

// ---------- shared parts ----------

// Same rule as rules pack ids: criterion ids become JSON keys of the cell columns.
const Id = z.string().regex(KEBAB_ID, 'id must be kebab-case: lowercase letters, digits and dashes');
/** Every distance of a methodology: beyond walking distance a criterion means nothing, and the builder slows down. */
const MAX_METRES = 5000;
const Metres = z.number().positive().max(MAX_METRES);
/** Plenty for a methodology; scoring keeps criterion indexes in an Int16Array. */
const MAX_CRITERIA = 64;
/**
 * Guards against absurd grids (4096 × 300 m ≈ 1 200 km, far beyond any city) and bounds future structures
 * sized by the whole grid; scoring itself allocates per listed cell, not per grid cell.
 */
export const MAX_GRID_SIDE = 4096;
const Template = z.string().min(1);
const Latitude = z.number().min(-90).max(90);
const Longitude = z.number().min(-180).max(180);
const Url = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' });

const OsmSelector = z
  .string()
  // doc-3 §4.2: ^(node|way|rel|nwr)(\[[^\[\];]+\])+$ — no statements or output modes can be injected.
  .regex(/^(node|way|rel|nwr)(\[[^[\];]+\])+$/, 'OSM selector must look like node["key"="value"]: element type and tag filters only');

/** Tag rule telling a coffee shop from another cafe: key=value or key~substring. */
const DirectTag = z.string().regex(/^[a-z][a-z0-9_:]*[=~].+$/, 'tag rule must look like key=value or key~value');

/** The name rule that tells a coffee shop from another cafe, compiled the same way wherever it is used. */
export function compileNamePattern(source: string): RegExp {
  return new RegExp(source, 'iu');
}

const NamePattern = z.string().min(1).max(200).refine(isNamePattern, 'must be a valid regular expression');

function isNamePattern(source: string): boolean {
  try {
    compileNamePattern(source);
    return true;
  } catch {
    return false;
  }
}

const DecaySchema = z
  .strictObject({
    /** Full weight up to this distance, metres. */
    full: z.number().nonnegative().max(MAX_METRES),
    /** No weight from this distance, metres. */
    zero: Metres,
  })
  .refine((d) => d.full <= d.zero, 'decay.full must not exceed decay.zero');

const TitleAnchorSchema = z.strictObject({
  /** Anchors are tried from priority 1 up; the first one close enough names the cell (doc-3 §3.8). */
  priority: z.number().int().min(1),
  /** The nearest object must have a name and be within this distance, metres. */
  within: Metres,
  text: Template,
});

// ---------- facts ----------
// A fact is a verifiable sentence about a cell, rendered from a template; its numbers are stored
// in the cell columns listed by factColumns(). Placeholders: {name} {dist} {n} {m} {radius} {pct} {max}.

const NearestFactSchema = z.strictObject({
  type: z.literal('nearest'),
  /** The nearest object up to this distance, named or not (columns near, dist); farther — the `none` text. */
  max: Metres,
  /** Also count objects within this radius (column n). */
  radius: Metres.optional(),
  /** The nearest object has a name: «Метро «Кремлёвская» — 350 м». */
  text: Template,
  /** The nearest object has none, like a metro entrance far from its station: «Вход в метро — 350 м». */
  unnamed: Template,
  none: Template,
});

const CountFactSchema = z.strictObject({
  type: z.literal('count'),
  /** Objects within this radius (column n). */
  radius: Metres,
  /** Also count objects with at least this many floors (column m). */
  floors: z.number().int().min(1).optional(),
  text: Template,
  /** Text when there is no object in the radius. */
  none: Template.optional(),
});

const CompetitorsFactSchema = z.strictObject({
  type: z.literal('competitors'),
  /** Coffee shops (column n) and other cafes (column m) within this radius. */
  radius: Metres,
  text: Template,
  none: Template.optional(),
});

const ShareFactSchema = z.strictObject({
  type: z.literal('share'),
  /** {pct} is the level of the criterion: the share of the cell in percent. */
  text: Template,
  none: Template.optional(),
});

const DecayFactSchema = z.discriminatedUnion('type', [NearestFactSchema, CountFactSchema]);

export type LocationFact =
  | z.infer<typeof NearestFactSchema>
  | z.infer<typeof CountFactSchema>
  | z.infer<typeof CompetitorsFactSchema>
  | z.infer<typeof ShareFactSchema>;

export const FACT_COLUMNS = ['near', 'dist', 'n', 'm'] as const;
export type FactColumn = (typeof FACT_COLUMNS)[number];

/**
 * Cell columns a fact reads: near — index in `places`, −2 when the nearest object has no name, −1 when there is
 * no object within fact.max; dist — metres to that object; n and m — counts.
 */
export function factColumns(fact: LocationFact): FactColumn[] {
  switch (fact.type) {
    case 'nearest':
      return fact.radius === undefined ? ['near', 'dist'] : ['near', 'dist', 'n'];
    case 'count':
      return fact.floors === undefined ? ['n'] : ['n', 'm'];
    case 'competitors':
      return ['n', 'm'];
    case 'share':
      return [];
  }
}

// ---------- methodology config (location-criteria.yaml) ----------
// The model fixes the role: decay criteria add demand, saturation and share criteria are penalties.

const criterionConfigBase = {
  id: Id,
  title: z.string().min(1),
  default_importance: z.enum(IMPORTANCE),
  osm: z.array(OsmSelector).min(1),
  /** The builder fails on fewer objects: an empty Overpass answer must not look like an empty city. */
  min_features: z.number().int().min(1),
};

const DecayCriterionConfigSchema = z
  .strictObject({
    ...criterionConfigBase,
    role: z.literal('demand'),
    model: z.literal('decay'),
    /** point (default) — nodes and centres of ways; line — ways as points every 25 m. */
    geometry: z.enum(['point', 'line']).optional(),
    /** Objects closer than this are merged into one (a stop mapped as several nodes), metres. */
    merge_within: Metres.optional(),
    /** An object without a name takes the name of the nearest named one within this distance: an entrance, its station's. */
    borrow_name_within: Metres.optional(),
    /** Weight of an object: footprint area × floors; each object counts 1 without it. */
    weight: z.strictObject({ kind: z.literal('area_levels'), default_levels: z.number().int().min(1) }).optional(),
    decay: DecaySchema,
    /** Only the `cap` nearest objects add up; without it, all objects closer than decay.zero. */
    cap: z.number().int().min(1).optional(),
    norm: z.enum(['linear', 'log']),
    fact: DecayFactSchema,
    title_anchor: TitleAnchorSchema.optional(),
  })
  // Merging joins points by their position (crossing streets would lose one), and a weight is a footprint's.
  .superRefine((criterion, ctx) => {
    if (criterion.merge_within !== undefined && (criterion.geometry === 'line' || criterion.weight !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['merge_within'], message: 'merge_within merges point objects: it cannot go with geometry: line or weight' });
    }
    if (criterion.weight !== undefined && criterion.geometry === 'line') {
      ctx.addIssue({ code: 'custom', path: ['weight'], message: 'weight weighs building footprints: it cannot go with geometry: line' });
    }
  });

const SaturationCriterionConfigSchema = z.strictObject({
  ...criterionConfigBase,
  role: z.literal('penalty'),
  model: z.literal('saturation'),
  /** What makes a cafe a coffee shop: a tag rule or the name. */
  direct: z.strictObject({ tags: z.array(DirectTag).min(1), name_pattern: NamePattern }),
  saturation: z
    .strictObject({
      /** Weight of another cafe against a coffee shop in the local competition. */
      indirect_weight: z.number().min(0).max(1),
      /** Largest bonus (negative saturation) of a cell without the usual competition. */
      niche_bonus: z.number().min(0).max(1),
      /** `required` drops cells whose competition ratio reaches this value. */
      exclude_ratio: z.number().min(1),
      /** Verdict «рынок насыщен» from this ratio of local to usual competition. */
      saturated_ratio: z.number().min(1).default(1.5),
      /** Verdict «свободная ниша» up to this ratio. */
      niche_ratio: z.number().gt(0).max(1).default(0.5),
    })
    // A cell excluded as saturated must also read «рынок насыщен».
    .refine(
      (s) => s.niche_ratio < s.saturated_ratio && s.saturated_ratio <= s.exclude_ratio,
      'saturation must keep niche_ratio < saturated_ratio ≤ exclude_ratio',
    ),
  fact: CompetitorsFactSchema,
});

const ShareCriterionConfigSchema = z.strictObject({
  ...criterionConfigBase,
  role: z.literal('penalty'),
  model: z.literal('share'),
  /** Always polygons; allowed so the config can say it explicitly (doc-3 §4.2). */
  geometry: z.literal('area').optional(),
  /** Always the share of the cell's area (doc-3 §3.3); allowed for the same reason. */
  norm: z.literal('share').optional(),
  /** `required` drops cells where the share reaches this value. */
  exclude_share: z.number().gt(0).max(1),
  fact: ShareFactSchema,
});

export const LocationCriterionConfigSchema = z.discriminatedUnion('model', [
  DecayCriterionConfigSchema,
  SaturationCriterionConfigSchema,
  ShareCriterionConfigSchema,
]);

export const LocationCriteriaSchema = z.strictObject({
  format: z.literal('otkryvay.location-criteria/1'),
  title: z.string().min(1),
  disclaimer: z.string().min(1),
  /** Steps of the rules pack the map helps with («Подобрать район на карте»). */
  linked_actions: z.array(Id).default([]),
  grid: z.strictObject({
    cell_meters: z.number().int().min(50).max(MAX_METRES),
    /** A cell enters the index with at least this many buildings or with a demand object. */
    min_buildings: z.number().int().min(0),
    /**
     * The builder fails on a built-up mask with fewer buildings, as min_features of a criterion does: an empty or cut
     * Overpass answer must not look like an empty city. Builder only: not in the snapshot.
     */
    min_features: z.number().int().min(1).optional(),
  }),
  top: z.strictObject({
    size: z.number().int().min(1),
    /** Places in the top are at least this many cells apart (Chebyshev distance). */
    min_spacing_cells: z.number().int().min(0),
  }),
  criteria: z.array(LocationCriterionConfigSchema).min(1).max(MAX_CRITERIA),
});

// ---------- snapshot (location-index.json) ----------

const criterionBase = {
  id: Id,
  title: z.string().min(1),
  defaultImportance: z.enum(IMPORTANCE),
  osm: z.array(OsmSelector).min(1),
  /** Objects of the criterion in the snapshot, after merging. */
  featureCount: z.number().int().min(0),
};

/** How exposure became a 0–100 level; P50 and P95 are taken over cells with exposure > 0 (doc-3 §3.3). */
function normSchema<Kind extends z.ZodType<string>>(kind: Kind) {
  return z
    .strictObject({ kind, p50: z.number().nonnegative(), p95: z.number().nonnegative() })
    .refine((norm) => norm.p50 <= norm.p95, 'norm.p50 must not exceed norm.p95');
}

const DecayCriterionSchema = z.strictObject({
  ...criterionBase,
  role: z.literal('demand'),
  model: z.literal('decay'),
  decay: DecaySchema,
  cap: z.number().int().min(1).optional(),
  norm: normSchema(z.enum(['linear', 'log'])),
  fact: DecayFactSchema,
  titleAnchor: TitleAnchorSchema.optional(),
});

const SaturationCriterionSchema = z.strictObject({
  ...criterionBase,
  role: z.literal('penalty'),
  model: z.literal('saturation'),
  direct: z.strictObject({ tags: z.array(DirectTag).min(1), namePattern: NamePattern }),
  saturation: z
    .strictObject({
      indirectWeight: z.number().min(0).max(1),
      nicheBonus: z.number().min(0).max(1),
      excludeRatio: z.number().min(1),
      saturatedRatio: z.number().min(1),
      nicheRatio: z.number().gt(0).max(1),
    })
    .refine(
      (s) => s.nicheRatio < s.saturatedRatio && s.saturatedRatio <= s.excludeRatio,
      'saturation must keep nicheRatio < saturatedRatio ≤ excludeRatio',
    ),
  fact: CompetitorsFactSchema,
});

const ShareCriterionSchema = z.strictObject({
  ...criterionBase,
  role: z.literal('penalty'),
  model: z.literal('share'),
  norm: normSchema(z.literal('share')),
  excludeShare: z.number().gt(0).max(1),
  fact: ShareFactSchema,
});

export const LocationCriterionSchema = z.discriminatedUnion('model', [
  DecayCriterionSchema,
  SaturationCriterionSchema,
  ShareCriterionSchema,
]);

/** [criterion index, name, lat, lon]: a named object a fact points to, e.g. a metro station. */
export const LocationPlaceSchema = z.tuple([z.number().int().min(0), z.string().min(1), Latitude, Longitude]);

const FactColumnsSchema = z.strictObject({
  near: z.array(z.number().int().min(-2)).optional(),
  dist: z.array(z.number().int().min(0)).optional(),
  n: z.array(z.number().int().min(0)).optional(),
  m: z.array(z.number().int().min(0)).optional(),
});

export const LocationIndexSchema = z.strictObject({
  format: z.literal('otkryvay.location-index/1'),
  pack: Id,
  /** OSM snapshot time and the first 8 hex digits of the config hash: 20260923T192821Z-3f9a1c2b. */
  version: z.string().regex(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/, 'version must look like 20260923T192821Z-3f9a1c2b'),
  title: z.string().min(1),
  disclaimer: z.string().min(1),
  dataStatus: z.literal('prepared_snapshot'),
  linkedActions: z.array(Id),
  /** From the config, so a new city changes the top without code (doc-3 §4.5 leaves it out). */
  top: z.strictObject({ size: z.number().int().min(1), minSpacingCells: z.number().int().min(0) }),
  /** ODbL notice: the snapshot is a derivative database of OpenStreetMap (doc-3 §4.6). */
  source: z.strictObject({
    name: z.literal('OpenStreetMap'),
    licence: z.literal('ODbL-1.0'),
    licenceUrl: Url,
    attribution: z.string().min(1),
    attributionUrl: Url,
    /** Time of the OSM data every layer was taken at (Overpass osm_base). */
    osmBase: z.iso.datetime({ precision: 0, error: 'must be a UTC time like 2026-09-23T19:28:21Z' }),
    extractedAt: z.iso.datetime(),
    /**
     * The Overpass mirror that answered the probe and fixed osmBase. Layers may come from other mirrors, at the same
     * osmBase: the probe record of the pipeline (probe-<T>.json next to its cache) lists the mirror of every layer.
     */
    endpoint: Url,
    /** The script that made the snapshot. */
    method: Url,
    configSha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest'),
  }),
  grid: z.strictObject({
    origin: z.strictObject({ lat: Latitude, lon: Longitude }),
    cellMeters: Metres,
    rows: z.number().int().min(1).max(MAX_GRID_SIDE),
    cols: z.number().int().min(1).max(MAX_GRID_SIDE),
    mPerDegLat: z.number().positive(),
    mPerDegLon: z.number().positive(),
  }),
  criteria: z.array(LocationCriterionSchema).min(1).max(MAX_CRITERIA),
  places: z.array(LocationPlaceSchema),
  /** Columns, one value per cell; cells are sorted by row, then col. */
  cells: z.strictObject({
    row: z.array(z.number().int().min(0)).min(1),
    col: z.array(z.number().int().min(0)),
    /** 0–100 per decay and share criterion. */
    level: z.record(Id, z.array(z.number().int().min(0).max(100))),
    /** Fact columns per criterion, see factColumns(). */
    fact: z.record(Id, FactColumnsSchema),
  }),
});

export type LocationCriteria = z.infer<typeof LocationCriteriaSchema>;
export type LocationCriterionConfig = z.infer<typeof LocationCriterionConfigSchema>;
export type LocationIndex = z.infer<typeof LocationIndexSchema>;
export type LocationCriterion = z.infer<typeof LocationCriterionSchema>;
export type SaturationCriterion = Extract<LocationCriterion, { model: 'saturation' }>;
export type LocationPlace = z.infer<typeof LocationPlaceSchema>;
