import type { LocationIndex } from '@otkryvay/core';
import { LoadingState } from '../../components/ui.js';

/** The heading of the tab, in Lora, over its note: the tab has one whatever it shows. */
function TabHeader({ title, note }: { title: string; note?: string }) {
  return (
    <header className="map-hero">
      <h1 className="map-hero__title">{title}</h1>
      {note && <p className="map-hero__note">{note}</p>}
    </header>
  );
}

/** The index by its title alone (on a wide screen, the first row of the grid): the card of a place tells the rest. */
export function IndexHeader({ ix }: { ix: LocationIndex }) {
  return <TabHeader title={ix.title} />;
}

/** Without the index the tab holds the places of the route steps. */
export function PlacesHeader() {
  return <TabHeader title="Места для шагов маршрута" note="Адреса и назначение мест проверены по официальным сайтам." />;
}

/** The index did not come and the route has no places: the tab is still titled, over the notice of the index. */
export function IndexProblemHeader() {
  return <TabHeader title="Индекс мест" />;
}

/**
 * Holds the place of the index, its header included, while the snapshot loads. At least a screen tall, it keeps the
 * places below the fold until the index arrives, so nothing jumps away under a finger (a browser with scroll anchoring
 * also keeps the places still for someone who scrolled down to them). The bar of the title is the heading of the tab
 * meanwhile, its words heard, not shown.
 */
export function IndexSkeleton() {
  return (
    <div className="index-skeleton">
      <h1 className="index-skeleton__title">
        <span className="visually-hidden">Индекс мест</span>
      </h1>
      <div className="index-skeleton__block" aria-hidden="true" />
      <LoadingState compact text="Загружаем индекс мест…" />
      <div className="index-skeleton__row" aria-hidden="true" />
      <div className="index-skeleton__row" aria-hidden="true" />
      <div className="index-skeleton__row" aria-hidden="true" />
    </div>
  );
}
