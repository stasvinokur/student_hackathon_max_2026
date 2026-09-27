import { formatDate } from '../rules/dates.js';
import { plural } from '../rules/plural.js';
import { cellCenter, formatDistance, formatInt, formatRadius, NBSP } from './geo.js';
import { IMPORTANCE_WEIGHT, type Importance, type LocationCriterion, type LocationIndex } from './schema.js';
import type { ScoreResult } from './score.js';

// Why a cell got its index: every figure is a checkable fact about the place (doc-3 §3.8), and the
// points of the criteria add up to the raw score, so the bars of the card explain the rank exactly.

export interface CellFactor {
  id: string;
  title: string;
  role: 'demand' | 'penalty';
  importance: Importance;
  /** 0–100; null for the saturation criterion, which is judged by its ratio instead. */
  level: number | null;
  /** Contribution to raw: the points of all criteria add up to the cell's raw score. */
  points: number;
  fact: string;
}

export type CompetitionVerdict = 'saturated' | 'usual' | 'niche';

export interface CellExplanation {
  cell: number;
  score: number | null;
  rank: number | null;
  candidates: number;
  title: string;
  summary: string;
  /** Every criterion, the largest |points| first. */
  factors: CellFactor[];
  competition: { verdict: CompetitionVerdict; text: string } | null;
  /** ODbL attribution dated by the OSM snapshot (doc-3 §4.6). */
  source: string;
}

const VERDICT_TEXT: Readonly<Record<CompetitionVerdict, string>> = {
  saturated: 'рынок насыщен',
  usual: 'как обычно',
  niche: 'свободная ниша',
};

const IMPORTANCE_LABELS: Readonly<Record<LocationCriterion['role'], Readonly<Record<Importance, string>>>> = {
  demand: { off: 'Не учитывать', low: 'Низкая', medium: 'Средняя', high: 'Высокая', required: 'Обязательно' },
  penalty: { off: 'Не учитывать', low: 'Слабо снижать', medium: 'Снижать', high: 'Сильно снижать', required: 'Исключать' },
};

/** Label of an importance level in the criteria panel (doc-3 §3.6): demand and penalties read differently. */
export function importanceLabel(role: LocationCriterion['role'], importance: Importance): string {
  return IMPORTANCE_LABELS[role][importance];
}

/**
 * What a criterion counts and what its strictest level does, in plain words built from its parameters.
 * Each text names the level in quotes with a verb: «Обязательно» оставляет…, «Исключать» убирает…
 */
export function describeCriterion(criterion: LocationCriterion): string {
  switch (criterion.model) {
    case 'decay': {
      const { full, zero } = criterion.decay;
      const { cap } = criterion;
      const objects =
        cap === undefined
          ? `Все объекты ближе ${formatRadius(zero)}`
          : cap === 1
            ? 'Ближайший объект'
            : `До ${cap} ${plural(cap, 'ближайшего объекта', 'ближайших объектов', 'ближайших объектов')}`;
      const falloff =
        full >= zero
          ? `полный вклад до ${formatRadius(zero)}, дальше — ноль`
          : full === 0
            ? `вклад убывает с расстоянием, после ${formatRadius(zero)} — ноль`
            : `полный вклад до ${formatRadius(full)}, дальше меньше, после ${formatRadius(zero)} — ноль`;
      return (
        `${objects}: ${falloff}. «${importanceLabel('demand', 'required')}» оставляет только места, ` +
        `где есть такой объект ближе ${formatRadius(zero)}.`
      );
    }
    case 'saturation': {
      const { indirectWeight, excludeRatio } = criterion.saturation;
      return (
        `Кофейни и кафе в ${formatRadius(criterion.fact.radius)} (${otherCafes(indirectWeight)}) против обычного для мест с похожим спросом. ` +
        `«${importanceLabel('penalty', 'required')}» убирает места, где конкурентов ${timesTheUsual(excludeRatio)}.`
      );
    }
    case 'share':
      return (
        `Доля площади места под такими объектами. «${importanceLabel('penalty', 'required')}» убирает места, ` +
        `где эта доля не меньше ${decimal(criterion.excludeShare * 100)}${NBSP}%.`
      );
  }
}

/**
 * How far a criterion looks, in a few words for its row in the criteria panel: «до 700 м», «до 300 м», «доля площади».
 * Demand counts up to the zero of its decay, competitors within the radius of their fact; a share has no radius.
 * «до» is bound to the distance with NBSP, as in formatDistance: a narrow column must not leave it alone on a line.
 */
export function criterionReach(criterion: LocationCriterion): string {
  switch (criterion.model) {
    case 'decay':
      return `до${NBSP}${formatRadius(criterion.decay.zero)}`;
    case 'saturation':
      return `до${NBSP}${formatRadius(criterion.fact.radius)}`;
    case 'share':
      return 'доля площади';
  }
}

const OTHER_CAFES: Readonly<Record<number, string>> = {
  1: 'кафе — наравне с кофейней',
  0.5: 'кафе — за половину кофейни',
  0.25: 'кафе — за четверть кофейни',
  0: 'другие кафе не в счёт',
};

function otherCafes(weight: number): string {
  const rounded = hundredths(weight);
  return OTHER_CAFES[rounded] ?? `кафе — с весом ${decimal(rounded)}`;
}

const TIMES_THE_USUAL: Readonly<Record<number, string>> = {
  1: 'не меньше обычного',
  2: 'вдвое больше обычного',
  3: 'втрое больше обычного',
};

/** «вдвое», «в 2,5 раза», «в 5 раз», «в 22 раза»: the words follow the ratio as it is printed. */
function timesTheUsual(ratio: number): string {
  const rounded = hundredths(ratio);
  const word = TIMES_THE_USUAL[rounded];
  if (word) return word;
  const times = Number.isInteger(rounded) ? plural(rounded, 'раз', 'раза', 'раз') : 'раза';
  return `в ${decimal(rounded)} ${times} больше обычного`;
}

function hundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Up to two decimals with a comma: 0.3 → «0,3», 33.3 → «33,3», 50 → «50». */
function decimal(value: number): string {
  return String(hundredths(value)).replace('.', ',');
}

export function explainCell(ix: LocationIndex, result: ScoreResult, cell: number): CellExplanation {
  checkCell(ix, cell);
  const score = result.scores[cell] ?? null;
  const rank = score === null ? null : rankOf(result, cell);
  return {
    cell,
    score,
    rank,
    candidates: result.candidates,
    title: placeTitle(ix, cell),
    summary: summaryOf(ix, result, cell, score, rank),
    factors: cellFactors(ix, result, cell),
    competition: competitionOf(ix, result, cell),
    source: indexAttribution(ix),
  };
}

/**
 * ODbL attribution next to the index (doc-3 §4.6): «Данные © участники OpenStreetMap (ODbL), срез 23.09.2026 ·
 * индекс — расчёт «Открывай»». The date is the UTC date of source.osmBase. The same line as the source of a cell
 * card, for the legend and the list, where no cell is chosen.
 */
export function indexAttribution(ix: LocationIndex): string {
  const { attribution, licence, osmBase } = ix.source;
  const licenceName = licence.replace(/-[\d.]+$/, ''); // ODbL-1.0 → ODbL
  return `Данные ${attribution} (${licenceName}), срез ${formatDate(osmBase.slice(0, 10), true)} · индекс — расчёт «Открывай»`;
}

/**
 * Name of a cell: the anchor with the smallest priority whose nearest object has a name and is within reach
 * («У метро «Кремлёвская»»), otherwise the coordinates of the cell centre («55,790° с. ш., 49,120° в. д.»).
 */
export function placeTitle(ix: LocationIndex, cell: number): string {
  checkCell(ix, cell);
  let best: { priority: number; title: string } | undefined;
  for (const criterion of ix.criteria) {
    if (criterion.model !== 'decay' || !criterion.titleAnchor || criterion.fact.type !== 'nearest') continue;
    const anchor = criterion.titleAnchor;
    if (best && best.priority <= anchor.priority) continue;
    const columns = ix.cells.fact[criterion.id];
    const place = ix.places[columns?.near?.[cell] ?? -1];
    const dist = columns?.dist?.[cell] ?? Infinity;
    if (place && dist <= anchor.within) {
      best = { priority: anchor.priority, title: render(anchor.text, { name: place[1], dist: formatDistance(dist) }) };
    }
  }
  return best?.title ?? coordinatesOf(ix, cell);
}

/** Contribution of every criterion to the raw score of a cell, the largest |points| first. */
export function cellFactors(ix: LocationIndex, result: ScoreResult, cell: number): CellFactor[] {
  const weights = result.importance.map((importance) => IMPORTANCE_WEIGHT[importance]);
  const demandWeight = ix.criteria.reduce((sum, criterion, c) => (criterion.model === 'decay' ? sum + weights[c]! : sum), 0);

  const factors = ix.criteria.map((criterion, c): CellFactor => {
    let level: number | null = null;
    let value: number; // signed contribution per unit of weight
    if (criterion.model === 'saturation') {
      value = -100 * (result.competition?.s[cell] ?? 0);
    } else {
      level = ix.cells.level[criterion.id]?.[cell] ?? 0;
      value = criterion.model === 'decay' ? level : -level;
    }
    return {
      id: criterion.id,
      title: criterion.title,
      role: criterion.role,
      importance: result.importance[c]!,
      level,
      // + 0 turns −0 (a zero penalty) into 0.
      points: demandWeight > 0 ? (weights[c]! * value) / demandWeight + 0 : 0,
      fact: factText(ix, criterion, cell),
    };
  });
  return factors.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
}

/** A wrong index would read past the columns and yield plausible nonsense («NaN° с. ш.»), so it throws. */
function checkCell(ix: LocationIndex, cell: number): void {
  if (!Number.isInteger(cell) || cell < 0 || cell >= ix.cells.row.length) {
    throw new RangeError(`cell ${cell} is not in the snapshot (cells: ${ix.cells.row.length})`);
  }
}

function rankOf(result: ScoreResult, cell: number): number {
  const raw = result.raw[cell]!;
  let higher = 0;
  for (let i = 0; i < result.scores.length; i++) if (result.scores[i] !== null && result.raw[i]! > raw) higher++;
  return higher + 1;
}

function summaryOf(ix: LocationIndex, result: ScoreResult, cell: number, score: number | null, rank: number | null): string {
  if (result.warnings.includes('no_demand_criteria')) return 'Индекс не рассчитан: включите хотя бы один критерий спроса';
  if (score === null || rank === null) {
    const failed = ix.criteria[result.excludedBy[cell] ?? -1];
    return failed ? `Не подходит под выбранные критерии: «${failed.title}»` : 'Не подходит под выбранные критерии';
  }
  if (result.candidates === 1) return 'Индекс 100 из 100 — единственное подходящее место';
  return (
    `Индекс ${score} из 100 — выше, чем у ${score}${NBSP}% подходящих мест ` +
    `(${formatInt(rank)}-е место из ${formatInt(result.candidates)})`
  );
}

/**
 * «Places with similar demand» are the cell's decile of demand by the methodology's default weights,
 * so the verdict does not change with the user's settings (see saturation in score.ts). The thresholds
 * of the verdict come from the methodology too.
 */
function competitionOf(ix: LocationIndex, result: ScoreResult, cell: number): CellExplanation['competition'] {
  const { competition } = result;
  const criterion = ix.criteria.find((c) => c.model === 'saturation');
  if (!competition || criterion?.model !== 'saturation') return null;
  const { saturatedRatio, nicheRatio } = criterion.saturation;
  const ratio = competition.ratio[cell]!;
  const verdict: CompetitionVerdict = ratio >= saturatedRatio ? 'saturated' : ratio <= nicheRatio ? 'niche' : 'usual';
  const expected = competition.expected[competition.decile[cell]!] ?? 0;
  return { verdict, text: `Для мест с похожим спросом обычно ≈${NBSP}${approximately(expected)} — ${VERDICT_TEXT[verdict]}` };
}

/** The usual competition may be any fraction (other cafes count partly): 2 → «2», 3.5 → «3–4», 0.3 → «0–1». */
function approximately(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  const low = Math.floor(rounded);
  const high = Math.ceil(rounded);
  return low === high ? String(low) : `${low}–${high}`;
}

/**
 * The fact sentence of a criterion; `none` when there is no object to speak of, and for a nearest object
 * without a name (near = −2) the `unnamed` sentence with its distance.
 */
function factText(ix: LocationIndex, criterion: LocationCriterion, cell: number): string {
  const { fact } = criterion;
  const columns = ix.cells.fact[criterion.id];
  const n = columns?.n?.[cell] ?? 0;
  const m = columns?.m?.[cell] ?? 0;
  switch (fact.type) {
    case 'nearest': {
      const near = columns?.near?.[cell] ?? -1;
      const values: Record<string, string> = { max: formatRadius(fact.max), n: formatInt(n) };
      if (fact.radius !== undefined) values.radius = formatRadius(fact.radius);
      if (near === -1) return render(fact.none, values);
      const dist = formatDistance(columns?.dist?.[cell] ?? 0);
      const place = ix.places[near];
      return place ? render(fact.text, { ...values, name: place[1], dist }) : render(fact.unnamed, { ...values, dist });
    }
    case 'count':
    case 'competitors': {
      const empty = fact.type === 'count' ? n === 0 : n + m === 0;
      const values = { n: formatInt(n), m: formatInt(m), radius: formatRadius(fact.radius) };
      return render(empty && fact.none !== undefined ? fact.none : fact.text, values);
    }
    case 'share': {
      const pct = ix.cells.level[criterion.id]?.[cell] ?? 0;
      return render(pct === 0 && fact.none !== undefined ? fact.none : fact.text, { pct: String(pct) });
    }
  }
}

function coordinatesOf(ix: LocationIndex, cell: number): string {
  const { lat, lon } = cellCenter(ix.grid, ix.cells.row[cell]!, ix.cells.col[cell]!);
  const degrees = (value: number) => `${Math.abs(value).toFixed(3).replace('.', ',')}°`;
  return `${degrees(lat)}${NBSP}${lat < 0 ? 'ю' : 'с'}.${NBSP}ш., ${degrees(lon)}${NBSP}${lon < 0 ? 'з' : 'в'}.${NBSP}д.`;
}

/** A number and its unit (%, м, км) typed with a plain space; «5 минут» is not a unit. */
const NUMBER_AND_UNIT = /(\d) (%|км|м)(?!\p{L})/gu;

/**
 * Fills {placeholders} (parse checks that templates use only the ones their fact provides) and keeps
 * numbers with their units on one line (doc-3 §3.8), so config authors can type plain spaces in YAML.
 * A value inside «…» of the template has its own quotes nested as „…“: «Станция метро „Горки“».
 */
function render(template: string, values: Readonly<Record<string, string>>): string {
  return template
    .replace(/\{([^{}]*)\}/g, (match, key: string, offset: number) => {
      if (!Object.hasOwn(values, key)) return match;
      return insideQuotes(template, offset) ? nestQuotes(values[key]!) : values[key]!;
    })
    .replace(NUMBER_AND_UNIT, `$1${NBSP}$2`);
}

/** Whether a position of a template lies inside «…»: more « than » before it. */
function insideQuotes(template: string, offset: number): boolean {
  let depth = 0;
  for (const char of template.slice(0, offset)) {
    if (char === '«') depth++;
    else if (char === '»') depth--;
  }
  return depth > 0;
}

/**
 * Quotes inside quotes, as Russian typography nests them: «…» and "…" of a name (104 stops of Kazan have them, like
 * «Станция метро «Горки»») become „…“; straight quotes open and close in turn.
 */
function nestQuotes(value: string): string {
  let open = true;
  return value.replace(/[«»"]/g, (quote) => {
    if (quote !== '"') return quote === '«' ? '„' : '“';
    open = !open;
    return open ? '“' : '„';
  });
}
