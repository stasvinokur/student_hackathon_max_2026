import type { RoutePlace, TaskSummary } from '@otkryvay/core';
import { useId, type Ref } from 'react';
import { ChevronRight, MapPin, X } from '../../components/icons.js';
import { ListRow, SourceName, StatusMark, TaskList, taskStatusText } from '../../components/ui.js';

/** «Места для шагов»: the places of the route steps with their addresses and steps, drawn as the lists of the route. */
export function PlaceList({ places, onOpen }: { places: readonly RoutePlace[]; onOpen: (id: string) => void }) {
  return (
    <TaskList title="Места для шагов" region>
      {places.map((place) => (
        <ListRow
          key={place.id}
          data-place={place.id}
          title={place.name}
          subtitle={
            <>
              <span className="place-row__line">{place.address}</span>
              <span className="place-row__line">
                {`${place.actions.length === 1 ? 'Шаг' : 'Шаги'}: ${place.actions.map((action) => action.title).join(' · ')}`}
              </span>
            </>
          }
          after={<ChevronRight size={18} className="task-row__chevron" />}
          onClick={() => onOpen(place.id)}
        />
      ))}
    </TaskList>
  );
}

export interface PlaceCardProps {
  ref?: Ref<HTMLElement> | undefined;
  place: RoutePlace;
  /** Steps of the route by id: done steps keep their places, and the card shows their status. */
  tasks: ReadonlyMap<string, TaskSummary>;
  today: string;
  onOpenStep: (id: string) => void;
  onOpenLink: (url: string) => void;
  onClose: () => void;
}

/**
 * The place in 2GIS and in Yandex Maps: longitude first in both, the coordinates as they are: a dot, no rounding.
 * 2GIS puts its pin on the building, with the firms in it, only with `m`: without it the point resolves to the whole
 * city. Yandex Maps puts a pin at `pt`.
 */
function mapLinks({ lat, lon }: Pick<RoutePlace, 'lat' | 'lon'>): Array<{ title: string; url: string }> {
  const point = `${lon},${lat}`;
  return [
    { title: 'Открыть в 2ГИС', url: `https://2gis.ru/geo/${point}?m=${point}/18` },
    { title: 'Открыть в Яндекс Картах', url: `https://yandex.ru/maps/?pt=${point}&z=17&l=map` },
  ];
}

/**
 * A place of the route steps: address, note, the steps done there, the official source, 2GIS and Yandex Maps. A card
 * of Organic: the title in Lora, the steps as the rows of a list, the maps as pills.
 */
export function PlaceCard({ ref, place, tasks, today, onOpenStep, onOpenLink, onClose }: PlaceCardProps) {
  const titleId = useId();
  const { source } = place;
  return (
    <section ref={ref} tabIndex={-1} aria-labelledby={titleId} className="map-card">
      <div className="map-card__head">
        <h2 className="map-card__title" id={titleId}>
          {place.name}
        </h2>
        <button type="button" className="map-card__close" onClick={onClose}>
          <X size={14} />
          Закрыть
        </button>
      </div>
      <p className="map-card__text">{place.address}</p>
      {place.note && <p className="map-card__note">{place.note}</p>}

      {/* The rows of a list of the route, on the card itself. */}
      <div className="task-list map-card__steps">
        {place.actions.map((action) => {
          const task = tasks.get(action.id);
          return (
            <ListRow
              key={action.id}
              title={action.title}
              subtitle={task ? taskStatusText(task, today) : undefined}
              before={task ? <StatusMark task={task} /> : undefined}
              after={<span className="open-step">Открыть шаг</span>}
              onClick={() => onOpenStep(action.id)}
            />
          );
        })}
      </div>

      <div className="map-card__source">
        <button type="button" className="link link-button" onClick={() => onOpenLink(source.url)}>
          <SourceName title={`Источник: ${source.title}`} />
        </button>
        <div className="map-card__maps">
          {mapLinks(place).map(({ title, url }) => (
            <button key={url} type="button" className="map-card__map" onClick={() => onOpenLink(url)}>
              <MapPin size={16} />
              {title}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
