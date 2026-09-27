/**
 * The entrepreneur's answers collected by onboarding. Rules packs select
 * applicable actions by predicates over these fields.
 */
export interface Profile {
  /** coffee-to-go counter or a café with seating. */
  format: 'to_go' | 'cafe';
  /** City code of a supported rules pack, e.g. "kazan". */
  city: string;
  /** Registration status: not registered yet, sole proprietor, LLC. */
  legal_status: 'none' | 'ip' | 'ooo';
  /** Premises: still searching or lease/ownership already signed. */
  premises: 'searching' | 'signed';
  /** Planned number of hired employees (0 — works alone). */
  employees: number;
  /** Sells ready-made food, not only drinks. */
  sells_food: boolean;
  /** Planned opening date, YYYY-MM-DD. */
  opening_date: string;
}

/** Profile fields that rules may reference in `applies_if`, with their value domain. */
export const PREDICATE_FIELDS = {
  format: { type: 'enum', values: ['to_go', 'cafe'] },
  city: { type: 'string' },
  legal_status: { type: 'enum', values: ['none', 'ip', 'ooo'] },
  premises: { type: 'enum', values: ['searching', 'signed'] },
  employees: { type: 'number' },
  sells_food: { type: 'boolean' },
} as const satisfies Record<string, FieldSpec>;

export type FieldSpec =
  | { type: 'enum'; values: readonly string[] }
  | { type: 'string' }
  | { type: 'number' }
  | { type: 'boolean' };

export type PredicateField = keyof typeof PREDICATE_FIELDS;

export function isPredicateField(name: string): name is PredicateField {
  return Object.hasOwn(PREDICATE_FIELDS, name);
}
