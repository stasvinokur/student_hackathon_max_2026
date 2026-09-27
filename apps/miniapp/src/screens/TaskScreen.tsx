import { Button } from '@maxhub/max-ui';
import { plural, stepsUnblockedBy, type RouteView, type TaskDetail } from '@otkryvay/core';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { ApiError, type ApiClient } from '../api.js';
import type { Bridge } from '../bridge.js';
import { Check, MapPin } from '../components/icons.js';
import { ActionButton, KindBadge, LoadingState, MessageState, Screen, SourceName, StatusTags, taskStartText } from '../components/ui.js';

type LoadState = { status: 'loading' } | { status: 'ready'; task: TaskDetail } | { status: 'missing' } | { status: 'error'; message: string };

export interface TaskScreenProps {
  taskId: string;
  api: ApiClient;
  bridge: Bridge;
  /** The route, null until it loads: its today dates the card, its steps tell which ones this step opens when done. */
  route: RouteView | null;
  onBack: () => void;
  /** Leads to the route screen itself: «Назад» may lead to the map. */
  onToRoute: () => void;
  onOpenTask: (id: string) => void;
  /** Called after the status was saved, so the route can refresh. */
  onChanged: () => void;
  /** Show «Объясни проще» (LLM feature enabled on the server). */
  explainEnabled?: boolean;
  /** Opens a place of this step on the map. */
  onShowPlace?: ((placeId: string) => void) | undefined;
  /** «Подобрать район на карте»: set for the steps the location index of the route's pack helps with. */
  onPickArea?: (() => void) | undefined;
}

type ExplainState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; text: string } | { status: 'unavailable' };

/** «Открылись 2 шага.»: the steps a step marked done made available. */
export function stepsOpenedText(opened: number): string {
  return `${plural(opened, 'Открылся', 'Открылись', 'Открылись')} ${opened} ${plural(opened, 'шаг', 'шага', 'шагов')}.`;
}

/** Keeps the height of the bottom panel in --step-action-h of the page, for its scroll padding (styles.css). */
function trackPanelHeight(panel: HTMLElement | null) {
  if (!panel || typeof ResizeObserver === 'undefined') return;
  const root = document.documentElement;
  const observer = new ResizeObserver(() => root.style.setProperty('--step-action-h', `${panel.offsetHeight}px`));
  observer.observe(panel);
  return () => {
    observer.disconnect();
    root.style.removeProperty('--step-action-h');
  };
}

/** A part of the card: a label over its content; `sage` is the card of the things to prepare. */
function StepCard({ title, tone, children }: { title: string; tone?: 'sage'; children: ReactNode }) {
  return (
    <section className={tone ? `step-card step-card--${tone}` : 'step-card'}>
      <h2 className="step-label">{title}</h2>
      {children}
    </section>
  );
}

export function TaskScreen({ taskId, api, bridge, route, onBack, onToRoute, onOpenTask, onChanged, explainEnabled = false, onShowPlace, onPickArea }: TaskScreenProps) {
  const placeIds = useId();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [explanation, setExplanation] = useState<ExplainState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(() => {
    setState({ status: 'loading' });
    setNotice(null);
    api
      .getTask(taskId)
      .then((task) => {
        setState({ status: 'ready', task });
        api.sendEvent('task_opened', { task: taskId });
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) setState({ status: 'missing' });
        else setState({ status: 'error', message: error instanceof Error ? error.message : 'Не удалось загрузить карточку.' });
      });
  }, [api, taskId]);

  useEffect(load, [load]);

  if (state.status === 'loading') return <Screen onBack={onBack}><LoadingState text="Загружаем карточку…" /></Screen>;
  if (state.status === 'missing') {
    return (
      <Screen onBack={onBack}>
        <MessageState title="Такого шага нет" text="Этого действия нет в вашем маршруте — возможно, маршрут был построен заново." action={{ label: 'К маршруту', onClick: onToRoute }} />
      </Screen>
    );
  }
  if (state.status === 'error') {
    return (
      <Screen onBack={onBack}>
        <MessageState title="Не удалось загрузить" text={state.message} action={{ label: 'Повторить', onClick: load }} />
      </Screen>
    );
  }

  const { task } = state;
  const done = task.status === 'done';
  const nextStatus = done ? 'todo' : 'done';
  // An API older than the map sends no places.
  const places = task.places ?? [];
  // Without the route there is no today to leave out the year by, nor to tell a last day to start that is today.
  const start = done ? 'Выполнено' : taskStartText(task, route?.today ?? null);

  // No answer is not a refusal: the server may have saved the status, so the card reads the step again. `opened`: the
  // steps a saved «done» opens.
  const check = async (previous: TaskDetail, opened: number) => {
    let checked: TaskDetail;
    try {
      checked = await api.getTask(task.id);
    } catch (error) {
      // The server did answer: the step is gone, as when the card opens.
      if (error instanceof ApiError && error.status === 404) setState({ status: 'missing' });
      else {
        // The change may still have reached the server, so the card claims nothing either way.
        // The last confirmed status comes back with its button: setting a status again is safe.
        setState({ status: 'ready', task: previous });
        setNotice({ kind: 'error', text: 'Нет ответа от сервера — не удалось проверить, сохранился ли статус. Проверьте интернет и откройте карточку снова.' });
        bridge.haptic('error');
      }
      return;
    }
    const saved = checked.status === nextStatus;
    setState({ status: 'ready', task: checked });
    setNotice(
      saved
        ? { kind: 'success', text: `Сервер долго не отвечал — проверили: статус сохранён.${opened > 0 ? ` ${stepsOpenedText(opened)}` : ''}` }
        : { kind: 'error', text: 'Сервер долго не отвечал — проверили: статус не сохранился, попробуйте ещё раз.' },
    );
    bridge.haptic(saved ? 'success' : 'error');
    if (saved) onChanged();
  };

  const toggle = async () => {
    // The button stays enabled while saving, so that it keeps the focus: a press then does nothing.
    if (saving) return;
    const previous = task;
    // Counted on the route as it was before the change: the route refreshes once the change is saved.
    const opened = nextStatus === 'done' && route ? stepsUnblockedBy(route, task.id).length : 0;
    // Optimistic update: the user sees the result at once; rolled back if the server refuses.
    setState({ status: 'ready', task: { ...task, status: nextStatus } });
    setSaving(true);
    setNotice(null);
    try {
      const update = await api.setTaskStatus(task.id, nextStatus);
      setState({ status: 'ready', task: update.task });
      const text = nextStatus === 'todo' ? 'Шаг возвращён в работу.' : opened > 0 ? `Отмечено. ${stepsOpenedText(opened)}` : 'Отмечено как выполненное.';
      setNotice({ kind: 'success', text });
      bridge.haptic('success');
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'timeout') await check(previous, opened);
      else {
        setState({ status: 'ready', task: previous });
        setNotice({ kind: 'error', text: `Не сохранилось: ${error instanceof Error ? error.message : 'ошибка сервера'} Попробуйте ещё раз.` });
        bridge.haptic('error');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen onBack={onBack} className="step">
      {/* The tags show above the title and follow it in the page: moving by headings passes none of them. */}
      <div className="step-head">
        <h1 className="step-head__title">{task.title}</h1>
        <div className="step-head__tags">
          <StatusTags task={task} />
          <KindBadge kind={task.kind} />
        </div>
        <p className="step-head__meta">{`${start} · обычно ${task.durationDays} ${plural(task.durationDays, 'день', 'дня', 'дней')}`}</p>
      </div>

      <StepCard title="Зачем">
        <p className="step-text">{task.why}</p>
      </StepCard>
      <StepCard title="Что сделать сейчас">
        <p className="step-text">{task.doNow}</p>
        {onPickArea && (
          <Button
            size="small"
            variant="secondary"
            stretched
            iconBefore={<MapPin size={16} />}
            className="step-button"
            innerClassNames={{ content: 'step-button__label' }}
            onClick={onPickArea}
          >
            Подобрать район на карте
          </Button>
        )}
      </StepCard>
      {explainEnabled && (
        <section className="step-explain">
          {explanation.status === 'ready' ? (
            <>
              <p className="step-text">{explanation.text}</p>
              <p className="step-note">Пояснение сгенерировано ИИ по тексту карточки и может быть неточным. Основание — источник ниже.</p>
            </>
          ) : (
            <Button
              size="medium"
              variant="secondary"
              stretched
              loading={explanation.status === 'loading'}
              className="step-button"
              innerClassNames={{ content: 'step-button__label' }}
              onClick={() => {
                setExplanation({ status: 'loading' });
                api
                  .explainTask(task.id)
                  .then((result) => setExplanation({ status: 'ready', text: result.text }))
                  .catch(() => setExplanation({ status: 'unavailable' }));
              }}
            >
              Объясни проще
            </Button>
          )}
          {explanation.status === 'unavailable' && <p className="step-note">Пояснение недоступно — попробуйте позже. Всё нужное есть в карточке.</p>}
        </section>
      )}
      {task.prepare.length > 0 && (
        <StepCard title="Что подготовить" tone="sage">
          <ul className="step-list">
            {task.prepare.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </StepCard>
      )}
      {places.length > 0 && (
        <StepCard title="Где">
          {places.map((place) => (
            <div key={place.id} className="where">
              <p className="where__name" id={`${placeIds}-${place.id}`}>
                {place.name}
              </p>
              <p className="where__address">{place.address}</p>
              {onShowPlace && (
                <button type="button" className="link link-button" aria-describedby={`${placeIds}-${place.id}`} onClick={() => onShowPlace(place.id)}>
                  Показать на карте
                </button>
              )}
            </div>
          ))}
        </StepCard>
      )}
      <StepCard title="Выполнено, когда">
        <p className="step-text">{task.doneWhen}</p>
      </StepCard>
      {task.dependsOn.length > 0 && (
        <StepCard title="Сначала нужно">
          <ul className="step-list">
            {task.dependsOn.map((dep) => (
              <li key={dep.id}>
                <button type="button" className="link" onClick={() => onOpenTask(dep.id)}>
                  {dep.title}
                </button>
                {/* On a line of its own under the step: a tail after a long title would wrap alone. */}
                <span className="step-list__status">{task.waitingFor.some((w) => w.id === dep.id) ? 'Ещё не выполнено' : 'Готово'}</span>
              </li>
            ))}
          </ul>
        </StepCard>
      )}
      <section className="step-source">
        <h2 className="step-label">Источник</h2>
        {task.source?.url ? (
          <button
            type="button"
            className="link link-button"
            onClick={() => {
              api.sendEvent('source_opened', { task: task.id });
              bridge.openLink(task.source!.url!);
            }}
          >
            <SourceName title={task.source.title ?? task.source.url} />
          </button>
        ) : (
          <p className="step-note">Практическая рекомендация без нормативного источника.</p>
        )}
      </section>

      <div className="step-action" ref={trackPanelHeight}>
        <ActionButton
          label={done ? 'Вернуть в работу' : 'Выполнено'}
          icon={done ? undefined : <Check size={18} />}
          variant={done ? 'secondary' : 'primary'}
          busy={saving}
          success={notice?.kind === 'success' ? notice.text : null}
          error={notice?.kind === 'error' ? notice.text : null}
          onClick={() => void toggle()}
        />
      </div>
    </Screen>
  );
}
