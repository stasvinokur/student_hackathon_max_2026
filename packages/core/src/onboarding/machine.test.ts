import { describe, expect, it } from 'vitest';
import { keepOpeningReplies, rescheduleReplies } from '../bot/opening.js';
import { ROUTE_FIRST_STEP_PAYLOAD } from '../bot/payloads.js';
import type { ReplySpec } from '../bot/reply.js';
import { stepReply } from '../bot/step-reply.js';
import type { Profile } from '../profile.js';
import { reminderReply } from '../reminders/plan.js';
import { buildRoute } from '../rules/route.js';
import { RulesPackSchema } from '../rules/schema.js';
import {
  parseDate,
  transition,
  type OnboardingContext,
  type OnboardingInput,
  type OnboardingResult,
  type OnboardingState,
} from './machine.js';

const TODAY = '2026-09-18';
const source = { url: 'https://www.nalog.gov.ru/', title: 'ФНС', checked_at: '2026-09-18' };
const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Шаг ${id}`, lane: 'critical', duration_days: 5, why: 'w', do_now: 'd', done_when: 'x', source, kind: 'test_data', ...extra,
});

const pack = RulesPackSchema.parse({
  manifest: {
    id: 'demo', version: '1.0.0', title: 'Кофейня, Казань', industry: 'coffee', checked_at: TODAY, cities: ['kazan'],
    region: { code: 'kazan', name: 'Казань', aliases: ['Kazan'], bbox: { south: 55.6, west: 48.8, north: 55.95, east: 49.4 } },
  },
  actions: [
    card('register', { title: 'Зарегистрировать ИП', applies_if: { field: 'legal_status', eq: 'none' } }),
    card('kkt', { title: 'Зарегистрировать кассу', depends_on: ['register'] }),
    card('lease', { title: 'Подписать аренду', duration_days: 20 }),
    card('hire', { title: 'Нанять бариста', lane: 'ops', applies_if: { field: 'employees', gt: 0 } }),
    card('seating', { title: 'Мебель для зала', lane: 'support', kind: 'recommendation', source: undefined, applies_if: { field: 'format', eq: 'cafe' } }),
  ],
});

const ctx: OnboardingContext = {
  today: TODAY,
  regions: [pack.manifest.region],
  buildRoute: (profile) => buildRoute(pack, profile, TODAY),
};

const cb = (payload: string): OnboardingInput => ({ type: 'callback', payload });
const text = (t: string): OnboardingInput => ({ type: 'text', text: t });

function run(inputs: OnboardingInput[], from: OnboardingState | null = null): OnboardingResult {
  let result = transition(from, inputs[0]!, ctx);
  for (const input of inputs.slice(1)) result = transition(result.state, input, ctx);
  return result;
}

const lastText = (r: OnboardingResult) => r.replies.at(-1)!.text;
const buttons = (reply: ReplySpec) => reply.buttons.flat();

const HAPPY_PATH: OnboardingInput[] = [
  { type: 'start' },
  cb('ob:format:to_go'),
  cb('ob:city:kazan'),
  cb('ob:legal_status:none'),
  cb('ob:premises:searching'),
  cb('ob:employees:3'),
  text('20.11.2026'),
  cb('ob:sells_food:false'),
];

describe('onboarding transition', () => {
  it('starts with the intro and the first question', () => {
    const r = transition(null, { type: 'start' }, ctx);
    expect(r.state).toEqual({ step: 'format', answers: {} });
    expect(lastText(r)).toContain('Привет');
    expect(lastText(r)).toContain('Вопрос 1 из 7');
    expect(buttons(r.replies[0]!).map((b) => b.kind === 'callback' && b.payload)).toEqual(['ob:format:to_go', 'ob:format:cafe']);
  });

  it('walks through every step to a profile and a summary', () => {
    const r = run(HAPPY_PATH);
    expect(r.state.step).toBe('done');
    expect(r.completedProfile).toEqual({
      format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 3, opening_date: '2026-11-20', sells_food: false,
    });

    // The date can be met: the summary alone, with no warning and no offer to move the date.
    expect(r.replies).toHaveLength(1);
    const summary = r.replies[0]!;
    expect(summary.text).toContain('До открытия 63 дня. Найдено 4 действия.');
    expect(summary.text).not.toContain('не успеть');
    expect(summary.text).toContain('Три действия могут сорвать запуск:');
    expect(summary.text).toMatch(/1\. Подписать аренду — начать до 31\.10/);
    expect(summary.text).toContain('Начнём с первого?');
    expect(buttons(summary)).toEqual([
      { kind: 'open_app', text: 'Открыть маршрут' },
      { kind: 'callback', text: 'Начать с №1', payload: ROUTE_FIRST_STEP_PAYLOAD },
    ]);
  });

  it('warns about a date that cannot be met and offers the reachable one in a message of its own', () => {
    // Opening in 13 days: the lease alone takes 20, so the earliest opening is 20 days from today, 2026-10-08.
    const r = run([...HAPPY_PATH.slice(0, 6), text('01.10.2026'), cb('ob:sells_food:false')]);
    expect(r.completedProfile).toMatchObject({ opening_date: '2026-10-01' });
    expect(r.replies).toHaveLength(2);

    const [summary, offer] = r.replies;
    expect(summary!.text).toBe(
      [
        'До открытия 13 дней. Найдено 4 действия.',
        'К 1 октября не успеть — если начать сегодня, откроетесь 8 октября.',
        'Три действия могут сорвать запуск:',
        '1. Подписать аренду — начать сегодня',
        '2. Зарегистрировать ИП — начать до 28.09',
        '3. Зарегистрировать кассу — начать до 03.10',
        '',
        'Начнём с первого?',
      ].join('\n'),
    );
    expect(buttons(summary!)).toEqual([
      { kind: 'open_app', text: 'Открыть маршрут' },
      { kind: 'callback', text: 'Начать с №1', payload: ROUTE_FIRST_STEP_PAYLOAD },
    ]);

    // Pressing a button clears every callback button of its message: the choice gets a message apart from «Начать с №1».
    expect(offer).toEqual({
      text: 'Перенести дату открытия на 8 октября? Отметки выполненных шагов сохранятся.',
      buttons: [
        [{ kind: 'callback', text: 'Перенести на 8 октября', payload: 'route:reschedule:2026-10-01:2026-10-08' }],
        [{ kind: 'callback', text: 'Оставить 1 октября', payload: 'route:keep:2026-10-01' }],
      ],
    });
  });

  it('adds the year to blocker dates that fall into the next year', () => {
    const r = run([...HAPPY_PATH.slice(0, 6), text('20.03.2027'), cb('ob:sells_food:false')]);
    expect(r.replies[0]!.text).toMatch(/1\. Подписать аренду — начать до 28\.02\.2027/);
  });

  it('asks each question in order with a progress counter', () => {
    const questions = HAPPY_PATH.slice(0, -1).map((_, i) => lastText(run(HAPPY_PATH.slice(0, i + 1))));
    expect(questions.map((q) => /Вопрос (\d) из 7/.exec(q)?.[1])).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('accepts typed answers that match button labels or aliases', () => {
    const r = run([{ type: 'start' }, text('кофейня'), text('г. Казань'), text('ип'), text('Договор подписан'), text('0'), text('2026-12-01'), text('да')]);
    expect(r.completedProfile).toMatchObject({ format: 'cafe', city: 'kazan', legal_status: 'ip', premises: 'signed', employees: 0, sells_food: true });
  });

  it('recognises the city from a geolocation inside the region', () => {
    const r = run([{ type: 'start' }, cb('ob:format:cafe'), { type: 'location', latitude: 55.79, longitude: 49.12 }]);
    expect(r.state).toMatchObject({ step: 'legal_status', answers: { city: 'kazan' } });
  });

  it('calls the product a route wherever the bot speaks: «Карта» is the tab of places in the mini-app', () => {
    // A pack without critical steps: the summary says there are no blockers left.
    const calmPack = RulesPackSchema.parse({ ...pack, actions: [card('hire', { title: 'Нанять бариста', lane: 'ops' })] });
    const calm: OnboardingContext = { ...ctx, buildRoute: (profile) => buildRoute(calmPack, profile, TODAY) };
    const replies: ReplySpec[] = [];
    const walk = (inputs: OnboardingInput[], context: OnboardingContext, from: OnboardingState | null = null) => {
      let state = from;
      for (const input of inputs) {
        const r = transition(state, input, context);
        replies.push(...r.replies);
        state = r.state;
      }
      return state;
    };
    const done = walk(HAPPY_PATH, ctx);
    walk([text('привет'), cb('ob:restart')], ctx, done);
    walk([{ type: 'start' }, cb('ob:format:cafe'), text('Москва'), cb('ob:city:kazan'), text('что-то'), cb('ob:legal_status:ip')], ctx);
    walk(HAPPY_PATH, calm);
    // A date that cannot be met: the warning and the offer to move it.
    walk([...HAPPY_PATH.slice(0, 6), text('01.10.2026'), cb('ob:sells_food:false')], ctx);
    const profile: Profile = { format: 'to_go', city: 'kazan', legal_status: 'none', premises: 'searching', employees: 1, sells_food: false, opening_date: '2026-11-20' };
    const route = buildRoute(pack, profile, TODAY);
    if (route.status !== 'ok') throw new Error('route expected');
    replies.push(stepReply(route.route.steps[0]!, TODAY), reminderReply(route.route.steps[0]!, 'next_step', TODAY), reminderReply(route.route.steps[0]!, 'deadline', TODAY));
    const late = buildRoute(pack, { ...profile, opening_date: '2026-10-01' }, TODAY);
    if (late.status !== 'ok') throw new Error('route expected');
    const overdue = late.route.steps.find((step) => step.overdue)!;
    replies.push(stepReply(overdue, TODAY), reminderReply(overdue, 'next_step', TODAY));
    const passed = buildRoute(pack, { ...profile, opening_date: '2026-09-10' }, TODAY);
    if (passed.status !== 'ok') throw new Error('route expected');
    replies.push(
      ...rescheduleReplies({ status: 'moved', requested: '2026-11-20', route: route.route }),
      ...rescheduleReplies({ status: 'moved', requested: '2026-11-15', route: route.route }),
      ...rescheduleReplies({ status: 'unchanged', route: late.route }),
      ...rescheduleReplies({ status: 'stale', route: route.route }),
      ...rescheduleReplies({ status: 'expired', requested: '2026-09-18', route: route.route }),
      ...rescheduleReplies({ status: 'no_route' }),
      ...rescheduleReplies({ status: 'unchanged', route: passed.route }),
      ...keepOpeningReplies({ status: 'kept', route: route.route }),
      ...keepOpeningReplies({ status: 'kept', route: late.route }),
      ...keepOpeningReplies({ status: 'passed', route: passed.route }),
      ...keepOpeningReplies({ status: 'stale', route: route.route }),
      ...keepOpeningReplies({ status: 'no_route' }),
      reminderReply(overdue, 'deadline', TODAY),
    );

    const said = replies.flatMap((reply) => [reply.text, ...buttons(reply).map((button) => button.text)]);
    expect(said.join('\n')).toContain('покажу персональный маршрут открытия');
    expect(said.join('\n')).toContain('Ваш маршрут готов.');
    expect(said.join('\n')).toContain('Критичных блокеров не осталось — откройте маршрут, чтобы пройти остальное.');
    expect(said.join('\n')).toContain('Перенести дату открытия на 8 октября?');
    // Cards («карточка») are fine; any other «карт…» names the wrong thing.
    expect(said.filter((line) => /карт(?!оч)/i.test(line))).toEqual([]);
  });

  it('honestly says an unsupported city is not covered and stays on the question', () => {
    for (const input of [text('Москва'), { type: 'location', latitude: 55.75, longitude: 37.62 } as OnboardingInput]) {
      const r = run([{ type: 'start' }, cb('ob:format:cafe'), input]);
      expect(r.state).toEqual({ step: 'city', answers: { format: 'cafe' } });
      expect(lastText(r)).toContain('Пока маршрут есть только для: Казань');
      expect(lastText(r)).toContain('Вопрос 2 из 7');
    }
  });

  it.each([
    ['31.02.2027', 'Не удалось распознать дату'],
    ['завтра', 'Не удалось распознать дату'],
    ['18.09.2026', 'уже наступила'],
    ['01.01.2020', 'уже наступила'],
    ['01.01.2030', 'слишком далеко'],
  ])('re-asks the date for %s without losing answers', (input, hint) => {
    const before = run(HAPPY_PATH.slice(0, 6));
    const r = transition(before.state, text(input), ctx);
    expect(r.state).toEqual(before.state);
    expect(lastText(r)).toContain(hint);
    expect(lastText(r)).toContain('Вопрос 6 из 7');
  });

  it('computes quick date buttons from today', () => {
    const r = transition(run(HAPPY_PATH.slice(0, 6)).state, cb('ob:opening_date:+30'), ctx);
    expect(r.state.answers.opening_date).toBe('2026-10-18');
  });

  it('re-asks on unexpected text and on buttons from another question', () => {
    const before = run(HAPPY_PATH.slice(0, 3));
    const gibberish = transition(before.state, text('ну не знаю'), ctx);
    expect(gibberish.state).toEqual(before.state);
    expect(lastText(gibberish)).toContain('выберите, пожалуйста, вариант кнопкой');

    const stale = transition(before.state, cb('ob:format:cafe'), ctx);
    expect(stale.state).toEqual(before.state);
    expect(lastText(stale)).toContain('относится к другому вопросу');

    const garbage = transition(before.state, cb('something-else'), ctx);
    expect(garbage.state).toEqual(before.state);
  });

  it('continues from the current question on a repeated start', () => {
    const before = run(HAPPY_PATH.slice(0, 4));
    const r = transition(before.state, { type: 'start' }, ctx);
    expect(r.state).toEqual(before.state);
    expect(lastText(r)).toContain('Продолжим');
  });

  it('resets everything on restart, from the middle or after completion', () => {
    for (const from of [run(HAPPY_PATH.slice(0, 4)).state, run(HAPPY_PATH).state]) {
      const r = transition(from, { type: 'restart' }, ctx);
      expect(r.state).toEqual({ step: 'format', answers: {} });
      expect(lastText(r)).toContain('Начинаем заново');
    }
    expect(transition(run(HAPPY_PATH).state, cb('ob:restart'), ctx).state.step).toBe('format');
  });

  it('after completion answers with the route button instead of re-running', () => {
    const r = transition(run(HAPPY_PATH).state, text('привет'), ctx);
    expect(r.state.step).toBe('done');
    expect(r.completedProfile).toBeUndefined();
    expect(buttons(r.replies[0]!)[0]).toEqual({ kind: 'open_app', text: 'Открыть маршрут' });
  });

  it('explains when the rules cannot build a route', () => {
    const r = run(HAPPY_PATH.slice(0, -1), null);
    const clarify = transition(r.state, cb('ob:sells_food:false'), { ...ctx, buildRoute: () => ({ status: 'needs_clarification', reason: 'no_applicable_actions', message: 'Нужно уточнение.' }) });
    expect(clarify.completedProfile).toBeUndefined();
    expect(clarify.replies[0]!.text).toContain('Нужно уточнение.');
    expect(buttons(clarify.replies[0]!)).toContainEqual({ kind: 'callback', text: 'Пройти заново', payload: 'ob:restart' });
  });
});

describe('helpers', () => {
  it('parses dates', () => {
    expect(parseDate('5.1.2027')).toBe('2027-01-05');
    expect(parseDate('05/01/2027')).toBe('2027-01-05');
    expect(parseDate('2027-01-05')).toBe('2027-01-05');
    expect(parseDate('32.01.2027')).toBeNull();
  });
});
