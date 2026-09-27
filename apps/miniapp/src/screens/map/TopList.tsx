import type { TopPlace } from '@otkryvay/core';
import type { Ref } from 'react';
import { ListRow, TaskList } from '../../components/ui.js';

/**
 * «Лучшие места»: the top of the core, spread over the city; the number is the place in the whole ranking. The list
 * takes the focus when «Подобрать район на карте» brings it into view. Drawn as the lists of the route: the heading in
 * Lora, the rows on a card, the rank on a sage disc and the index in Lora at the right.
 */
export function TopList({ ref, top, onOpen }: { ref?: Ref<HTMLElement> | undefined; top: readonly TopPlace[]; onOpen: (cell: number) => void }) {
  return (
    <TaskList title="Лучшие места" region ref={ref} tabIndex={-1} className="map-top">
      {top.map((place) => (
        <ListRow
          key={place.cell}
          data-cell={place.cell}
          title={place.title}
          subtitle={place.highlights.length > 0 ? place.highlights.join(' · ') : undefined}
          before={
            <span className="rank">
              <span className="visually-hidden">Место </span>
              {place.rank}
            </span>
          }
          after={
            <span className="score">
              <span className="visually-hidden">индекс </span>
              {place.score}
            </span>
          }
          onClick={() => onOpen(place.cell)}
        />
      ))}
    </TaskList>
  );
}
