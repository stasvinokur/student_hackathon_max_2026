import type { RouteView } from '@otkryvay/core';
import { useState, type CSSProperties } from 'react';
import type { ShareResult } from '../bridge.js';
import { Share2 } from '../components/icons.js';
import { ActionButton, Screen, TaskCell, TaskList } from '../components/ui.js';

export interface ReadinessScreenProps {
  route: RouteView;
  /** The status card as it goes to the chat: the screen shows it, onShare sends it. */
  statusCard: string;
  onBack: () => void;
  onOpenTask: (id: string) => void;
  /** Opens the MAX share sheet, or falls back to copying the status card. */
  onShare: () => Promise<ShareResult>;
}

export function ReadinessScreen({ route, statusCard, onBack, onOpenTask, onShare }: ReadinessScreenProps) {
  const { readiness } = route;
  const [shared, setShared] = useState<ShareResult | null>(null);
  // One share sheet at a time: repeated taps while it is open must not start new ones.
  const [pending, setPending] = useState(false);
  const remainingCritical = route.lanes.critical.filter((t) => t.status !== 'done');

  const share = () => {
    // The button stays enabled while the sheet is open, so that it keeps the focus: a press then does nothing.
    if (pending) return;
    setPending(true);
    // Emptied first, so that a second copy is announced anew.
    setShared(null);
    void onShare()
      .then(setShared)
      .catch(() => setShared('unavailable'))
      .finally(() => setPending(false));
  };

  return (
    <Screen onBack={onBack} className="ready">
      <header className="ready-hero">
        {/* The ring draws the percent the heading in it says: no progress bar besides. The label comes first, as it
            reads, and shows under the number. */}
        <div className="ready-ring" style={{ '--ready-arc': `${readiness.percent}%` } as CSSProperties}>
          <h1 className="ready-ring__text">
            <span>
              готовность <span className="visually-hidden">к открытию</span>
            </span>{' '}
            <span className="ready-ring__percent">{readiness.percent}%</span>
          </h1>
        </div>
        <p className="ready-tags">
          <span className="ready-tag ready-tag--sage">
            Выполнено {readiness.done} из {readiness.total}
          </span>{' '}
          <span className="ready-tag">
            Обязательных {readiness.criticalDone} из {readiness.criticalTotal}
          </span>
        </p>
      </header>

      {remainingCritical.length === 0 ? (
        <section className="task-group">
          <h2 className="task-group__head">
            <span className="task-group__title">Обязательное выполнено</span>
          </h2>
          <p className="ready-note">Все обязательные шаги закрыты — можно готовиться к открытию.</p>
        </section>
      ) : (
        <TaskList title="Осталось обязательного" count={remainingCritical.length}>
          {remainingCritical.map((task) => (
            <TaskCell key={task.id} task={task} today={route.today} onOpen={onOpenTask} />
          ))}
        </TaskList>
      )}

      <section className="ready-card">
        <h2 className="ready-card__label">Уйдёт в чат</h2>
        <p className="ready-card__text">{statusCard}</p>
      </section>

      <div>
        <ActionButton
          label="Поделиться с партнёром"
          icon={<Share2 size={18} />}
          busy={pending}
          success={shared === 'copied' ? 'Текст готовности скопирован — вставьте его в чат с партнёром или бухгалтером.' : null}
          error={shared === 'unavailable' ? 'Не удалось открыть окно отправки. Обновите MAX или сделайте снимок экрана.' : null}
          onClick={share}
        />
      </div>
    </Screen>
  );
}
