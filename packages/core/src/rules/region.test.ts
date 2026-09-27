import { describe, expect, it } from 'vitest';
import { inBox } from './region.js';
import { BBoxSchema } from './schema.js';

const KAZAN = BBoxSchema.parse({ south: 55.6, west: 48.8, north: 55.95, east: 49.4 });

describe('inBox', () => {
  it('includes the edges of the box', () => {
    expect(inBox(KAZAN, 55.6, 48.8)).toBe(true);
    expect(inBox(KAZAN, 55.95, 49.4)).toBe(true);
    expect(inBox(KAZAN, 55.79, 49.12)).toBe(true);
  });

  it('rejects points outside the box', () => {
    expect(inBox(KAZAN, 55.5, 49)).toBe(false);
    expect(inBox(KAZAN, 55.79, 49.5)).toBe(false);
  });
});

describe('BBoxSchema', () => {
  it('rejects a box turned inside out', () => {
    expect(BBoxSchema.safeParse({ south: 55.95, west: 48.8, north: 55.6, east: 49.4 }).success).toBe(false);
  });
});
