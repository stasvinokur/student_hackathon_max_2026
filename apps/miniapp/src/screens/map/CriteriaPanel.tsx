import { Button, Typography } from '@maxhub/max-ui';
import {
  criterionReach,
  describeCriterion,
  formatInt,
  IMPORTANCE,
  importanceLabel,
  type Importance,
  type LocationIndex,
  type ScoreResult,
  type ScoreWarning,
} from '@otkryvay/core';
import { useId, useRef } from 'react';
import { ChevronRight } from '../../components/icons.js';

const WARNING_TEXT: Readonly<Record<ScoreWarning, string>> = {
  no_demand_criteria: 'Включите хотя бы один критерий спроса — без него индекс не считается',
  no_candidates: 'Ни одно место не проходит отбор. Ослабьте условия «Обязательно» или «Исключать»',
};

/**
 * The one line about filtering: the strictest level of each role the pack has, «Обязательно» и «Исключать»
 * отсеивают… Shown once above the rows; the description of each select keeps its own wording of what its strictest
 * level does.
 */
function filterHint(criteria: LocationIndex['criteria']): string {
  const roles = (['demand', 'penalty'] as const).filter((role) => criteria.some((criterion) => criterion.role === role));
  const levels = roles.map((role) => `«${importanceLabel(role, 'required')}»`);
  return `${levels.join(' и ')} ${levels.length > 1 ? 'отсеивают' : 'отсеивает'} неподходящие места.`;
}

export interface CriteriaPanelProps {
  ix: LocationIndex;
  result: ScoreResult;
  open: boolean;
  onToggle: () => void;
  onChange: (criterion: string, importance: Importance) => void;
  onReset: () => void;
}

/**
 * «Критерии»: the importance of every criterion (a native select: the system picker) and the warnings of the core.
 * How many places pass is read out, not shown. A criterion is one row: its title and reach, then the select. Its long
 * description is only the select's accessible description: read out with it, never shown and never read on its own.
 */
export function CriteriaPanel({ ix, result, open, onToggle, onChange, onReset }: CriteriaPanelProps) {
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const changed = ix.criteria.some((criterion, c) => result.importance[c] !== criterion.defaultImportance);
  const counted = result.importance.filter((importance) => importance !== 'off').length;

  return (
    <section className="criteria">
      {/* How many criteria count shows at the right of the button, out of its name, «Критерии»: it is the button's
          description instead, read out after the name and the state. */}
      <button
        ref={toggle}
        type="button"
        className="criteria__toggle"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-describedby={`${id}-count`}
        onClick={onToggle}
      >
        Критерии
        <span className="criteria__count" aria-hidden="true">
          <span id={`${id}-count`}>{`${formatInt(counted)} включено`}</span>
          <ChevronRight size={16} className="criteria__chevron" />
        </span>
      </button>
      {/* The one live region of the panel, always mounted: its count and warnings are read out whenever they change. */}
      <div className="criteria__status" role="status">
        <span className="visually-hidden">{`Подходит ${formatInt(result.candidates)} из ${formatInt(ix.cells.row.length)}`}</span>
        {result.warnings.map((warning) => (
          <div key={warning} className="notice notice--warn">
            {WARNING_TEXT[warning]}
          </div>
        ))}
      </div>
      {/* Always rendered, so the button's aria-controls names an element that exists. */}
      <div id={`${id}-list`} className="criteria__list" hidden={!open}>
        <Typography.Body variant="small" className="criteria__hint muted">
          {filterHint(ix.criteria)}
        </Typography.Body>
        {ix.criteria.map((criterion, c) => {
          const select = `${id}-${criterion.id}`;
          return (
            <div key={criterion.id} className="criterion">
              <div className="criterion__text">
                {/* The title alone: it is the select's accessible name, «Метро». */}
                <label htmlFor={select} className="criterion__title">
                  {criterion.title}
                </label>
                <span className="criterion__reach muted">{criterionReach(criterion)}</span>
              </div>
              {/* A pill of Organic: the select draws no arrow of its own, the chevron over it lets taps through. */}
              <span className="criterion__control">
                <select
                  id={select}
                  className="criterion__select"
                  value={result.importance[c]}
                  aria-describedby={`${select}-about`}
                  onChange={(event) => onChange(criterion.id, event.target.value as Importance)}
                >
                  {IMPORTANCE.map((level) => (
                    <option key={level} value={level}>
                      {importanceLabel(criterion.role, level)}
                    </option>
                  ))}
                </select>
                <ChevronRight size={16} className="criterion__chevron" />
              </span>
              {/* Hidden, not visually hidden: aria-describedby still reads a hidden element it points to, and the
                  text stays out of the reading order, so a screen reader does not read it again after the select. */}
              <span id={`${select}-about`} hidden>
                {describeCriterion(criterion)}
              </span>
            </div>
          );
        })}
        <Button
          size="small"
          variant="secondary"
          disabled={!changed}
          onClick={() => {
            onReset();
            // The button turns itself off: the focus would be lost with it.
            toggle.current?.focus();
          }}
          className="criteria__reset"
        >
          Сбросить
        </Button>
      </div>
    </section>
  );
}
