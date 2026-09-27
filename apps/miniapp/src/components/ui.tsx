import { Button, CellList, CellSimple, Flex, Panel, Spinner, Typography, type CellSimpleProps } from '@maxhub/max-ui';
import { formatDayMonth, formatDayMonthNear, type Kind, type TaskSummary } from '@otkryvay/core';
import { Component, useId, type ReactNode, type Ref } from 'react';
import { ArrowLeft, Check, ChevronRight, ExternalLink } from './icons.js';

export const KIND_LABEL: Record<Kind, string> = {
  official_fact: 'Официальный источник',
  recommendation: 'Рекомендация',
  test_data: 'Тестовые данные',
};

export function KindBadge({ kind }: { kind: Kind }) {
  return <span className={`badge badge--${kind}`}>{KIND_LABEL[kind]}</span>;
}

/** One-line status of a task: done, what it waits for, overdue (to start today), or when to start it. */
export function taskStatusText(task: TaskSummary, today: string): string {
  if (task.status === 'done') return 'Выполнено';
  if (task.waitingFor.length > 0) return `Ждёт: ${task.waitingFor.map((t) => t.title).join(', ')}`;
  if (task.overdue) return 'Просрочено — начните сегодня';
  return taskStartText(task, today);
}

/**
 * When to start a step to do: today when the opening waits for it (overdue) or its last day to start is today, else by
 * that day, with the name of the month, the year only outside the one of `today`. A date is never one gone by, which
 * would read as a chance missed for good. Without a today (the route not loaded yet) the date takes its year, and only
 * an overdue step is known to be for today.
 */
export function taskStartText(task: Pick<TaskSummary, 'latestStart' | 'overdue'>, today: string | null): string {
  // ISO dates compare as strings.
  if (task.overdue || (today !== null && task.latestStart <= today)) return 'Начать сегодня';
  return `Начать до ${today === null ? formatDayMonth(task.latestStart, true) : formatDayMonthNear(task.latestStart, today)}`;
}

/**
 * The status of a step as tags, for its card: done, or what is wrong with a step to do, overdue or waiting. The route
 * marks overdue only a step that can be started today, so the two never come together. A step to start in time has none.
 */
export function StatusTags({ task }: { task: TaskSummary }) {
  if (task.status === 'done') return <span className="badge badge--done">Выполнено</span>;
  return (
    <>
      {task.overdue && <span className="badge badge--overdue">Просрочено</span>}
      {task.waitingFor.length > 0 && <span className="badge badge--waiting">{task.waitingFor.length === 1 ? 'Ждёт другой шаг' : 'Ждёт другие шаги'}</span>}
    </>
  );
}

/** The status of a step as a shape: a sage disc with a check, a terracotta one with «!», a dashed ring, a ring. */
export function StatusMark({ task }: { task: TaskSummary }) {
  const state = task.status === 'done' ? 'done' : task.waitingFor.length > 0 ? 'waiting' : task.overdue ? 'overdue' : 'todo';
  return (
    <span className={`mark mark--${state}`} aria-hidden="true">
      {state === 'done' ? <Check size={16} /> : state === 'overdue' ? '!' : null}
    </span>
  );
}

/**
 * The button that does what a screen is for (a step done, the card shared), with what it did over it: a success in a
 * live region that is always there, empty until then (a region added along with its text may go unannounced), a failure
 * as an alert, which is announced as it comes. Not `loading` while `busy`: MAX UI disables the button with it, which
 * takes the focus away, and hides the label, which names the button. The label stays, a spinner in place of the icon;
 * the screen ignores a press while busy.
 */
export function ActionButton({
  label,
  icon,
  variant = 'primary',
  busy,
  success,
  error,
  onClick,
}: {
  label: string;
  icon?: ReactNode;
  variant?: 'primary' | 'secondary';
  busy: boolean;
  success?: string | null | undefined;
  error?: string | null | undefined;
  onClick: () => void;
}) {
  return (
    <>
      <div role="status">
        {success && (
          <div className="notice notice--success notice--icon action-notice">
            <Check size={16} />
            {success}
          </div>
        )}
      </div>
      {error && (
        <div className="notice notice--error action-notice" role="alert">
          {error}
        </div>
      )}
      <Button
        size="medium"
        variant={variant}
        stretched
        aria-busy={busy || undefined}
        aria-disabled={busy || undefined}
        iconBefore={
          busy ? (
            <span aria-hidden="true" className="action-button__spinner">
              <Spinner size={18} appearance={variant === 'primary' ? 'contrast-static' : 'primary'} />
            </span>
          ) : (
            icon
          )
        }
        className="action-button"
        innerClassNames={{ content: 'action-button__label' }}
        onClick={onClick}
      >
        {label}
      </Button>
    </>
  );
}

/** A bar of `percent`, named `label`; `valueText` says the value in words (the percent alone otherwise). */
export function ProgressBar({ percent, label, valueText }: { percent: number; label: string; valueText?: string }) {
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={valueText}>
      <div className="progress__fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** A screen of the app; `className` lays out one screen of its kind. */
export function Screen({ children, onBack, className }: { children: ReactNode; onBack?: (() => void) | undefined; className?: string }) {
  return (
    <Panel mode="secondary" className={className ? `screen ${className}` : 'screen'}>
      {onBack && (
        <button type="button" className="back" onClick={onBack}>
          <ArrowLeft size={18} />
          Назад
        </button>
      )}
      {children}
    </Panel>
  );
}

/** A screen that waits; `compact` waits for one part of a screen, with the rest already shown. */
export function LoadingState({ text = 'Загружаем…', compact = false }: { text?: string; compact?: boolean }) {
  return (
    <Flex direction="column" align="center" justify="center" gap={12} className={compact ? 'state state--compact' : 'state'} role="status">
      <Spinner size={24} />
      <Typography.Body variant="medium">{text}</Typography.Body>
    </Flex>
  );
}

export function MessageState({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: { label: string; onClick: () => void; loading?: boolean } | undefined;
}) {
  return (
    <Flex direction="column" align="center" justify="center" gap={12} className="state" role="alert">
      <Typography.Headline variant="medium" className="center">
        {title}
      </Typography.Headline>
      <Typography.Body variant="medium" className="muted center">
        {text}
      </Typography.Body>
      {action && (
        <Button size="medium" variant="primary" loading={action.loading ?? false} disabled={action.loading ?? false} onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </Flex>
  );
}

export interface SectionItem<T extends string> {
  id: T;
  label: string;
}

/**
 * The switch between the root screens: sections of the app, not tabs inside a page, so a navigation of buttons with
 * the current one marked by aria-current. Switching replaces the screen, and the new screen mounts its own switch;
 * `focusCurrent` gives the focus back to the current section. It sticks to the top: «Маршрут» stays at hand from the
 * end of a long map. `end` goes after the navigation, in the same bar: a control that is no section (the theme switch).
 */
export function SectionNav<T extends string>({
  label,
  items,
  current,
  onSelect,
  focusCurrent = false,
  end,
}: {
  label: string;
  items: readonly SectionItem<T>[];
  current: T;
  onSelect: (id: T) => void;
  focusCurrent?: boolean;
  end?: ReactNode;
}) {
  return (
    <div className="sections-bar">
      <nav aria-label={label} className="sections">
        {items.map((item) => {
          const active = item.id === current;
          return (
            <button
              key={item.id}
              type="button"
              className="sections__item"
              aria-current={active ? 'page' : undefined}
              autoFocus={focusCurrent && active}
              onClick={() => {
                if (!active) onSelect(item.id);
              }}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
      {end}
    </div>
  );
}

interface FeatureBoundaryProps {
  /** What to show instead, by the error that was caught. */
  fallback: (error: unknown) => ReactNode;
  /** Called once per caught error, after the fallback is shown. */
  onError?: ((error: unknown) => void) | undefined;
  children: ReactNode;
}

/**
 * Shows a fallback instead of an optional screen that failed (its chunk did not load, or it threw on unexpected
 * data): without a boundary React unmounts the whole app, the route with it.
 */
export class FeatureBoundary extends Component<FeatureBoundaryProps, { failed: boolean; error: unknown }> {
  override state: { failed: boolean; error: unknown } = { failed: false, error: null };

  static getDerivedStateFromError(error: unknown): { failed: boolean; error: unknown } {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown) {
    this.props.onError?.(error);
  }

  override render() {
    return this.state.failed ? this.props.fallback(this.state.error) : this.props.children;
  }
}

/**
 * A list row that acts as a button: MAX UI CellSimple lays it out in <div>s, which a <button> may not hold, so the row
 * is a button by role, focusable and pressed with Enter or Space.
 */
export function CellButton({ onClick, className, ...props }: Omit<CellSimpleProps, 'as' | 'asChild' | 'onClick' | 'role' | 'tabIndex' | 'onKeyDown'> & { onClick: () => void }) {
  return (
    <CellSimple
      {...props}
      className={className ? `cell-button ${className}` : 'cell-button'}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); // Space would scroll the page
        onClick();
      }}
    />
  );
}

/**
 * A row of a list of Organic (TaskList): the title at 600, the muted subtitle, a mark or a rank before, whatever comes
 * after. `className` adds to the class of the row.
 */
export function ListRow({ className, ...props }: Parameters<typeof CellButton>[0]) {
  return (
    <CellButton
      subtitleMode="tertiary"
      {...props}
      className={className ? `task-row ${className}` : 'task-row'}
      innerClassNames={{ before: 'task-row__before', title: 'task-row__title', subtitle: 'task-row__subtitle' }}
    />
  );
}

/** Tappable task row of a TaskList, on the route and the readiness screen. */
export function TaskCell({ task, today, onOpen }: { task: TaskSummary; today: string; onOpen: (id: string) => void }) {
  return (
    <ListRow
      title={task.title}
      subtitle={taskStatusText(task, today)}
      before={<StatusMark task={task} />}
      after={<ChevronRight size={18} className="task-row__chevron" />}
      onClick={() => onOpen(task.id)}
      className={task.status === 'done' ? 'cell--done' : undefined}
    />
  );
}

/**
 * A list of steps, or of places on the map, under a heading of its own: the rows on one card. `count` shows at the
 * right of the heading how many of its steps are done, and joins its name: «Обязательно до открытия: выполнено 1 из 9»;
 * a number shows as it is: «Осталось обязательного: 8». `alert` gives the title the colour of an alert. `region` makes
 * the list a region named by its title (a list the page brings into view and focuses, with `ref` and `tabIndex`).
 */
export function TaskList({
  title,
  count,
  alert = false,
  region = false,
  ref,
  tabIndex,
  className,
  children,
}: {
  title: string;
  count?: { done: number; total: number } | number | undefined;
  alert?: boolean;
  region?: boolean;
  ref?: Ref<HTMLElement> | undefined;
  tabIndex?: number;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section ref={ref} tabIndex={tabIndex} className={className ? `task-group ${className}` : 'task-group'} aria-labelledby={region ? id : undefined}>
      {/* The words that join the count to the name go with the name, the count holds only what shows. (Chrome still
          reads a space before them: it takes the hidden box, positioned out of the line, for a block.) */}
      <h2 className={alert ? 'task-group__head task-group__head--alert' : 'task-group__head'}>
        <span id={id} className="task-group__title">
          {title}
          {count !== undefined && <span className="visually-hidden">{typeof count === 'number' ? ':' : ': выполнено'}</span>}
        </span>
        {count !== undefined && (
          <>
            {' '}
            <span className="task-group__count">{typeof count === 'number' ? count : `${count.done} из ${count.total}`}</span>
          </>
        )}
      </h2>
      <CellList className="task-list">{children}</CellList>
    </section>
  );
}

/**
 * The name of a source as a link: the icon of a link that leaves the app sticks to its last word, so it never wraps
 * onto a line of its own.
 */
export function SourceName({ title }: { title: string }) {
  const cut = title.lastIndexOf(' ') + 1;
  return (
    <span>
      {title.slice(0, cut)}
      {/* A name of one word (a bare URL) may wrap anywhere: kept on one line, it would widen the page. */}
      <span className={cut > 0 ? 'step-source__tail' : undefined}>
        {title.slice(cut)}
        <ExternalLink size={14} />
      </span>
    </span>
  );
}
