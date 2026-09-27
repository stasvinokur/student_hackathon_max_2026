import { describe, expect, it } from 'vitest';
import { findCycle, parseRulesPack } from './validate.js';

const manifest = {
  id: 'test-pack',
  version: '1.0.0',
  title: 'Test pack',
  region: { code: 'kazan', name: 'Казань' },
  industry: 'coffee',
  checked_at: '2026-09-18',
  cities: ['kazan'],
};

const source = { url: 'https://www.nalog.gov.ru/', title: 'ФНС', checked_at: '2026-09-18' };

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: 'register-business',
    title: 'Зарегистрировать ИП',
    lane: 'critical',
    duration_days: 3,
    why: 'Без регистрации нельзя вести деятельность',
    do_now: 'Подать заявление',
    done_when: 'Получен лист записи ЕГРИП',
    source,
    kind: 'official_fact',
    ...overrides,
  };
}

function pack(actions: unknown[]) {
  return { manifest, actions };
}

function issuesOf(raw: unknown) {
  const result = parseRulesPack(raw);
  if (result.ok) throw new Error('expected the pack to be rejected');
  return result.issues;
}

describe('parseRulesPack', () => {
  it('accepts a valid pack and fills defaults', () => {
    const result = parseRulesPack(
      pack([
        card({ applies_if: { all: [{ field: 'legal_status', eq: 'none' }, { not: { field: 'employees', gt: 10 } }] } }),
        card({
          id: 'open-account',
          title: 'Открыть счёт',
          lane: 'support',
          kind: 'recommendation',
          source: undefined,
          depends_on: ['register-business'],
          applies_if: { any: [{ field: 'format', in: ['cafe', 'to_go'] }, { field: 'sells_food', eq: true }] },
        }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.actions[0]).toMatchObject({ depends_on: [], prepare: [], due_days_before_opening: 0 });
    expect(result.pack.manifest.version).toBe('1.0.0');
  });

  it('rejects a critical action without source.url', () => {
    const issues = issuesOf(pack([card({ kind: 'test_data', source: { checked_at: '2026-09-18' } })]));
    expect(issues).toContainEqual({
      path: 'actions[register-business].source.url',
      message: expect.stringContaining('must link to an official source'),
    });
  });

  it('rejects a critical action without source.checked_at', () => {
    const issues = issuesOf(pack([card({ source: { url: 'https://www.nalog.gov.ru/', title: 'ФНС' } })]));
    expect(issues).toContainEqual({
      path: 'actions[register-business].source.checked_at',
      message: expect.stringContaining('when the source was checked'),
    });
  });

  it('rejects a critical action without any source', () => {
    const issues = issuesOf(pack([card({ source: undefined, kind: 'recommendation' })]));
    expect(issues.map((i) => i.path)).toEqual([
      'actions[register-business].source.url',
      'actions[register-business].source.checked_at',
    ]);
  });

  it('rejects an official_fact without a source even outside the critical lane', () => {
    const issues = issuesOf(pack([card({ lane: 'ops', source: undefined })]));
    expect(issues[0]?.message).toContain('official_fact');
  });

  it('allows a non-critical recommendation without a source', () => {
    expect(parseRulesPack(pack([card({ lane: 'support', kind: 'recommendation', source: undefined })])).ok).toBe(true);
  });

  it('rejects depends_on pointing to an unknown action', () => {
    const issues = issuesOf(pack([card({ depends_on: ['does-not-exist'] })]));
    expect(issues).toContainEqual({
      path: 'actions[register-business].depends_on',
      message: 'unknown action "does-not-exist" in depends_on',
    });
  });

  it('rejects a card listing the same prerequisite twice', () => {
    const issues = issuesOf(pack([card(), card({ id: 'open-account', depends_on: ['register-business', 'register-business'] })]));
    expect(issues).toEqual([{ path: 'actions[open-account].depends_on', message: 'duplicate action "register-business" in depends_on' }]);
  });

  it('rejects an action depending on itself', () => {
    const issues = issuesOf(pack([card({ depends_on: ['register-business'] })]));
    expect(issues[0]?.message).toContain('depends on itself');
  });

  it('rejects a dependency cycle and shows the chain', () => {
    const issues = issuesOf(
      pack([
        card({ id: 'a', depends_on: ['c'] }),
        card({ id: 'b', depends_on: ['a'] }),
        card({ id: 'c', depends_on: ['b'] }),
      ]),
    );
    expect(issues).toContainEqual({ path: 'actions[a].depends_on', message: 'dependency cycle: a → c → b → a' });
  });

  it('rejects a critical or ops action depending on a support action: an optional step cannot hold the opening back', () => {
    const optional = { lane: 'support', kind: 'recommendation', source: undefined };
    const issues = issuesOf(
      pack([
        card({ id: 'consult', title: 'Консультация', ...optional }),
        card({ depends_on: ['consult'] }),
        card({ id: 'hire-staff', title: 'Нанять команду', lane: 'ops', kind: 'recommendation', depends_on: ['consult'] }),
        // A support step may wait for another one.
        card({ id: 'open-account', title: 'Открыть счёт', ...optional, depends_on: ['consult', 'register-business'] }),
      ]),
    );
    expect(issues).toEqual([
      {
        path: 'actions[register-business].depends_on',
        message: 'critical action "register-business" depends on support action "consult": an optional step cannot hold the opening back',
      },
      {
        path: 'actions[hire-staff].depends_on',
        message: 'ops action "hire-staff" depends on support action "consult": an optional step cannot hold the opening back',
      },
    ]);
  });

  it('rejects a critical or ops action finishing after the opening: only a support step may', () => {
    const issues = issuesOf(
      pack([
        card({ due_days_before_opening: -10 }),
        card({ id: 'sign-contract', title: 'Подписать договор', lane: 'ops', kind: 'recommendation', due_days_before_opening: -1 }),
        card({ id: 'sout', title: 'Провести СОУТ', lane: 'support', kind: 'recommendation', source: undefined, due_days_before_opening: -300 }),
        card({ id: 'open-account', title: 'Открыть счёт', lane: 'ops', kind: 'recommendation', due_days_before_opening: 0 }),
      ]),
    );
    expect(issues).toEqual([
      {
        path: 'actions[register-business].due_days_before_opening',
        message: 'critical action "register-business" finishes after the opening (due_days_before_opening -10): only a support step may',
      },
      {
        path: 'actions[sign-contract].due_days_before_opening',
        message: 'ops action "sign-contract" finishes after the opening (due_days_before_opening -1): only a support step may',
      },
    ]);
  });

  it('rejects duplicate ids', () => {
    const issues = issuesOf(pack([card(), card()]));
    expect(issues).toContainEqual({ path: 'actions[register-business].id', message: 'duplicate action id "register-business"' });
  });

  it('rejects a card without kind or with an unknown kind', () => {
    const { kind: _kind, ...withoutKind } = card();
    expect(issuesOf(pack([withoutKind]))[0]?.path).toBe('actions[0].kind');
    expect(issuesOf(pack([card({ kind: 'rumour' })]))[0]?.path).toBe('actions[0].kind');
  });

  it('rejects predicates over unknown fields or with invalid values', () => {
    const issues = issuesOf(
      pack([
        card({
          applies_if: {
            all: [
              { field: 'favourite_colour', eq: 'red' },
              { field: 'format', eq: 'restaurant' },
              { field: 'format', gt: 1 },
              { field: 'sells_food', eq: 'yes' },
            ],
          },
        }),
      ]),
    );
    expect(issues.map((i) => i.path)).toEqual([
      'actions[register-business].applies_if.all[0].field',
      'actions[register-business].applies_if.all[1]',
      'actions[register-business].applies_if.all[2]',
      'actions[register-business].applies_if.all[3]',
    ]);
  });

  it('reports schema errors with a readable path', () => {
    const issues = issuesOf({ manifest: { ...manifest, version: 'v1' }, actions: [card({ id: 'Not Kebab', duration_days: -1 })] });
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['manifest.version', 'actions[0].id', 'actions[0].duration_days']),
    );
  });

  it('rejects an empty pack', () => {
    expect(issuesOf(pack([]))[0]?.path).toBe('actions');
  });
});

describe('parseRulesPack: places of steps', () => {
  const bbox = { south: 55.6, west: 48.8, north: 55.95, east: 49.4 };

  function place(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ifns-18',
      name: 'Межрайонная ИФНС № 18',
      address: 'Казань, ул. Владимира Кулагина, 1',
      lat: 55.74213,
      lon: 49.142156,
      osm: 'way/92939129',
      source: { url: 'https://www.nalog.gov.ru/rn16/ifns/16_mri18/', title: 'ФНС', checked_at: '2026-09-23' },
      ...overrides,
    };
  }

  /** A pack of a region with a bbox whose single card points to the place "ifns-18". */
  function withPlaces(places: unknown[], actions: unknown[] = [card({ places: ['ifns-18'] })], region: object = { ...manifest.region, bbox }) {
    return { manifest: { ...manifest, region }, places, actions };
  }

  it('accepts places referenced from cards', () => {
    const result = parseRulesPack(withPlaces([place({ note: 'Регистрирующая инспекция' })]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.places).toEqual([place({ note: 'Регистрирующая инспекция' })]);
    expect(result.pack.actions[0]?.places).toEqual(['ifns-18']);
  });

  it('accepts a place without an OpenStreetMap object', () => {
    const { osm: _osm, ...withoutOsm } = place();
    expect(parseRulesPack(withPlaces([withoutOsm])).ok).toBe(true);
  });

  it('takes a short name of up to 40 characters for the label on the map, and does without one', () => {
    const result = parseRulesPack(withPlaces([place({ short_name: 'ИФНС № 18' })]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.places[0]?.short_name).toBe('ИФНС № 18');
    expect(parseRulesPack(withPlaces([place({ short_name: 'И'.repeat(40) })])).ok).toBe(true);
    expect(parseRulesPack(withPlaces([place()])).ok).toBe(true);
  });

  it('rejects an empty short name, one of spaces only and one longer than 40 characters: a label is short or not there', () => {
    for (const short_name of ['', '   ', 'И'.repeat(41)]) {
      expect(issuesOf(withPlaces([place({ short_name })])).map((i) => i.path), JSON.stringify(short_name)).toEqual(['places[0].short_name']);
    }
    // Spaces around a label are no part of it.
    const result = parseRulesPack(withPlaces([place({ short_name: ' ИФНС № 18 ' })]));
    expect(result.ok && result.pack.places[0]?.short_name).toBe('ИФНС № 18');
  });

  it('rejects an OpenStreetMap reference other than node/<id>, way/<id> or relation/<id>', () => {
    for (const osm of ['way 92939129', 'ways/92939129', 'way/', 'way/9293a', 'area/92939129', 'https://www.openstreetmap.org/way/92939129']) {
      expect(issuesOf(withPlaces([place({ osm })])).map((i) => i.path), osm).toEqual(['places[0].osm']);
    }
  });

  it('defaults to no places in the pack and in a card', () => {
    const result = parseRulesPack(pack([card()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.places).toEqual([]);
    expect(result.pack.actions[0]?.places).toEqual([]);
  });

  it('rejects duplicate place ids', () => {
    const issues = issuesOf(withPlaces([place(), place({ name: 'Другая инспекция' })]));
    expect(issues).toEqual([{ path: 'places[ifns-18].id', message: 'duplicate place id "ifns-18"' }]);
  });

  it('rejects a place outside the region bbox, naming its coordinates and the bbox', () => {
    // The usual slip: latitude and longitude swapped.
    const issues = issuesOf(withPlaces([place({ lat: 49.142156, lon: 55.74213 })]));
    expect(issues).toEqual([
      {
        path: 'places[ifns-18]',
        message: 'place "ifns-18" (lat 49.142156, lon 55.74213) is outside manifest.region.bbox (south 55.6, west 48.8, north 55.95, east 49.4)',
      },
    ]);
  });

  it('accepts a place on the edge of the bbox', () => {
    expect(parseRulesPack(withPlaces([place({ lat: 55.95, lon: 48.8 })])).ok).toBe(true);
  });

  it('accepts any coordinates when the region has no bbox', () => {
    expect(parseRulesPack(withPlaces([place({ lat: 55.755864, lon: 37.617698 })], undefined, manifest.region)).ok).toBe(true);
  });

  it('rejects a card pointing to an unknown place', () => {
    const issues = issuesOf(withPlaces([place()], [card({ places: ['ifns-18', 'ifns-81'] })]));
    expect(issues).toEqual([{ path: 'actions[register-business].places', message: 'unknown place "ifns-81" in places' }]);
  });

  it('rejects a card listing the same place twice', () => {
    const issues = issuesOf(withPlaces([place()], [card({ places: ['ifns-18', 'ifns-18'] })]));
    expect(issues).toEqual([{ path: 'actions[register-business].places', message: 'duplicate place "ifns-18" in places' }]);
  });

  it('rejects a place no card points to: dead data is almost always a typo', () => {
    const issues = issuesOf(withPlaces([place(), place({ id: 'cgie-rt' })]));
    expect(issues).toEqual([{ path: 'places[cgie-rt]', message: 'unused place "cgie-rt": no action lists it in places' }]);
  });

  it('requires a source with url, title and checked_at for every place', () => {
    for (const field of ['url', 'title', 'checked_at'] as const) {
      const source: Record<string, string> = { ...place().source };
      delete source[field];
      expect(issuesOf(withPlaces([place({ source })])).map((i) => i.path), field).toEqual([`places[0].source.${field}`]);
    }
    const { source: _source, ...withoutSource } = place();
    expect(issuesOf(withPlaces([withoutSource])).map((i) => i.path)).toEqual(['places[0].source']);
  });

  it('reports schema errors of places with a readable path', () => {
    const issues = issuesOf(withPlaces([place({ id: 'Not Kebab', name: '', address: '', lat: 91, lon: -181, source: { ...place().source, url: 'ftp://x' } })]));
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['places[0].id', 'places[0].name', 'places[0].address', 'places[0].lat', 'places[0].lon', 'places[0].source.url']),
    );
    expect(issuesOf(withPlaces([place()], [card({ places: ['Not Kebab'] })])).map((i) => i.path)).toEqual(['actions[0].places[0]']);
  });
});

describe('findCycle', () => {
  it('returns null for an acyclic graph', () => {
    expect(findCycle([{ id: 'a', depends_on: [] }, { id: 'b', depends_on: ['a'] }])).toBeNull();
  });
});
