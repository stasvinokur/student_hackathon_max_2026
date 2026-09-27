// Prints the pilot KPIs:  DATABASE_URL=... pnpm --filter @otkryvay/api kpi
import { computeKpi } from '../shell/analytics/kpi.js';
import { createDatabase } from '../shell/db/client.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const database = createDatabase(databaseUrl);
const kpi = await computeKpi(database);
const pct = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

console.table({
  'Начали диалог с ботом': { value: kpi.started, target: '' },
  'Прошли онбординг': { value: kpi.onboarded, target: '' },
  'Activation (онбординг / старт)': { value: pct(kpi.activationRate), target: '≥ 70%' },
  'Медиана time-to-route': { value: kpi.medianTimeToRouteSeconds === null ? '—' : `${kpi.medianTimeToRouteSeconds} с`, target: '< 120 с' },
  'Пользователей с маршрутом': { value: kpi.withRoute, target: '' },
  'North Star: ≥3 шага за 7 дней': { value: pct(kpi.threeTasksIn7DaysRate), target: '≥ 50%' },
  'Открыли официальный источник': { value: pct(kpi.sourceOpenRate), target: '≥ 35%' },
  'Вернулись по напоминанию': { value: pct(kpi.reminderReturnRate), target: '≥ 40%' },
  'Поделились статусом': { value: kpi.sharers, target: '' },
});
await database.close();
