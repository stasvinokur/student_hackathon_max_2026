import { Button } from '@maxhub/max-ui';
import { formatInt, IMPORTANCE_WEIGHT, type CellExplanation, type CellFactor } from '@otkryvay/core';
import { useId, type Ref } from 'react';
import { X } from '../../components/icons.js';

// The minus sign, not a hyphen; built from its code point so no look-alike character sits in the source.
const MINUS = String.fromCodePoint(0x2212);

export interface CellCardProps {
  ref?: Ref<HTMLElement> | undefined;
  explanation: CellExplanation;
  /** The criterion the competition verdict explains: the verdict goes under its fact. */
  saturationId: string | undefined;
  /** Opens the step linked to the index; absent when that step is not in the route. */
  onCheckPremises: (() => void) | undefined;
  onClose: () => void;
}

/** «+50», «0» or MINUS and «12»: the points of a criterion add up to the raw score of the cell. */
function signed(points: number): string {
  const rounded = Math.round(points);
  if (rounded > 0) return `+${formatInt(rounded)}`;
  if (rounded < 0) return `${MINUS}${formatInt(-rounded)}`;
  return '0';
}

/**
 * The most one criterion can add or take away: 100 × the largest weight / the weights of demand. A bar that long is
 * full, so bars compare across cards and a weak place does not look strong.
 */
function barScale(factors: readonly CellFactor[]): number {
  const weights = factors.map((factor) => IMPORTANCE_WEIGHT[factor.importance]);
  const demand = factors.reduce((sum, factor, i) => (factor.role === 'demand' ? sum + weights[i]! : sum), 0);
  return demand > 0 ? (100 * Math.max(...weights)) / demand : 0;
}

/**
 * Why a cell got its index: every criterion with its points and a checkable fact (doc-3 §3.8). A card of Organic: the
 * title in Lora, the index on a sage disc beside the sentence that says it (so the disc is not read out), the criteria
 * under a label, each with its bar.
 */
export function CellCard({ ref, explanation, saturationId, onCheckPremises, onClose }: CellCardProps) {
  const titleId = useId();
  const scale = barScale(explanation.factors);
  return (
    <section ref={ref} tabIndex={-1} aria-labelledby={titleId} className="map-card">
      <div className="map-card__head">
        <h2 className="map-card__title" id={titleId}>
          {explanation.title}
        </h2>
        <button type="button" className="map-card__close" onClick={onClose}>
          <X size={14} />
          Закрыть
        </button>
      </div>
      <div className="map-card__summary">
        {explanation.score !== null && (
          <span className="map-card__score" aria-hidden="true">
            {explanation.score}
          </span>
        )}
        <p className="map-card__text">{explanation.summary}</p>
      </div>

      <h3 className="step-label map-card__label">Что влияет на индекс</h3>
      <p className="map-card__note">Числа — вклад критерия в оценку места, а не доля индекса 0–100.</p>
      <ul className="factors">
        {explanation.factors.map((factor) => {
          const off = factor.importance === 'off';
          const width = scale > 0 ? Math.round(Math.min(100, (Math.abs(factor.points) / scale) * 100)) : 0;
          return (
            <li key={factor.id} className={off ? 'factor factor--off' : 'factor'}>
              <div className="factor__head">
                <span>{factor.title}</span>
                {off && <span className="factor__off">не учитывается</span>}
                <span className="factor__points">{signed(factor.points)}</span>
              </div>
              <div className="factor__bar" aria-hidden="true">
                <div className={factor.points < 0 ? 'factor__fill factor__fill--minus' : 'factor__fill'} style={{ width: `${width}%` }} />
              </div>
              <p className="factor__fact">{factor.fact}</p>
              {factor.id === saturationId && explanation.competition && <p className="map-card__note">{explanation.competition.text}</p>}
            </li>
          );
        })}
      </ul>

      {onCheckPremises && (
        <Button size="medium" variant="secondary" stretched onClick={onCheckPremises} className="map-card__button">
          Как проверить помещение
        </Button>
      )}
    </section>
  );
}
