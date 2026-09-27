import type { BBox } from './schema.js';

/** Whether a point lies in a pack region's bbox, edges included. */
export function inBox(box: BBox, lat: number, lon: number): boolean {
  return lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east;
}
