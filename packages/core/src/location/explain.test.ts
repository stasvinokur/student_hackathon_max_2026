import { describe, expect, it } from 'vitest';
import { criterionReach, describeCriterion, explainCell, importanceLabel, indexAttribution, placeTitle } from './explain.js';
import { tinyLocationIndex as ix } from './fixtures.js';
import { parseLocationIndex } from './parse.js';
import { IMPORTANCE, type LocationIndex } from './schema.js';
import { scoreLocations, type LocationSettings } from './score.js';

const NBSP = '\u00a0';
const SOURCE = 'Данные © участники OpenStreetMap (ODbL), срез 23.09.2026 · индекс — расчёт «Открывай»';
const coordinates = (lat: string, lon: string) => `${lat}°${NBSP}с.${NBSP}ш., ${lon}°${NBSP}в.${NBSP}д.`;

function variant(mutate: (copy: LocationIndex) => void): LocationIndex {
  const copy = structuredClone(ix);
  mutate(copy);
  return copy;
}

/** `count` cells in rows of 100; office levels cycle through 0–100, nothing else around. */
function manyCells(count: number): LocationIndex {
  const zeros = () => new Array<number>(count).fill(0);
  return variant((copy) => {
    copy.grid = { ...copy.grid, rows: Math.ceil(count / 100), cols: 100 };
    copy.cells = {
      row: Array.from({ length: count }, (_, i) => Math.floor(i / 100)),
      col: Array.from({ length: count }, (_, i) => i % 100),
      level: { metro: zeros(), office: Array.from({ length: count }, (_, i) => i % 101), industrial: zeros() },
      fact: {
        metro: { near: new Array<number>(count).fill(-1), dist: zeros() },
        office: { n: zeros() },
        competitors: { n: zeros(), m: zeros() },
      },
    };
  });
}

/** A criterion of the fixture with some parameters changed. */
function criterion(index: number, patch: (copy: Record<string, unknown>) => void = () => {}) {
  const copy = structuredClone(ix.criteria[index]!);
  patch(copy as unknown as Record<string, unknown>);
  return copy;
}

describe('importanceLabel', () => {
  it('names the five levels for demand and for penalties', () => {
    expect(IMPORTANCE.map((importance) => importanceLabel('demand', importance))).toEqual([
      'Не учитывать',
      'Низкая',
      'Средняя',
      'Высокая',
      'Обязательно',
    ]);
    expect(IMPORTANCE.map((importance) => importanceLabel('penalty', importance))).toEqual([
      'Не учитывать',
      'Слабо снижать',
      'Снижать',
      'Сильно снижать',
      'Исключать',
    ]);
  });
});

describe('describeCriterion', () => {
  const decay = (full: number, zero: number) => criterion(0, (c) => (c.decay = { full, zero }));
  const required = (zero: string) => ` «Обязательно» оставляет только места, где есть такой объект ближе ${zero}.`;

  it('describes the nearest object for a cap of 1', () => {
    expect(describeCriterion(ix.criteria[0]!)).toBe(
      `Ближайший объект: полный вклад до 150${NBSP}м, дальше меньше, после 700${NBSP}м — ноль.${required(`700${NBSP}м`)}`,
    );
  });

  it('describes several nearest objects for a larger cap', () => {
    expect(describeCriterion(ix.criteria[1]!)).toBe(
      `До 40 ближайших объектов: полный вклад до 150${NBSP}м, дальше меньше, после 500${NBSP}м — ноль.${required(`500${NBSP}м`)}`,
    );
  });

  it('agrees the nearest objects with their number', () => {
    const objects = (cap: number) => describeCriterion(criterion(1, (c) => (c.cap = cap))).split(':')[0];
    expect([2, 5, 11, 12, 21, 101].map(objects)).toEqual([
      'До 2 ближайших объектов',
      'До 5 ближайших объектов',
      'До 11 ближайших объектов',
      'До 12 ближайших объектов',
      'До 21 ближайшего объекта',
      'До 101 ближайшего объекта',
    ]);
  });

  it('prints the distances of the methodology exactly', () => {
    expect(describeCriterion(decay(125, 1250))).toBe(
      `Ближайший объект: полный вклад до 125${NBSP}м, дальше меньше, после 1,25${NBSP}км — ноль.${required(`1,25${NBSP}км`)}`,
    );
  });

  it('describes all objects in reach without a cap', () => {
    const uncapped = criterion(1, (c) => {
      delete c.cap;
      c.decay = { full: 200, zero: 500 };
    });
    expect(describeCriterion(uncapped)).toBe(
      `Все объекты ближе 500${NBSP}м: полный вклад до 200${NBSP}м, дальше меньше, после 500${NBSP}м — ноль.${required(`500${NBSP}м`)}`,
    );
  });

  it('describes a step, a decay from the start and a short plateau', () => {
    expect(describeCriterion(decay(300, 300))).toBe(`Ближайший объект: полный вклад до 300${NBSP}м, дальше — ноль.${required(`300${NBSP}м`)}`);
    expect(describeCriterion(decay(0, 700))).toBe(
      `Ближайший объект: вклад убывает с расстоянием, после 700${NBSP}м — ноль.${required(`700${NBSP}м`)}`,
    );
    expect(describeCriterion(decay(30, 300))).toBe(
      `Ближайший объект: полный вклад до 30${NBSP}м, дальше меньше, после 300${NBSP}м — ноль.${required(`300${NBSP}м`)}`,
    );
  });

  it('describes competition against the usual for similar demand', () => {
    expect(describeCriterion(ix.criteria[2]!)).toBe(
      `Кофейни и кафе в 300${NBSP}м (кафе — за половину кофейни) против обычного для мест с похожим спросом. ` +
        '«Исключать» убирает места, где конкурентов вдвое больше обычного.',
    );
  });

  it('words the weight of other cafes', () => {
    const weighted = (indirectWeight: number) =>
      describeCriterion(criterion(2, (c) => Object.assign(c.saturation as object, { indirectWeight }))).match(/\((.+?)\)/)![1];
    expect([1, 0.5, 0.25, 0, 0.3, 0.5000001].map(weighted)).toEqual([
      'кафе — наравне с кофейней',
      'кафе — за половину кофейни',
      'кафе — за четверть кофейни',
      'другие кафе не в счёт',
      'кафе — с весом 0,3',
      'кафе — за половину кофейни',
    ]);
  });

  it('words the ratio that excludes a place, rounded to hundredths first', () => {
    const excluded = (excludeRatio: number) =>
      describeCriterion(criterion(2, (c) => Object.assign(c.saturation as object, { excludeRatio }))).split('где конкурентов ')[1];
    expect([1, 2, 3, 2.5, 5, 22, 1.0001, 2.001, 2.499, 4.999].map(excluded)).toEqual([
      'не меньше обычного.',
      'вдвое больше обычного.',
      'втрое больше обычного.',
      'в 2,5 раза больше обычного.',
      'в 5 раз больше обычного.',
      'в 22 раза больше обычного.',
      'не меньше обычного.',
      'вдвое больше обычного.',
      'в 2,5 раза больше обычного.',
      'в 5 раз больше обычного.',
    ]);
  });

  it('describes a share of the place', () => {
    expect(describeCriterion(ix.criteria[3]!)).toBe(
      `Доля площади места под такими объектами. «Исключать» убирает места, где эта доля не меньше 50${NBSP}%.`,
    );
    expect(describeCriterion(criterion(3, (c) => (c.excludeShare = 0.333)))).toBe(
      `Доля площади места под такими объектами. «Исключать» убирает места, где эта доля не меньше 33,3${NBSP}%.`,
    );
  });
});

describe('criterionReach', () => {
  it('names where a demand criterion stops counting', () => {
    expect(criterionReach(ix.criteria[0]!)).toBe(`до${NBSP}700${NBSP}м`);
    expect(criterionReach(ix.criteria[1]!)).toBe(`до${NBSP}500${NBSP}м`);
    // The zero of the decay, not the radius of the fact (400 m for offices) or the full-weight distance.
    expect(criterionReach(criterion(1, (c) => (c.decay = { full: 0, zero: 350 })))).toBe(`до${NBSP}350${NBSP}м`);
  });

  it('names the radius of the competitors counted', () => {
    expect(criterionReach(ix.criteria[2]!)).toBe(`до${NBSP}300${NBSP}м`);
    expect(criterionReach(criterion(2, (c) => Object.assign(c.fact as object, { radius: 450 })))).toBe(`до${NBSP}450${NBSP}м`);
  });

  it('calls a share criterion a share of the area', () => {
    expect(criterionReach(ix.criteria[3]!)).toBe('доля площади');
  });

  it('prints methodology distances exactly (1500 → «до 1,5 км»)', () => {
    expect(criterionReach(criterion(0, (c) => (c.decay = { full: 150, zero: 1500 })))).toBe(`до${NBSP}1,5${NBSP}км`);
    expect(criterionReach(criterion(0, (c) => (c.decay = { full: 150, zero: 1250 })))).toBe(`до${NBSP}1,25${NBSP}км`);
    expect(criterionReach(criterion(0, (c) => (c.decay = { full: 50, zero: 125 })))).toBe(`до${NBSP}125${NBSP}м`);
  });
});

describe('placeTitle', () => {
  it('names a cell after the nearest anchor within reach', () => {
    expect(placeTitle(ix, 6)).toBe('У метро «Кремлёвская»'); // 150 m
    expect(placeTitle(ix, 4)).toBe('У метро «Кремлёвская»'); // 335 m, within the 700 m of the anchor
  });

  it('falls back to the coordinates of the cell centre', () => {
    // The nearest metro object is an entrance without a name; the station is 750 m away, the anchor reaches 700 m.
    expect(placeTitle(ix, 3)).toBe(coordinates('55,790', '49,113'));
    expect(placeTitle(ix, 0)).toBe(coordinates('55,787', '49,099')); // no metro within 1 km
  });

  it('does not name a cell after an object without a name', () => {
    // The nearest object of cell 3 has no name: within the reach of the anchor it still names nothing.
    const closer = variant((copy) => {
      copy.cells.fact.metro!.near![3] = -2;
      copy.cells.fact.metro!.dist![3] = 600;
    });
    expect(parseLocationIndex(closer).ok).toBe(true);
    expect(placeTitle(closer, 3)).toBe(coordinates('55,790', '49,113'));
  });

  it('tries anchors by priority', () => {
    const withMall = variant((copy) => {
      const metro = copy.criteria[0]!;
      if (metro.model !== 'decay') throw new Error('metro is a decay criterion');
      metro.titleAnchor = { priority: 2, within: 700, text: 'У метро «{name}»' };
      copy.criteria.push({
        ...structuredClone(metro),
        id: 'mall',
        title: 'Торговые центры',
        fact: { type: 'nearest', max: 800, text: 'ТЦ «{name}» — {dist}', unnamed: 'ТЦ — {dist}', none: 'ТЦ ближе {max} нет' },
        titleAnchor: { priority: 1, within: 300, text: 'Рядом с ТЦ «{name}»' },
      });
      // 150 m west of the centre of cell 6, 450 m from the centre of cell 7.
      copy.places.push([4, 'Кольцо', 55.795431, 49.101283]);
      copy.cells.level.mall = [0, 0, 0, 0, 0, 0, 100, 45];
      copy.cells.fact.mall = { near: [-1, -1, -1, -1, -1, -1, 1, 1], dist: [0, 0, 0, 0, 0, 0, 150, 450] };
    });
    expect(parseLocationIndex(withMall).ok).toBe(true);
    expect(placeTitle(withMall, 6)).toBe('Рядом с ТЦ «Кольцо»');
    expect(placeTitle(withMall, 7)).toBe('У метро «Кремлёвская»'); // the mall is 450 m away, its anchor reaches 300 m
  });

  it('nests the quotes of a name inside the «…» of a template as „…“', () => {
    const named = (name: string) => variant((copy) => (copy.places[0]![1] = name));
    expect(placeTitle(named('Станция метро «Горки»'), 6)).toBe('У метро «Станция метро „Горки“»');
    expect(placeTitle(named('Кафе "Волга" и "Кама"'), 6)).toBe('У метро «Кафе „Волга“ и „Кама“»');
    expect(placeTitle(named('Кремлёвская'), 6)).toBe('У метро «Кремлёвская»');
  });

  it('writes southern latitudes and western longitudes', () => {
    const south = variant((copy) => (copy.grid.origin = { lat: -34.6, lon: -58.4 }));
    expect(placeTitle(south, 0)).toBe(`34,599°${NBSP}ю.${NBSP}ш., 58,398°${NBSP}з.${NBSP}д.`);
  });
});

describe('explainCell', () => {
  it('explains the best cell of the fixture', () => {
    expect(explainCell(ix, scoreLocations(ix), 6)).toEqual({
      cell: 6,
      score: 100,
      rank: 1,
      candidates: 8,
      title: 'У метро «Кремлёвская»',
      summary: `Индекс 100 из 100 — выше, чем у 100${NBSP}% подходящих мест (1-е место из 8)`,
      factors: [
        { id: 'metro', title: 'Метро', role: 'demand', importance: 'high', level: 100, points: 50, fact: `Метро «Кремлёвская» — 150${NBSP}м` },
        { id: 'office', title: 'Офисы и бизнес-центры', role: 'demand', importance: 'high', level: 80, points: 40, fact: `Офисов и бизнес-центров в 400${NBSP}м: 12` },
        { id: 'competitors', title: 'Кофейни и кафе рядом', role: 'penalty', importance: 'medium', level: null, points: 0, fact: `Кофеен в 300${NBSP}м: 2, других кафе: 3` },
        { id: 'industrial', title: 'Промзоны', role: 'penalty', importance: 'medium', level: 0, points: 0, fact: 'Промзон нет' },
      ],
      competition: { verdict: 'usual', text: `Для мест с похожим спросом обычно ≈${NBSP}3–4 — как обычно` },
      source: SOURCE,
    });
  });

  it('sorts contributions by size, penalties included', () => {
    const explanation = explainCell(ix, scoreLocations(ix), 5);
    expect(explanation.summary).toBe(`Индекс 29 из 100 — выше, чем у 29${NBSP}% подходящих мест (6-е место из 8)`);
    expect(explanation.factors.map((f) => [f.id, f.points])).toEqual([
      ['metro', 33],
      ['competitors', expect.closeTo((-100 * Math.log2(3)) / 6, 9)],
      ['office', 17],
      ['industrial', 0],
    ]);
  });

  it('splits raw into points of the criteria', () => {
    const settings: LocationSettings[] = [{}, { metro: 'off' }, { competitors: 'high', industrial: 'required' }, { office: 'low', metro: 'required' }];
    for (const s of settings) {
      const result = scoreLocations(ix, s);
      for (let cell = 0; cell < ix.cells.row.length; cell++) {
        const sum = explainCell(ix, result, cell).factors.reduce((total, f) => total + f.points, 0);
        expect(sum, `cell ${cell} with ${JSON.stringify(s)}`).toBeCloseTo(result.raw[cell]!, 9);
      }
    }
  });

  it('renders facts and their absence with non-breaking spaces', () => {
    const facts = (cell: number) => explainCell(ix, scoreLocations(ix), cell).factors.map((f) => f.fact);
    expect(facts(0)).toEqual([
      `Промзона — 60${NBSP}% квадрата`,
      `Метро дальше 1${NBSP}км`,
      `Офисов в 400${NBSP}м нет`,
      `Кофеен и кафе в 300${NBSP}м нет`,
    ]);
    expect(facts(2)).toContain(`Метро «Кремлёвская» — 910${NBSP}м`); // 912 m, rounded to 10 m
  });

  it('says how far the nearest object is when it has no name', () => {
    // Cell 3: an entrance without a name is 710 m away, the station 750 m.
    const facts = explainCell(ix, scoreLocations(ix), 3).factors.map((f) => f.fact);
    expect(facts).toContain(`Вход в метро — 710${NBSP}м`);

    const withRadius = variant((copy) => {
      Object.assign(copy.criteria[0]!.fact, { radius: 800, unnamed: 'Входов в метро в {radius}: {n}, ближайший — {dist}, дальше {max} не ищем' });
      copy.cells.fact.metro!.n = [0, 0, 0, 1, 1, 1, 1, 1];
    });
    expect(explainCell(withRadius, scoreLocations(withRadius), 3).factors.find((f) => f.id === 'metro')!.fact).toBe(
      `Входов в метро в 800${NBSP}м: 1, ближайший — 710${NBSP}м, дальше 1${NBSP}км не ищем`,
    );
  });

  it('prints the distances of the methodology in facts exactly', () => {
    const odd = variant((copy) => {
      Object.assign(copy.criteria[0]!.fact, { max: 1250 });
      Object.assign(copy.criteria[1]!.fact, { radius: 125 });
    });
    const facts = explainCell(odd, scoreLocations(odd), 0).factors.map((f) => f.fact);
    expect(facts).toContain(`Метро дальше 1,25${NBSP}км`);
    expect(facts).toContain(`Офисов в 125${NBSP}м нет`);
  });

  it('nests the quotes of a name in a fact only inside the «…» of its template', () => {
    const named = (name: string, text?: string) =>
      variant((copy) => {
        copy.places[0]![1] = name;
        if (text !== undefined) Object.assign(copy.criteria[0]!.fact, { text });
      });
    const metroFact = (copy: LocationIndex) => explainCell(copy, scoreLocations(copy), 6).factors.find((f) => f.id === 'metro')!.fact;
    expect(metroFact(named('Станция метро «Горки»'))).toBe(`Метро «Станция метро „Горки“» — 150${NBSP}м`);
    expect(metroFact(named('"Волга"'))).toBe(`Метро «„Волга“» — 150${NBSP}м`);
    // Outside «…» the name keeps its own quotes.
    expect(metroFact(named('ТЦ «Кольцо»', '{name} — {dist}'))).toBe(`ТЦ «Кольцо» — 150${NBSP}м`);
    expect(metroFact(named('ТЦ «Кольцо»', 'Рядом {name}, а в «кавычках» — {dist}'))).toBe(`Рядом ТЦ «Кольцо», а в «кавычках» — 150${NBSP}м`);
  });

  it('keeps a number with its unit when a template was typed with plain spaces', () => {
    // The fixture writes «{pct} % квадрата» with a plain space, as a YAML author would.
    expect(explainCell(ix, scoreLocations(ix), 0).factors[0]!.fact).toBe(`Промзона — 60${NBSP}% квадрата`);

    const typed = variant((copy) => {
      Object.assign(copy.criteria[2]!.fact, { text: 'Кофеен в 300 м: {n}, до центра 1,5 км, домов от 9 этажей, 5 минут пешком' });
    });
    const fact = explainCell(typed, scoreLocations(typed), 6).factors.find((f) => f.id === 'competitors')!.fact;
    expect(fact).toBe(`Кофеен в 300${NBSP}м: 2, до центра 1,5${NBSP}км, домов от 9 этажей, 5 минут пешком`);
  });

  it('judges competition against cells of similar demand', () => {
    const result = scoreLocations(ix);
    expect(explainCell(ix, result, 5).competition).toEqual({
      verdict: 'saturated',
      text: `Для мест с похожим спросом обычно ≈${NBSP}1 — рынок насыщен`,
    });
    expect(explainCell(ix, result, 4).competition).toEqual({
      verdict: 'niche',
      text: `Для мест с похожим спросом обычно ≈${NBSP}1 — свободная ниша`,
    });
    expect(explainCell(ix, result, 4).factors.find((f) => f.id === 'competitors')!.fact).toBe(`Кофеен и кафе в 300${NBSP}м нет`);
  });

  it('calls a ratio from 1.5 saturated and up to 0.5 a niche', () => {
    const result = scoreLocations(ix);
    const verdict = (ratio: number) => {
      result.competition!.ratio[1] = ratio;
      return explainCell(ix, result, 1).competition!.verdict;
    };
    expect(verdict(1.5)).toBe('saturated');
    expect(verdict(1.49)).toBe('usual');
    expect(verdict(0.51)).toBe('usual');
    expect(verdict(0.5)).toBe('niche');
  });

  it('says which required criterion a cell fails', () => {
    const explanation = explainCell(ix, scoreLocations(ix, { metro: 'required' }), 0);
    expect(explanation).toMatchObject({ score: null, rank: null, candidates: 4, summary: 'Не подходит под выбранные критерии: «Метро»' });
    expect(explanation.factors).toHaveLength(4);
  });

  it('says when the index cannot be computed', () => {
    const explanation = explainCell(ix, scoreLocations(ix, { metro: 'off', office: 'off' }), 2);
    expect(explanation).toMatchObject({ score: null, rank: null, summary: 'Индекс не рассчитан: включите хотя бы один критерий спроса' });
    expect(explanation.factors.every((f) => f.points === 0)).toBe(true);
  });

  it('says when a cell is the only candidate', () => {
    const onlyOne = variant((copy) => (copy.cells.level.metro = [0, 0, 0, 0, 0, 0, 100, 0]));
    const explanation = explainCell(onlyOne, scoreLocations(onlyOne, { metro: 'required' }), 6);
    expect(explanation).toMatchObject({ score: 100, rank: 1, candidates: 1, summary: 'Индекс 100 из 100 — единственное подходящее место' });
  });

  it('groups thousands in the rank and the number of candidates', () => {
    const big = manyCells(1300);
    expect(explainCell(big, scoreLocations(big), 0).summary).toBe(
      `Индекс 0 из 100 — выше, чем у 0${NBSP}% подходящих мест (1${NBSP}288-е место из 1${NBSP}300)`,
    );
  });

  it('has no competition verdict without a saturation criterion', () => {
    const withoutCafes = variant((copy) => {
      copy.criteria.splice(2, 1);
      delete copy.cells.fact.competitors;
    });
    expect(explainCell(withoutCafes, scoreLocations(withoutCafes), 2).competition).toBeNull();
  });

  it('rejects a cell that is not in the snapshot', () => {
    const result = scoreLocations(ix);
    for (const cell of [-1, 8, 1.5, Number.NaN]) {
      expect(() => explainCell(ix, result, cell), `cell ${cell}`).toThrow(RangeError);
      expect(() => placeTitle(ix, cell), `cell ${cell}`).toThrow(RangeError);
    }
  });

  it('takes the verdict thresholds from the methodology', () => {
    const stricter = variant((copy) => {
      const competitors = copy.criteria[2]!;
      if (competitors.model !== 'saturation') throw new Error('competitors is a saturation criterion');
      Object.assign(competitors.saturation, { saturatedRatio: 3.5, nicheRatio: 0.4 });
    });
    const result = scoreLocations(stricter);
    expect(explainCell(stricter, result, 5).competition!.verdict).toBe('usual'); // ratio 3
    expect(explainCell(stricter, result, 4).competition!.verdict).toBe('usual'); // ratio 0.5
  });

  it('builds the source line from the attribution of the snapshot', () => {
    const english = variant((copy) => (copy.source.attribution = '© OpenStreetMap contributors'));
    expect(explainCell(english, scoreLocations(english), 0).source).toBe(
      'Данные © OpenStreetMap contributors (ODbL), срез 23.09.2026 · индекс — расчёт «Открывай»',
    );
  });

  it('dates the source line by the OSM snapshot', () => {
    expect(explainCell(ix, scoreLocations(ix), 0).source).toBe(SOURCE);
    const later = variant((copy) => (copy.source.osmBase = '2027-01-05T00:00:00Z'));
    expect(explainCell(later, scoreLocations(later), 0).source).toBe(
      'Данные © участники OpenStreetMap (ODbL), срез 05.01.2027 · индекс — расчёт «Открывай»',
    );
  });
});

describe('indexAttribution', () => {
  it('is the source line of every cell card, for the list and the legend where no cell is chosen', () => {
    expect(indexAttribution(ix)).toBe(SOURCE);
    const result = scoreLocations(ix);
    for (let cell = 0; cell < ix.cells.row.length; cell++) expect(explainCell(ix, result, cell).source, `cell ${cell}`).toBe(SOURCE);
  });
});
