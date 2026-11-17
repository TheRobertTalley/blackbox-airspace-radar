export type HistorySortKey = 'lastObservedAt' | 'firstObservedAt' | 'identifier' | 'icao' | 'altitudeFt' | 'groundSpeedMph' | 'mach' | 'pointCount';
export interface SortableTrack {
  trackId: string; icao: string; callsign: string; registration?: string | null;
  altitudeFt: number | null; groundSpeedMph: number | null; mach?: number | null;
  pointCount: number; firstObservedAt: string; lastObservedAt: string;
}
export function compareHistory(left: SortableTrack, right: SortableTrack, key: HistorySortKey, ascending: boolean) {
  const value = (item: SortableTrack): string | number | null | undefined => {
    if (key === 'identifier') return item.callsign || item.registration || item.icao;
    if (key === 'lastObservedAt' || key === 'firstObservedAt') return Date.parse(item[key]);
    return item[key];
  };
  const a = value(left), b = value(right);
  const missing = (v: unknown) => v == null || (typeof v === 'number' && !Number.isFinite(v));
  if (missing(a) !== missing(b)) return missing(a) ? 1 : -1;
  const order = missing(a) ? 0 : typeof a === 'string' && typeof b === 'string'
    ? a.localeCompare(b, undefined, { numeric: key !== 'icao', sensitivity: 'base' }) : Number(a) - Number(b);
  return (ascending ? order : -order) || left.trackId.localeCompare(right.trackId);
}
