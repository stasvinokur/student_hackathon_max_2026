import { Button } from '@maxhub/max-ui';
import { formatDayMonthNear, lateOpeningText, plural, type RouteView } from '@otkryvay/core';
import { useId, type ReactNode } from 'react';
import { CircleAlert } from '../components/icons.js';
import { ProgressBar, Screen, TaskCell, TaskList, taskStatusText } from '../components/ui.js';

const LANES: { key: keyof RouteView['lanes']; title: string }[] = [
  { key: 'critical', title: 'Обязательно до открытия' },
  { key: 'ops', title: 'Команда и операционная готовность' },
  { key: 'support', title: 'Можно улучшить' },
];

/** The days to the opening as the hero shows them: a small line over a big one, read as one. */
function daysLine(days: number): [string, string] {
  const count = (n: number) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
  if (days > 0) return ['До открытия', count(days)];
  if (days === 0) return ['Открытие', 'сегодня'];
  return ['Дата открытия прошла', `${count(-days)} назад`];
}

export interface RouteScreenProps {
  route: RouteView;
  /** «Маршрут | Карта» when the map has something to show. */
  tabs?: ReactNode;
  onOpenTask: (id: string) => void;
  onOpenReadiness: () => void;
}

export function RouteScreen({ route, tabs, onOpenTask, onOpenReadiness }: RouteScreenProps) {
  const { readiness, nextStep, blockers } = route;
  const [daysLabel, countText] = daysLine(route.daysToOpening);
  // «К 26 октября не успеть — …» when the opening cannot be met. An API older than the forecast sends no
  // projectedOpeningDate: no forecast, no warning.
  const late = lateOpeningText({ openingDate: route.openingDate, today: route.today, projectedOpeningDate: route.projectedOpeningDate ?? null });
  const done = `${readiness.done} из ${readiness.total}`;
  const nextTitleId = useId();

  return (
    <Screen className="route">
      {tabs}
      <header className="route-hero">
        <span className="route-hero__shape" aria-hidden="true" />
        <h1 className="route-hero__days">
          <span className="route-hero__label">{daysLabel}</span> <span className="route-hero__count">{countText}</span>
        </h1>
        <p className="route-hero__meta">
          {formatDayMonthNear(route.openingDate, route.today)} · {route.pack.title}
        </p>
        {/* The hero keeps the date the user chose, what can be reached is said under it: a part of the page, read in
            its turn, not an alert that breaks in. */}
        {late && (
          <p className="notice notice--warn notice--icon route-hero__warning">
            <CircleAlert size={16} />
            {`${late}.`}
          </p>
        )}
        {/* The bar says its value itself; the number beside it only shows it. */}
        <div className="route-hero__progress">
          <ProgressBar percent={readiness.percent} label="Готовность" valueText={done} />
          <p className="route-hero__done" aria-hidden="true">
            {done}
          </p>
        </div>
      </header>

      {nextStep && (
        <section className="next">
          <h2 className="next__label">Следующий шаг</h2>
          <p className="next__title" id={nextTitleId}>
            {nextStep.title}
          </p>
          <p className="next__status">
            {nextStep.overdue && <CircleAlert size={16} />}
            {taskStatusText(nextStep, route.today)}
          </p>
          <button type="button" className="next__open" aria-describedby={nextTitleId} onClick={() => onOpenTask(nextStep.id)}>
            Открыть шаг
          </button>
        </section>
      )}

      {blockers.length > 0 && (
        <TaskList title="Могут сорвать запуск" alert>
          {blockers.map((task) => (
            <TaskCell key={task.id} task={task} today={route.today} onOpen={onOpenTask} />
          ))}
        </TaskList>
      )}

      {LANES.map(({ key, title }) => {
        const tasks = route.lanes[key];
        if (tasks.length === 0) return null;
        const done = tasks.filter((task) => task.status === 'done').length;
        return (
          <TaskList key={key} title={title} count={{ done, total: tasks.length }}>
            {tasks.map((task) => (
              <TaskCell key={task.id} task={task} today={route.today} onOpen={onOpenTask} />
            ))}
          </TaskList>
        );
      })}

      <Button
        size="medium"
        variant="secondary"
        stretched
        onClick={onOpenReadiness}
        className="route__readiness"
        innerClassNames={{ content: 'route__readiness-label' }}
      >
        Готовность к открытию: {readiness.percent}%
      </Button>

      {route.pack.disclaimer && <p className="route__disclaimer">{route.pack.disclaimer}</p>}
    </Screen>
  );
}
