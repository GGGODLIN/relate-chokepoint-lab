import { normalizeLon } from '../etl/geo.ts';

export const DEFAULT_MAX_LON_SPAN_DEG = 120;

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface UnprojectedLngLat {
  readonly lng: number;
  readonly lat: number;
}

export type ScreenUnprojector = (point: readonly [number, number]) => UnprojectedLngLat;

export interface BBoxRect {
  readonly swLon: number;
  readonly swLat: number;
  readonly neLon: number;
  readonly neLat: number;
}

export interface DragBBoxResult {
  readonly rects: readonly BBoxRect[];
  readonly sw: readonly [number, number];
  readonly ne: readonly [number, number];
  readonly lonSpanDeg: number;
  readonly latSpanDeg: number;
  readonly crossesAntimeridian: boolean;
  readonly exceedsMaxSpanWarning: boolean;
  readonly warning: string | null;
}

const EPSILON_DEG = 1e-9;

function clampLat(lat: number): number {
  if (!Number.isFinite(lat)) {
    throw new RangeError(`Latitude must be a finite number (got ${String(lat)})`);
  }
  return Math.max(-90, Math.min(90, lat));
}

/**
 * Normalizes a screen-space drag gesture into one or two antimeridian-safe
 * WGS84 bounding boxes suitable for Relate's `point.withinBBox(loc, sw, ne)`.
 *
 * Always orders corners via screen-space `minX/maxX` and `minY/maxY` BEFORE
 * calling `unproject` so right-to-left drags (e.g. across the Red Sea) never
 * invert into a global ~350-degree blockade.
 */
export function normalizeDragBBox(
  start: ScreenPoint,
  end: ScreenPoint,
  unproject: ScreenUnprojector,
): DragBBoxResult {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);

  // Screen Y increases downward: maxY is south, minY is north; minX is west, maxX is east.
  const swRaw = unproject([minX, maxY]);
  const neRaw = unproject([maxX, minY]);

  if (!Number.isFinite(swRaw.lng) || !Number.isFinite(neRaw.lng)) {
    throw new RangeError(
      `Unprojected longitudes must be finite (sw.lng=${String(swRaw.lng)}, ne.lng=${String(neRaw.lng)})`,
    );
  }

  const swLat = clampLat(Math.min(swRaw.lat, neRaw.lat));
  const neLat = clampLat(Math.max(swRaw.lat, neRaw.lat));
  const latSpanDeg = neLat - swLat;

  const rawLonDiff = neRaw.lng - swRaw.lng;
  const westLon = normalizeLon(swRaw.lng);
  const eastLonNormalized = normalizeLon(neRaw.lng);

  let rects: BBoxRect[];
  let lonSpanDeg: number;
  let crossesAntimeridian = false;
  let canonicalWest = westLon;
  let canonicalEast = eastLonNormalized;

  if (Math.abs(rawLonDiff) <= EPSILON_DEG) {
    lonSpanDeg = 0;
    canonicalEast = westLon;
    rects = [{ swLon: westLon, swLat, neLon: westLon, neLat }];
  } else if (rawLonDiff >= 360 - EPSILON_DEG) {
    // Unwrapped drag spanning a full world copy or more collapses to [-180, 180].
    lonSpanDeg = 360;
    canonicalWest = -180;
    canonicalEast = 180;
    rects = [{ swLon: -180, swLat, neLon: 180, neLat }];
  } else if (rawLonDiff > 0) {
    // Continuous/unwrapped projector (standard MapLibre map.unproject behavior).
    lonSpanDeg = rawLonDiff;
    if (eastLonNormalized === -180 && westLon > -180) {
      // East edge sits exactly on +180 deg; avoid emitting a degenerate [-180, -180] second box.
      canonicalEast = 180;
      rects = [{ swLon: westLon, swLat, neLon: 180, neLat }];
    } else if (westLon > eastLonNormalized + EPSILON_DEG) {
      crossesAntimeridian = true;
      rects = [
        { swLon: westLon, swLat, neLon: 180, neLat },
        { swLon: -180, swLat, neLon: eastLonNormalized, neLat },
      ];
    } else {
      const safeEast = Math.max(westLon, eastLonNormalized);
      canonicalEast = safeEast;
      rects = [{ swLon: westLon, swLat, neLon: safeEast, neLat }];
    }
  } else {
    // Wrapped projector (returns longitudes modulo [-180, 180)) where minX -> maxX crossed +/-180 deg.
    if (eastLonNormalized === -180 && westLon > -180) {
      lonSpanDeg = 180 - westLon;
      canonicalEast = 180;
      rects = [{ swLon: westLon, swLat, neLon: 180, neLat }];
    } else if (westLon > eastLonNormalized + EPSILON_DEG) {
      lonSpanDeg = 180 - westLon + (eastLonNormalized + 180);
      crossesAntimeridian = true;
      rects = [
        { swLon: westLon, swLat, neLon: 180, neLat },
        { swLon: -180, swLat, neLon: eastLonNormalized, neLat },
      ];
    } else {
      // Guard against non-monotonic wrapped unprojector returning equal wrapped longitudes.
      const safeEast = Math.max(westLon, eastLonNormalized);
      lonSpanDeg = safeEast - westLon;
      canonicalEast = safeEast;
      rects = [{ swLon: westLon, swLat, neLon: safeEast, neLat }];
    }
  }

  const exceedsMaxSpanWarning = lonSpanDeg > DEFAULT_MAX_LON_SPAN_DEG;
  const warning = exceedsMaxSpanWarning
    ? `Blockade box spans ${lonSpanDeg.toFixed(1)}° longitude (exceeds ${DEFAULT_MAX_LON_SPAN_DEG}° threshold).`
    : null;

  return {
    rects,
    sw: [canonicalWest, swLat],
    ne: [canonicalEast, neLat],
    lonSpanDeg,
    latSpanDeg,
    crossesAntimeridian,
    exceedsMaxSpanWarning,
    warning,
  };
}
