import { z } from 'zod';

/** Ids of packs, actions, places and location criteria: kebab-case (lowercase letters and digits, single dashes). */
export const KEBAB_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const Id = z.string().regex(KEBAB_ID, 'id must be kebab-case: lowercase letters, digits and dashes');
const IsoDate = z.iso.date('date must be YYYY-MM-DD');
const SourceUrl = z.url({ protocol: /^https?$/, error: 'source.url must be an http(s) URL' });
const Scalar = z.union([z.string(), z.number(), z.boolean()]);

// ---------- applies_if predicates ----------

export type Scalar = z.infer<typeof Scalar>;

export type Comparison =
  | { field: string; eq: Scalar }
  | { field: string; in: Scalar[] }
  | { field: string; gt: number }
  | { field: string; gte: number }
  | { field: string; lt: number }
  | { field: string; lte: number };

export type Predicate = { all: Predicate[] } | { any: Predicate[] } | { not: Predicate } | Comparison;

const ComparisonSchema = z.union([
  z.strictObject({ field: z.string(), eq: Scalar }),
  z.strictObject({ field: z.string(), in: z.array(Scalar).min(1) }),
  z.strictObject({ field: z.string(), gt: z.number() }),
  z.strictObject({ field: z.string(), gte: z.number() }),
  z.strictObject({ field: z.string(), lt: z.number() }),
  z.strictObject({ field: z.string(), lte: z.number() }),
]);

export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(PredicateSchema).min(1) }),
    z.strictObject({ any: z.array(PredicateSchema).min(1) }),
    z.strictObject({ not: PredicateSchema }),
    ComparisonSchema,
  ]),
);

// ---------- action cards ----------

export const LANES = ['critical', 'ops', 'support'] as const;
export const KINDS = ['official_fact', 'recommendation', 'test_data'] as const;

export const SourceSchema = z.strictObject({
  url: SourceUrl.optional(),
  title: z.string().min(1).optional(),
  checked_at: IsoDate.optional(),
});

export const ActionCardSchema = z.strictObject({
  id: Id,
  title: z.string().min(3),
  /** critical — can block the opening; ops — team and operations; support — optional improvements. */
  lane: z.enum(LANES),
  /** When absent, the action applies to every profile. */
  applies_if: PredicateSchema.optional(),
  depends_on: z.array(Id).default([]),
  /** How many days the action usually takes. */
  duration_days: z.number().int().min(0).max(365),
  /** Must be finished this many days before the opening date; negative — may be finished after opening (support steps only). */
  due_days_before_opening: z.number().int().min(-365).max(365).default(0),
  why: z.string().min(1),
  do_now: z.string().min(1),
  prepare: z.array(z.string().min(1)).default([]),
  done_when: z.string().min(1),
  /** Ids of the pack places where this step is done (RulesPack.places). */
  places: z.array(Id).default([]),
  source: SourceSchema.optional(),
  /** Provenance of the card: official requirement, our recommendation, or simulated data. */
  kind: z.enum(KINDS),
});

// ---------- places ----------

/** An address is an official fact, so unlike a card's source every field is required. */
export const PlaceSourceSchema = z.strictObject({
  url: SourceUrl,
  title: z.string().min(1),
  checked_at: IsoDate,
});

/**
 * A physical place in the city that route steps point to (doc-3 §7). One place can serve several steps,
 * so places form a catalog of the pack and cards refer to them by id.
 */
export const PlaceSchema = z.strictObject({
  id: Id,
  name: z.string().min(1),
  /**
   * The label of the place on the map, where a full official name would take three or four lines; name without it.
   * Trimmed: spaces alone are no label.
   */
  short_name: z.string().trim().min(1).max(40).optional(),
  address: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** The OpenStreetMap object the coordinates were taken from, e.g. node/9806747773. */
  osm: z
    .string()
    .regex(/^(node|way|relation)\/\d+$/, 'osm must be an OpenStreetMap object: node/<id>, way/<id> or relation/<id>')
    .optional(),
  /** Shown to the user as is: plain text about the place, no technical references. */
  note: z.string().min(1).optional(),
  source: PlaceSourceSchema,
});

// ---------- pack ----------

export const BBoxSchema = z
  .strictObject({ south: z.number(), west: z.number(), north: z.number(), east: z.number() })
  .refine((b) => b.south < b.north && b.west < b.east, 'bbox must have south < north and west < east');

export const PackManifestSchema = z.strictObject({
  id: Id,
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver, e.g. 1.0.0'),
  title: z.string().min(1),
  region: z.strictObject({
    code: Id,
    name: z.string().min(1),
    /** Other spellings users type for this city, matched case-insensitively. */
    aliases: z.array(z.string().min(1)).default([]),
    /** Bounding box used to recognise the city from a shared geolocation. */
    bbox: BBoxSchema.optional(),
  }),
  industry: z.string().min(1),
  /** Date the whole pack was last reviewed against official sources. */
  checked_at: IsoDate,
  /** City codes (Profile.city) this pack covers. */
  cities: z.array(z.string().min(1)).min(1),
  disclaimer: z.string().min(1).optional(),
});

export const RulesPackSchema = z.strictObject({
  manifest: PackManifestSchema,
  /** City places that route steps point to; every place must be listed in some card's places. */
  places: z.array(PlaceSchema).default([]),
  actions: z.array(ActionCardSchema).min(1),
});

export type BBox = z.infer<typeof BBoxSchema>;
export type Lane = (typeof LANES)[number];
export type Kind = (typeof KINDS)[number];
export type ActionCard = z.infer<typeof ActionCardSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type PackManifest = z.infer<typeof PackManifestSchema>;
export type RulesPack = z.infer<typeof RulesPackSchema>;
