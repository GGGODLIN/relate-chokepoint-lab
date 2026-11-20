import type { Feature, FeatureCollection, MultiLineString, Point, Polygon } from 'geojson';
import type { IsolatedPortRecord, PortRecord } from '../engine/chokepoint-engine.ts';
import {
  compareRoutes,
  odKey,
  type DrawnBox,
  type Evaluation,
  type LonLatTuple,
  type RouteStatus,
  type RouteSummary,
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

/** Tier 2: the golden routes under the current scenario, minus whichever one is the hero. */
export function goldenRouteCollection(evaluation: Evaluation | null): LineCollection {
  if (evaluation === null) {
    return EMPTY_LINES;
  }
  const heroKey = odKey(evaluation.scenario.hero);
  const features: Feature<MultiLineString>[] = [];
  for (const golden of evaluation.golden) {
    if (odKey({ from: golden.route.from, to: golden.route.to }) === heroKey) {
      continue;
    }
    const status: RouteStatus = compareRoutes(golden.baseline, golden.current).status;
    const feature = toMultiLine(golden.current.segments, { id: golden.route.id, status });
    if (feature !== null) {
      features.push(feature);
    }
  }
  return { type: 'FeatureCollection', features };
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

export function endpointCollection(
  route: RouteSummary | null,
  portsByCode: ReadonlyMap<string, PortRecord>,
): PointCollection {
  if (route === null) {
    return EMPTY_POINTS;
  }
  const features: Feature<Point>[] = [];
  for (const [role, code] of [
    ['from', route.from],
    ['to', route.to],
  ] as const) {
    const port = portsByCode.get(code);
    if (port !== undefined) {
      features.push({
        type: 'Feature',
        properties: { role, code: port.code, name: port.name },
        geometry: { type: 'Point', coordinates: [port.lon, port.lat] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
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
