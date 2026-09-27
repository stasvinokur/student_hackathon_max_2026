import { describe, expect, it } from 'vitest';
import { plural } from './plural.js';

describe('plural', () => {
  it('picks Russian plurals', () => {
    expect([1, 2, 5, 11, 21, 22, 25, 111].map((n) => plural(n, 'день', 'дня', 'дней'))).toEqual([
      'день', 'дня', 'дней', 'дней', 'день', 'дня', 'дней', 'дней',
    ]);
  });
});
