import type { Feature, FeatureCollection, MultiLineString, Point, Polygon } from 'geojson';
import type { IsolatedPortRecord } from '../engine/chokepoint-engine.ts';
import {
  compareRoutes,
  odKey,
  type DrawnBox,
  type Evaluation,
  type LonLatTuple,
  type RouteStatus,
} from './model.ts';

export type LineCollection = FeatureCollection<MultiLineString>;
export type PointCollection = FeatureCollection<Point>;
export type PolygonCollection = FeatureCollection<Polygon>;

export const EMPTY_LINES: LineCollection = { type: 'FeatureCollection', features: [] };
export const EMPTY_POINTS: PointCollection = { type: 'FeatureCollection', features: [] };
export const EMPTY_POLYGONS: PolygonCollection = { type: 'FeatureCollection', features: [] };

function toMultiLine(
  segments: readonly (readonly LonLatTuple[])[],
  properties: Record<string, unknown>,
): Feature<MultiLineString> | null {
  const lines = segments
    .filter((segment) => segment.length >= 2)
    .map((segment) => segment.map(([lon, lat]) => [lon, lat]));
  if (lines.length === 0) {
    return null;
  }
  return { type: 'Feature', properties, geometry: { type: 'MultiLineString', coordinates: lines } };
}

/**
 * Tier 3: at most one hero route. A rerouted hero shows the dashed baseline plus the
 * solid detour; an unchanged hero shows only the current path so nothing overlaps.
 */
export function heroRouteCollection(evaluation: Evaluation | null): LineCollection {
  if (evaluation === null) {
    return EMPTY_LINES;
  }
  const delta = compareRoutes(evaluation.heroBaseline, evaluation.hero);
  const features: Feature<MultiLineString>[] = [];
  const showBaseline = delta.status === 'rerouted' || delta.status === 'isolated';
  if (showBaseline && evaluation.heroBaseline !== null) {
    const baseline = toMultiLine(evaluation.heroBaseline.segments, { role: 'baseline' });
    if (baseline !== null) {
      features.push(baseline);
    }
  }
  const current = toMultiLine(evaluation.hero.segments, {
    role: delta.status === 'rerouted' ? 'detour' : 'current',
  });
  if (current !== null) {
    features.push(current);
  }
  return { type: 'FeatureCollection', features };
}

function canonicalSegment(
  a: LonLatTuple,
  b: LonLatTuple,
): { readonly key: string; readonly coords: [number, number][] } {
  const ka = `${a[0]},${a[1]}`;
  const kb = `${b[0]},${b[1]}`;
  return ka <= kb
    ? { key: `${ka}|${kb}`, coords: [[a[0], a[1]], [b[0], b[1]]] }
    : { key: `${kb}|${ka}`, coords: [[b[0], b[1]], [a[0], a[1]]] };
}

/**
 * Tier 2: corridor pressure heatmap for affected (rerouted) golden routes, plus subtle
 * background lines for unaffected non-hero golden routes.
 */
export function goldenRouteCollection(evaluation: Evaluation | null): LineCollection {
  if (evaluation === null) {
    return EMPTY_LINES;
  }
  const heroKey = odKey(evaluation.scenario.hero);
  const unchangedFeatures: Feature<MultiLineString>[] = [];
  const segmentCounts = new Map<string, { readonly coords: [number, number][]; count: number }>();

  for (const golden of evaluation.golden) {
    const status: RouteStatus = compareRoutes(golden.baseline, golden.current).status;
    if (status === 'rerouted') {
      const seenInRoute = new Set<string>();
      for (const polyline of golden.current.segments) {
        for (let i = 0; i < polyline.length - 1; i++) {
          const a = polyline[i];
          const b = polyline[i + 1];
          if (a === undefined || b === undefined || (a[0] === b[0] && a[1] === b[1])) {
            continue;
          }
          const seg = canonicalSegment(a, b);
          if (seenInRoute.has(seg.key)) {
            continue;
          }
          seenInRoute.add(seg.key);
          const existing = segmentCounts.get(seg.key);
          if (existing !== undefined) {
            existing.count++;
          } else {
            segmentCounts.set(seg.key, { coords: seg.coords, count: 1 });
          }
        }
      }
      continue;
    }

    if (odKey({ from: golden.route.from, to: golden.route.to }) === heroKey) {
      continue;
    }
    const feature = toMultiLine(golden.current.segments, {
      id: golden.route.id,
      status: 'unchanged',
      pressure: 0,
    });
    if (feature !== null) {
      unchangedFeatures.push(feature);
    }
  }

  const byPressure = new Map<number, [number, number][][]>();
  for (const { coords, count } of segmentCounts.values()) {
    const bucket = byPressure.get(count);
    if (bucket !== undefined) {
      bucket.push(coords);
    } else {
      byPressure.set(count, [coords]);
    }
  }

  // Emit ascending pressure levels so higher-pressure corridors draw above lower-pressure ones.
  const pressureLevels = [...byPressure.keys()].sort((a, b) => a - b);
  const pressureFeatures: Feature<MultiLineString>[] = pressureLevels.map((pressure) => ({
    type: 'Feature',
    properties: { status: 'rerouted', pressure },
    geometry: {
      type: 'MultiLineString',
      coordinates: byPressure.get(pressure) ?? [],
    },
  }));

  return {
    type: 'FeatureCollection',
    features: [...unchangedFeatures, ...pressureFeatures],
  };
}

export function isolatedPortCollection(ports: readonly IsolatedPortRecord[]): PointCollection {
  return {
    type: 'FeatureCollection',
    features: ports.map((port) => ({
      type: 'Feature',
      properties: { code: port.code, name: port.name, tradeDegree: port.tradeDegree },
      geometry: { type: 'Point', coordinates: [port.lon, port.lat] },
    })),
  };
}

export function boxCollection(
  boxes: readonly DrawnBox[],
  pending: DrawnBox | null,
): PolygonCollection {
  const features: Feature<Polygon>[] = [];
  const push = (box: DrawnBox, state: 'active' | 'pending') => {
    for (const rect of box.rects) {
      features.push({
        type: 'Feature',
        properties: { id: box.id, state },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [rect.swLon, rect.swLat],
              [rect.neLon, rect.swLat],
              [rect.neLon, rect.neLat],
              [rect.swLon, rect.neLat],
              [rect.swLon, rect.swLat],
            ],
          ],
        },
      });
    }
  };
  for (const box of boxes) {
    push(box, 'active');
  }
  if (pending !== null) {
    push(pending, 'pending');
  }
  return { type: 'FeatureCollection', features };
}

/** Edge ids removed by custom boxes, for highlighting the severed lanes on the base network. */
export function severedEdgeIds(evaluation: Evaluation | null): string[] {
  if (evaluation === null) {
    return [];
  }
  const ids = new Set<string>();
  for (const match of evaluation.boxMatches) {
    for (const id of match.matchedEdgeIds) {
      ids.add(id);
    }
  }
  return [...ids];
}

/** Chart graticule every `stepDeg` degrees: the only "texture" on the map, drawn as data. */
export function graticuleCollection(stepDeg = 30): LineCollection {
  const features: Feature<MultiLineString>[] = [];
  for (let lon = -180; lon <= 180; lon += stepDeg) {
    features.push({
      type: 'Feature',
      properties: { kind: 'meridian' },
      geometry: { type: 'MultiLineString', coordinates: [[[lon, -85], [lon, 85]]] },
    });
  }
  for (let lat = -60; lat <= 60; lat += stepDeg) {
    features.push({
      type: 'Feature',
      properties: { kind: lat === 0 ? 'equator' : 'parallel' },
      geometry: { type: 'MultiLineString', coordinates: [[[-180, lat], [180, lat]]] },
    });
  }
  return { type: 'FeatureCollection', features };
}

export type LonLatBounds = readonly [readonly [number, number], readonly [number, number]];

/**
 * Bounds for camera fitting. Routes split at the antimeridian would otherwise produce a
 * world-wide box, so when the longitudes span more than half the globe we measure them
 * on a 0..360 circle instead.
 */
export function routeBounds(segments: readonly (readonly LonLatTuple[])[]): LonLatBounds | null {
  const points = segments.flat();
  if (points.length === 0) {
    return null;
  }
  const lats = points.map(([, lat]) => lat);
  let lons = points.map(([lon]) => lon);
  if (Math.max(...lons) - Math.min(...lons) > 180) {
    lons = lons.map((lon) => (lon < 0 ? lon + 360 : lon));
  }
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}
