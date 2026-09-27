import { describe, expect, it } from 'vitest';
import { cardOpenedEvent, initialUi } from './model.js';

describe('initialUi', () => {
  it('opens the card a step asked for; «Подобрать район на карте» keeps the criteria folded', () => {
    // A card a step asks for is shown like one opened from a list: the map flies to it, it takes the focus.
    expect(initialUi({ kind: 'place', id: 'ifns-18' })).toEqual({ selected: { kind: 'place', id: 'ifns-18' }, criteriaOpen: false, openedFrom: 'list' });
    expect(initialUi({ kind: 'cell', cell: 6 })).toEqual({ selected: { kind: 'cell', cell: 6 }, criteriaOpen: false, openedFrom: 'list' });
    expect(initialUi({ kind: 'index' })).toEqual({ selected: null, criteriaOpen: false, openedFrom: 'list' });
    expect(initialUi(undefined)).toEqual({ selected: null, criteriaOpen: false, openedFrom: 'list' });
  });
});

describe('cardOpenedEvent', () => {
  it('names the opened card for the analytics; a cell comes with its snapshot, its number means nothing without it', () => {
    expect(cardOpenedEvent({ kind: 'cell', cell: 6 }, '20260923T192821Z-3f9a1c2b', 'map')).toEqual([
      'location_cell_opened',
      { cell: 6, version: '20260923T192821Z-3f9a1c2b', from: 'map' },
    ]);
    // A step opens its card outside the map, as a list does.
    expect(cardOpenedEvent({ kind: 'place', id: 'ifns-18' }, undefined, 'list')).toEqual(['place_opened', { place: 'ifns-18', from: 'list' }]);
  });
});
