import type { Profile } from '../profile.js';
import type { Predicate } from './schema.js';

/** True when the profile satisfies the predicate. Pure; fields are validated when the pack is parsed. */
export function evaluatePredicate(predicate: Predicate, profile: Profile): boolean {
  if ('all' in predicate) return predicate.all.every((p) => evaluatePredicate(p, profile));
  if ('any' in predicate) return predicate.any.some((p) => evaluatePredicate(p, profile));
  if ('not' in predicate) return !evaluatePredicate(predicate.not, profile);

  const value = profile[predicate.field as keyof Profile];
  if ('eq' in predicate) return value === predicate.eq;
  if ('in' in predicate) return predicate.in.includes(value);
  if (typeof value !== 'number') return false;
  if ('gt' in predicate) return value > predicate.gt;
  if ('gte' in predicate) return value >= predicate.gte;
  if ('lt' in predicate) return value < predicate.lt;
  return value <= predicate.lte;
}
