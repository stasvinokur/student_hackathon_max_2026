import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';

/** Review accounts from DATA-API.yaml: the jury's checks must not move the pilot metrics. */
export const REVIEW_USER_IDS = [1000001, 1000002] as const;

// Numeric constants only, so they are safe to inline into the query.
const REVIEW = sql.raw(REVIEW_USER_IDS.join(', '));

/** Pilot KPIs from doc-1, computed from the events and route tables (review accounts excluded). */
export interface Kpi {
  /** Users who wrote to the bot (the `users` row is created on the first contact); `onboarded` is part of them. */
  started: number;
  /** Users who answered all onboarding questions. */
  onboarded: number;
  /** onboarded / started — target ≥ 70%. */
  activationRate: number | null;
  /** Median seconds from the first contact to the first built route — target < 120 s. */
  medianTimeToRouteSeconds: number | null;
  /** Users with a route. */
  withRoute: number;
  /** North Star: routes with ≥ 3 tasks closed within 7 days of building — target ≥ 50%. */
  threeTasksIn7DaysRate: number | null;
  /** Share of users with a route who opened an official source — target ≥ 35%. */
  sourceOpenRate: number | null;
  /** Of users who got a reminder, share who then opened the mini-app via its deep link — target ≥ 40%. */
  reminderReturnRate: number | null;
  /** Users who shared their status card: through the MAX share sheet or by copying the text (web client). */
  sharers: number;
}

const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);

export async function computeKpi(database: Database): Promise<Kpi> {
  const [row] = await database.db.execute<{
    started: number;
    onboarded: number;
    median_ttr: number | null;
    with_route: number;
    three_in_7: number;
    source_openers: number;
    reminded: number;
    returned: number;
    sharers: number;
  }>(sql`
    with
      -- The bot creates a users row on the first contact of any kind, so it is the start of the funnel.
      started as (select max_user_id as user_id, created_at as at from users where max_user_id not in (${REVIEW})),
      pilot_events as (select * from events where user_id is not null and user_id not in (${REVIEW})),
      pilot_routes as (select * from routes where user_id not in (${REVIEW})),
      built as (select user_id, min(created_at) as at from pilot_events where type = 'route_built' group by user_id),
      reminded as (select user_id, min(created_at) as at from pilot_events where type = 'reminder_sent' group by user_id)
    select
      (select count(*)::int from started) as started,
      (select count(distinct e.user_id)::int from pilot_events e join started s using (user_id) where e.type = 'onboarding_completed') as onboarded,
      (select percentile_cont(0.5) within group (order by extract(epoch from b.at - s.at))
         from started s join built b using (user_id) where b.at >= s.at)::float as median_ttr,
      (select count(*)::int from pilot_routes) as with_route,
      (select count(*)::int from pilot_routes r
         where (select count(*) from route_tasks t
                where t.route_id = r.id and t.status = 'done' and t.done_at <= r.created_at + interval '7 days') >= 3) as three_in_7,
      (select count(distinct e.user_id)::int from pilot_events e join pilot_routes r on r.user_id = e.user_id where e.type = 'source_opened') as source_openers,
      (select count(*)::int from reminded) as reminded,
      (select count(distinct e.user_id)::int from pilot_events e join reminded m on m.user_id = e.user_id
         where e.type = 'miniapp_opened' and (e.props ->> 'deepLink')::boolean and e.created_at >= m.at) as returned,
      (select count(distinct user_id)::int from pilot_events
         where type = 'share_clicked' and ((props ->> 'shared')::boolean or props ->> 'result' = 'copied')) as sharers
  `);

  const r = row!;
  return {
    started: r.started,
    onboarded: r.onboarded,
    activationRate: rate(r.onboarded, r.started),
    medianTimeToRouteSeconds: r.median_ttr === null ? null : Math.round(r.median_ttr),
    withRoute: r.with_route,
    threeTasksIn7DaysRate: rate(r.three_in_7, r.with_route),
    sourceOpenRate: rate(r.source_openers, r.with_route),
    reminderReturnRate: rate(r.returned, r.reminded),
    sharers: r.sharers,
  };
}
