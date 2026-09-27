import { describe, expect, it } from 'vitest';
import type { Profile } from '../profile.js';
import { evaluatePredicate } from './predicate.js';
import type { Predicate } from './schema.js';

const profile: Profile = {
  format: 'to_go',
  city: 'kazan',
  legal_status: 'ip',
  premises: 'signed',
  employees: 2,
  sells_food: false,
  opening_date: '2026-11-01',
};

describe('evaluatePredicate', () => {
  const cases: [Predicate, boolean][] = [
    [{ field: 'format', eq: 'to_go' }, true],
    [{ field: 'format', eq: 'cafe' }, false],
    [{ field: 'legal_status', in: ['ip', 'ooo'] }, true],
    [{ field: 'legal_status', in: ['none'] }, false],
    [{ field: 'employees', gt: 0 }, true],
    [{ field: 'employees', gt: 2 }, false],
    [{ field: 'employees', gte: 2 }, true],
    [{ field: 'employees', lt: 2 }, false],
    [{ field: 'employees', lte: 2 }, true],
    [{ field: 'sells_food', eq: false }, true],
    [{ field: 'format', gt: 1 }, false],
    [{ not: { field: 'sells_food', eq: true } }, true],
    [{ all: [{ field: 'format', eq: 'to_go' }, { field: 'employees', gt: 0 }] }, true],
    [{ all: [{ field: 'format', eq: 'to_go' }, { field: 'employees', gt: 5 }] }, false],
    [{ any: [{ field: 'format', eq: 'cafe' }, { field: 'premises', eq: 'signed' }] }, true],
    [{ any: [{ field: 'format', eq: 'cafe' }, { field: 'premises', eq: 'searching' }] }, false],
  ];

  it.each(cases)('%j → %s', (predicate, expected) => {
    expect(evaluatePredicate(predicate, profile)).toBe(expected);
  });
});
