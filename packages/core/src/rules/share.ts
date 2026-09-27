import { formatDayMonthNear } from './dates.js';
import { plural } from './plural.js';
import type { RouteView } from './view.js';

/**
 * Short status card a user can share with a partner or accountant in MAX.
 * Contains progress only — no personal data.
 */
export function shareText(view: RouteView, botLink?: string): string {
  const { readiness, blockers } = view;
  const lines = [
    `Готовность к открытию: ${readiness.percent}%`,
    `Закрыто ${readiness.done} из ${readiness.total} шагов, обязательных — ${readiness.criticalDone} из ${readiness.criticalTotal}.`,
    blockers.length > 0
      ? `Осталось ${blockers.length} ${plural(blockers.length, 'критический блокер', 'критических блокера', 'критических блокеров')}: ${blockers.map((b) => b.title).join('; ')}.`
      : 'Критичных блокеров не осталось.',
  ];
  if (view.daysToOpening >= 0) {
    lines.push(`До открытия ${view.daysToOpening} ${plural(view.daysToOpening, 'день', 'дня', 'дней')}.`);
  }
  if (view.projectedOpeningDate) {
    const date = (iso: string) => formatDayMonthNear(iso, view.today);
    lines.push(`Прогноз открытия — ${date(view.projectedOpeningDate)} (план — ${date(view.openingDate)}).`);
  }
  if (botLink) lines.push('', `Маршрут открытия — в «Открывай»: ${botLink}`);
  return lines.join('\n');
}
