import { rescheduleOfferReply } from '../bot/opening.js';
import { RESTART_PAYLOAD, ROUTE_FIRST_STEP_PAYLOAD } from '../bot/payloads.js';
import { openRouteButton, restartButton, type ButtonSpec, type ReplySpec } from '../bot/reply.js';
import { startPhrase } from '../bot/step-reply.js';
import type { Profile } from '../profile.js';
import { addDays, diffDays, formatDate, isIsoDate } from '../rules/dates.js';
import { lateOpeningText } from '../rules/opening.js';
import { plural } from '../rules/plural.js';
import { inBox } from '../rules/region.js';
import { topBlockers, type BuildRouteResult, type Route } from '../rules/route.js';
import type { PackManifest } from '../rules/schema.js';

// ---------- public types ----------

export const ONBOARDING_STEPS = ['format', 'city', 'legal_status', 'premises', 'employees', 'opening_date', 'sells_food'] as const;
export type QuestionStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStep = QuestionStep | 'done';

export interface OnboardingState {
  step: OnboardingStep;
  answers: Partial<Profile>;
}

export type OnboardingInput =
  | { type: 'start' }
  | { type: 'restart' }
  | { type: 'callback'; payload: string }
  | { type: 'text'; text: string }
  | { type: 'location'; latitude: number; longitude: number };

export type Region = PackManifest['region'];

export interface OnboardingContext {
  /** Today's date (YYYY-MM-DD), supplied by the shell. */
  today: string;
  /** Regions that have a rules pack. */
  regions: Region[];
  /** Builds the route for a finished profile (buildRoute bound to the right pack). */
  buildRoute: (profile: Profile) => BuildRouteResult;
}

export interface OnboardingResult {
  state: OnboardingState;
  replies: ReplySpec[];
  /** Set once, when the last answer produced a route: the shell persists the profile and the route. */
  completedProfile?: Profile;
}

const MAX_DAYS_AHEAD = 730;

// ---------- questions ----------

interface Option {
  value: string;
  label: string;
  /** Extra words accepted as a typed answer. */
  aliases?: string[];
}

type ChoiceStep = Exclude<QuestionStep, 'city' | 'opening_date'>;

const CHOICES: Record<ChoiceStep, { question: string; options: Option[] }> = {
  format: {
    question: 'Что открываете?',
    options: [
      { value: 'to_go', label: 'Coffee-to-go без посадки', aliases: ['to go', 'coffee to go', 'кофе с собой', 'с собой', 'без посадки'] },
      { value: 'cafe', label: 'Кофейню с посадкой', aliases: ['кофейня', 'кафе', 'с посадкой'] },
    ],
  },
  legal_status: {
    question: 'Бизнес уже зарегистрирован?',
    options: [
      { value: 'none', label: 'Ещё нет', aliases: ['нет', 'не зарегистрирован'] },
      { value: 'ip', label: 'ИП', aliases: ['индивидуальный предприниматель'] },
      { value: 'ooo', label: 'ООО', aliases: ['ooo', 'юрлицо'] },
    ],
  },
  premises: {
    question: 'Помещение уже есть?',
    options: [
      { value: 'searching', label: 'Ещё ищу', aliases: ['нет', 'ищу'] },
      { value: 'signed', label: 'Договор подписан', aliases: ['да', 'есть'] },
    ],
  },
  employees: {
    question: 'Сколько сотрудников планируете нанять? Можно написать число.',
    options: [
      { value: '0', label: 'Работаю один', aliases: ['один', 'одна', 'никого', 'сам', 'сама'] },
      { value: '3', label: '1–3' },
      { value: '10', label: '4–10' },
      { value: '11', label: 'Больше 10' },
    ],
  },
  sells_food: {
    question: 'Будете продавать готовую еду?',
    options: [
      { value: 'false', label: 'Только напитки', aliases: ['нет', 'напитки'] },
      { value: 'true', label: 'Напитки и еду (выпечка, сэндвичи)', aliases: ['да', 'еду', 'напитки и еду'] },
    ],
  },
};

const INTRO =
  'Привет! Я «Открывай» — помогу открыть кофейню без сюрпризов.\n' +
  `Задам ${ONBOARDING_STEPS.length} коротких вопросов (около 2 минут), а потом покажу персональный маршрут открытия ` +
  'и три действия, которые могут сорвать дату открытия.';

function questionFor(step: QuestionStep, ctx: OnboardingContext): ReplySpec {
  const number = `Вопрос ${ONBOARDING_STEPS.indexOf(step) + 1} из ${ONBOARDING_STEPS.length}. `;

  if (step === 'city') {
    return {
      text: `${number}В каком городе открываетесь? Поделитесь геолокацией или напишите название.`,
      buttons: [
        [{ kind: 'request_geo', text: '📍 Отправить геолокацию' }],
        ctx.regions.map((r) => ({ kind: 'callback', text: r.name, payload: `ob:city:${r.code}` }) as ButtonSpec),
      ],
    };
  }

  if (step === 'opening_date') {
    return {
      text: `${number}Когда планируете открыться? Напишите дату, например ${formatDate(addDays(ctx.today, 45), true)}, или выберите:`,
      buttons: [
        [
          { kind: 'callback', text: 'Через месяц', payload: 'ob:opening_date:+30' },
          { kind: 'callback', text: 'Через 2 месяца', payload: 'ob:opening_date:+60' },
          { kind: 'callback', text: 'Через 3 месяца', payload: 'ob:opening_date:+90' },
        ],
      ],
    };
  }

  const { question, options } = CHOICES[step];
  return {
    text: `${number}${question}`,
    buttons: options.map((o) => [{ kind: 'callback', text: o.label, payload: `ob:${step}:${o.value}` }]),
  };
}

// ---------- transition ----------

export function initialOnboardingState(): OnboardingState {
  return { step: 'format', answers: {} };
}

/**
 * Pure onboarding state machine: (state, input) → (next state, replies).
 * Invalid input never loses collected answers — the current question is asked again.
 */
export function transition(state: OnboardingState | null, input: OnboardingInput, ctx: OnboardingContext): OnboardingResult {
  if (input.type === 'restart' || (input.type === 'callback' && input.payload === RESTART_PAYLOAD)) {
    return ask(initialOnboardingState(), ctx, 'Начинаем заново.');
  }

  if (state === null) {
    return ask(initialOnboardingState(), ctx, INTRO);
  }

  if (state.step === 'done') {
    return { state, replies: [doneReply()] };
  }

  if (input.type === 'start') {
    return ask(state, ctx, 'Продолжим с того места, где остановились.');
  }

  const answer = readAnswer(state.step, input, ctx);
  if (!answer.ok) {
    return ask(state, ctx, answer.hint);
  }

  const answers = { ...state.answers, ...answer.patch };
  const nextStep = ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(state.step) + 1];
  if (nextStep) {
    return ask({ step: nextStep, answers }, ctx);
  }
  return finish(answers as Profile, ctx);
}

function ask(state: OnboardingState, ctx: OnboardingContext, prefix?: string): OnboardingResult {
  const question = questionFor(state.step as QuestionStep, ctx);
  return { state, replies: [{ ...question, text: prefix ? `${prefix}\n\n${question.text}` : question.text }] };
}

type Answer = { ok: true; patch: Partial<Profile> } | { ok: false; hint: string };

function readAnswer(step: QuestionStep, input: OnboardingInput, ctx: OnboardingContext): Answer {
  const payload = input.type === 'callback' ? parsePayload(input.payload) : null;
  if (input.type === 'callback' && payload?.step !== step) {
    return { ok: false, hint: 'Эта кнопка относится к другому вопросу. Ответьте, пожалуйста, на текущий:' };
  }
  const value = payload?.value;
  const text = input.type === 'text' ? input.text : undefined;

  switch (step) {
    case 'city':
      return readCity(input, value, ctx);
    case 'opening_date':
      return readOpeningDate(value, text, ctx.today);
    case 'employees': {
      const typed = text !== undefined ? parseCount(text) : null;
      if (typed !== null) return { ok: true, patch: { employees: typed } };
      break;
    }
  }

  const option = matchOption(CHOICES[step as ChoiceStep].options, value, text);
  if (!option) return { ok: false, hint: 'Не понял ответ — выберите, пожалуйста, вариант кнопкой.' };

  switch (step) {
    case 'format':
      return { ok: true, patch: { format: option.value as Profile['format'] } };
    case 'legal_status':
      return { ok: true, patch: { legal_status: option.value as Profile['legal_status'] } };
    case 'premises':
      return { ok: true, patch: { premises: option.value as Profile['premises'] } };
    case 'employees':
      return { ok: true, patch: { employees: Number(option.value) } };
    case 'sells_food':
      return { ok: true, patch: { sells_food: option.value === 'true' } };
  }
}

function readCity(input: OnboardingInput, payloadValue: string | undefined, ctx: OnboardingContext): Answer {
  const supported = ctx.regions.map((r) => r.name).join(', ');
  const unsupported = `Пока маршрут есть только для: ${supported}. Другие города добавим позже.\nЕсли вы открываетесь в одном из них — выберите его кнопкой.`;

  let region: Region | undefined;
  if (payloadValue !== undefined) {
    region = ctx.regions.find((r) => r.code === payloadValue);
  } else if (input.type === 'location') {
    region = ctx.regions.find((r) => r.bbox && inBox(r.bbox, input.latitude, input.longitude));
  } else if (input.type === 'text') {
    const typed = normalize(input.text).replace(/^(г|город)\s+/, '');
    region = ctx.regions.find((r) => [r.name, r.code, ...r.aliases].some((n) => normalize(n) === typed));
  }
  return region ? { ok: true, patch: { city: region.code } } : { ok: false, hint: unsupported };
}

function readOpeningDate(payloadValue: string | undefined, text: string | undefined, today: string): Answer {
  let date: string | null = null;
  if (payloadValue?.startsWith('+')) {
    const days = Number(payloadValue.slice(1));
    if (Number.isInteger(days)) date = addDays(today, days);
  } else if (text !== undefined) {
    date = parseDate(text);
  }

  if (date === null) {
    return { ok: false, hint: 'Не удалось распознать дату. Напишите её в формате ДД.ММ.ГГГГ, например 15.12.2026.' };
  }
  const ahead = diffDays(today, date);
  if (ahead <= 0) return { ok: false, hint: 'Эта дата уже наступила. Укажите, пожалуйста, будущую дату открытия.' };
  if (ahead > MAX_DAYS_AHEAD) return { ok: false, hint: 'Дата слишком далеко — укажите открытие в ближайшие 2 года.' };
  return { ok: true, patch: { opening_date: date } };
}

function finish(profile: Profile, ctx: OnboardingContext): OnboardingResult {
  const state: OnboardingState = { step: 'done', answers: profile };
  const result = ctx.buildRoute(profile);

  if (result.status === 'needs_clarification') {
    return {
      state,
      replies: [
        {
          text: `${result.message}\nМы не даём советов без проверенного основания. Можно пройти вопросы заново.`,
          buttons: [[restartButton()]],
        },
      ],
    };
  }

  // A date that cannot be met: the offer to move it comes as a message of its own (see rescheduleOfferReply).
  const offer = rescheduleOfferReply(result.route);
  return { state, replies: [summaryReply(result.route), ...(offer ? [offer] : [])], completedProfile: profile };
}

function summaryReply(route: Route): ReplySpec {
  const blockers = topBlockers(route);
  const total = route.steps.length;
  const lines = [
    `До открытия ${route.daysToOpening} ${plural(route.daysToOpening, 'день', 'дня', 'дней')}. ` +
      `Найдено ${total} ${plural(total, 'действие', 'действия', 'действий')}.`,
  ];
  const late = lateOpeningText(route);
  if (late !== null) lines.push(`${late}.`);

  if (blockers.length === 0) {
    lines.push('Критичных блокеров не осталось — откройте маршрут, чтобы пройти остальное.');
  } else {
    lines.push(`${blockers.length === 3 ? 'Три действия могут' : 'Эти действия могут'} сорвать запуск:`);
    blockers.forEach((step, i) => lines.push(`${i + 1}. ${step.action.title} — ${startPhrase(step, route.today)}`));
    lines.push('', 'Начнём с первого?');
  }

  return {
    text: lines.join('\n'),
    buttons: [
      [openRouteButton()],
      ...(blockers.length > 0 ? [[{ kind: 'callback', text: 'Начать с №1', payload: ROUTE_FIRST_STEP_PAYLOAD } as ButtonSpec]] : []),
    ],
  };
}

function doneReply(): ReplySpec {
  return {
    text: 'Ваш маршрут готов. Откройте его, чтобы продолжить, или пройдите вопросы заново.',
    buttons: [[openRouteButton()], [restartButton()]],
  };
}

// ---------- helpers ----------

function parsePayload(payload: string): { step: string; value: string } | null {
  const match = /^ob:([a-z_]+):(.+)$/.exec(payload);
  return match ? { step: match[1]!, value: match[2]! } : null;
}

function matchOption(options: Option[], value: string | undefined, text: string | undefined): Option | undefined {
  if (value !== undefined) return options.find((o) => o.value === value);
  if (text === undefined) return undefined;
  const typed = normalize(text);
  return options.find((o) => [o.label, ...(o.aliases ?? [])].some((candidate) => normalize(candidate) === typed));
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}\s–-]/gu, ' ')
    .replace(/[-–]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** Accepts DD.MM.YYYY (also with / or -) and YYYY-MM-DD. */
export function parseDate(text: string): string | null {
  const trimmed = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const ru = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(trimmed);
  const date = iso ? trimmed : ru ? `${ru[3]}-${ru[2]!.padStart(2, '0')}-${ru[1]!.padStart(2, '0')}` : null;
  return date !== null && isIsoDate(date) ? date : null;
}

