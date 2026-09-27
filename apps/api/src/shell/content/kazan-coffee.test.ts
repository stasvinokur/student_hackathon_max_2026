import { addDays, buildRoute, nextBestStep, topBlockers, type Profile, type RulesPack } from '@otkryvay/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadPackFixtures, loadRulesPack } from './load.js';

const FixtureSchema = z.object({
  id: z.string(),
  description: z.string(),
  today: z.string(),
  profile: z.custom<Profile>(),
  expect: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('ok'),
      days_to_opening: z.number(),
      projected_opening: z.string().nullable(),
      actions: z.array(z.string()),
      blockers: z.array(z.string()),
      next_step: z.string().nullable(),
      overdue: z.array(z.string()),
    }),
    z.object({ status: z.literal('needs_clarification'), reason: z.string() }),
  ]),
});
const FixturesFileSchema = z.object({ pack: z.string(), pack_version: z.string(), fixtures: z.array(FixtureSchema).min(1) });

let pack: RulesPack;
let fixtures: z.infer<typeof FixturesFileSchema>;

beforeAll(async () => {
  pack = await loadRulesPack('kazan-coffee');
  fixtures = FixturesFileSchema.parse(await loadPackFixtures('kazan-coffee'));
});

describe('content pack kazan-coffee', () => {
  it('passes validation and has 15–25 cards in all three lanes', () => {
    expect(pack.actions.length).toBeGreaterThanOrEqual(15);
    expect(pack.actions.length).toBeLessThanOrEqual(25);
    expect(new Set(pack.actions.map((a) => a.lane))).toEqual(new Set(['critical', 'ops', 'support']));
  });

  it('gives every card why / do now / what to prepare / done when', () => {
    for (const action of pack.actions) {
      expect.soft(action.why.trim(), action.id).not.toBe('');
      expect.soft(action.do_now.trim(), action.id).not.toBe('');
      expect.soft(action.prepare.length, `${action.id}.prepare`).toBeGreaterThan(0);
      expect.soft(action.done_when.trim(), action.id).not.toBe('');
    }
  });

  it('backs every critical card with an official source and a check date', () => {
    for (const action of pack.actions.filter((a) => a.lane === 'critical')) {
      expect.soft(action.source?.url, action.id).toMatch(/^https:\/\//);
      expect.soft(action.source?.checked_at, action.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('marks cards not verified manually as test_data (no official_fact before legal review)', () => {
    expect(pack.actions.filter((a) => a.kind === 'official_fact')).toEqual([]);
    expect(pack.actions.every((a) => a.kind === 'test_data' || a.kind === 'recommendation')).toBe(true);
  });

  it('uses every onboarding answer in applies_if', () => {
    const fields = new Set(JSON.stringify(pack.actions.map((a) => a.applies_if ?? null)).match(/"field":"(\w+)"/g));
    for (const field of ['format', 'legal_status', 'premises', 'employees', 'sells_food']) {
      expect(fields, field).toContain(`"field":"${field}"`);
    }
  });

  it('points steps to 6 city places, each an official address with a source and a check date', () => {
    const stepsAt = (place: string) => pack.actions.filter((a) => a.places.includes(place)).map((a) => a.id);
    // Coordinates are not an official fact: each place names the OpenStreetMap object they were taken from.
    expect(pack.places.map((p) => [p.id, p.osm, stepsAt(p.id)])).toEqual([
      ['my-business-kazan', 'node/9806747773', ['support-consultation']],
      ['ifns-18-kazan', 'way/92939129', ['register-business']],
      ['rospotrebnadzor-rt', 'node/12996321895', ['rpn-notification']],
      ['cgie-rt', 'node/11953431694', ['production-control', 'medical-books']],
      ['uag-kazan', 'way/405269942', ['kazan-signage']],
      ['tko-operator-kazan', 'node/12983549378', ['tko-contract']],
    ]);
    for (const place of pack.places) {
      expect.soft(place.address, place.id).toMatch(/^Казань, /);
      expect.soft(place.source.url, place.id).toMatch(/^https:\/\//);
      expect.soft(place.source.checked_at, place.id).toBe('2026-09-23');
      // The user reads the note as is: no coordinates provenance and no OSM references in it.
      expect.soft(place.note ?? '', place.id).not.toMatch(/Координаты|OpenStreetMap|node|way|relation/);
    }
  });

  it('labels every place on the map by a short name: the full official name would take three or four lines', () => {
    expect(pack.places.map((p) => [p.id, p.short_name])).toEqual([
      ['my-business-kazan', 'Центр «Мой бизнес»'],
      ['ifns-18-kazan', 'ИФНС № 18'],
      ['rospotrebnadzor-rt', 'Роспотребнадзор'],
      ['cgie-rt', 'Центр гигиены'],
      ['uag-kazan', 'Управление архитектуры'],
      ['tko-operator-kazan', 'Региональный оператор ТКО'],
    ]);
  });

  it('sends to the lab for tests, and for medical books to licensed medical organizations as well', () => {
    const lab = pack.places.find((p) => p.id === 'cgie-rt')!;
    expect(lab.note).toContain('другие аккредитованные лаборатории и медицинские организации с лицензией');
  });

  it('sends Kazan to the regional waste operator of the Western zone, ООО «УК «ПЖКХ»', () => {
    const tko = pack.actions.find((a) => a.id === 'tko-contract')!;
    expect(tko.do_now).toContain('ООО «УК «ПЖКХ»');
    expect(tko.do_now).not.toContain('Гринта'); // the operator of the Eastern zone
  });

  it('fixtures belong to the current pack version', () => {
    expect(fixtures.pack).toBe(pack.manifest.id);
    expect(fixtures.pack_version).toBe(pack.manifest.version);
  });
});

describe('route engine on kazan-coffee fixtures', () => {
  it('has fixtures for every profile kind and boundary date', () => {
    expect(fixtures.fixtures.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        'newbie-to-go',
        'newbie-in-a-month',
        'ip-cafe-food-staff',
        'ooo-to-go-food-team',
        'opening-today',
        'opening-in-past',
        'unsupported-city',
      ]),
    );
    // Every fixture is checked below by its index.
    expect(fixtures.fixtures).toHaveLength(7);
  });

  it.each([0, 1, 2, 3, 4, 5, 6])('fixture #%i matches the expected route', (index) => {
    const fixture = fixtures.fixtures[index]!;
    const result = buildRoute(pack, fixture.profile, fixture.today);

    if (fixture.expect.status === 'needs_clarification') {
      expect(result).toMatchObject({ status: 'needs_clarification', reason: fixture.expect.reason });
      return;
    }
    if (result.status !== 'ok') throw new Error(`${fixture.id}: expected a route, got ${result.reason}`);

    const { route } = result;
    expect(route.daysToOpening).toBe(fixture.expect.days_to_opening);
    expect(route.projectedOpeningDate).toBe(fixture.expect.projected_opening);
    expect(route.steps.map((s) => s.action.id).sort()).toEqual(fixture.expect.actions);
    expect(topBlockers(route).map((s) => s.action.id)).toEqual(fixture.expect.blockers);
    expect(nextBestStep(route)?.action.id ?? null).toBe(fixture.expect.next_step);
    expect(route.steps.filter((s) => s.overdue).map((s) => s.action.id).sort()).toEqual(fixture.expect.overdue);

    // Structural invariants: prerequisites always come first.
    const position = new Map(route.steps.map((s, i) => [s.action.id, i]));
    for (const step of route.steps) {
      for (const dep of step.dependsOn) expect(position.get(dep)!).toBeLessThan(position.get(step.action.id)!);
    }
    // No step to do is dated in the past: when the opening date cannot be met, dates count from the projected one.
    for (const step of route.steps.filter((s) => s.status === 'todo')) {
      expect.soft(step.latestStart >= route.today, `${step.action.id} starts ${step.latestStart}`).toBe(true);
    }
    // The projected date is the earliest reachable one: a route built for it meets it, one built for the day before
    // does not and projects the same date again.
    if (route.projectedOpeningDate) {
      const at = (opening: string) => buildRoute(pack, { ...fixture.profile, opening_date: opening }, fixture.today);
      expect(at(route.projectedOpeningDate)).toMatchObject({ status: 'ok', route: { projectedOpeningDate: null } });
      expect(at(addDays(route.projectedOpeningDate, -1))).toMatchObject({ status: 'ok', route: { projectedOpeningDate: route.projectedOpeningDate } });
    }
  });
});
