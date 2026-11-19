import {
  getDefaultBlockedPassageIds,
  toPassageRelType,
  validateCatalog,
  type ChokepointCatalog,
  type GeoJsonFeatureCollection,
} from '../contracts/catalog.ts';
import {
  formatCountryName,
  haversineKm,
  normalizeLon,
  pointToSegmentKm,
  resamplePolyline,
  roundCoord,
  splitAntimeridianLine,
  type LonLat,
} from './geo.ts';

export interface CanonicalWaypoint {
  readonly id: string;
  readonly lon: number;
  readonly lat: number;
  readonly kind: 'anchor' | 'synthetic';
  readonly degree: number;
  readonly sourceFeatIdx: number | null;
  readonly sourcePartIdx: number | null;
}

export interface CanonicalEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly relType: string;
  readonly passage: string | null;
  readonly km: number;
  readonly geometry: readonly [number, number][];
}

export interface CanonicalPort {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly country: string;
  readonly lon: number;
  readonly lat: number;
  readonly snapWpId: string;
  readonly snapDistKm: number;
  readonly wpDistKm: number;
  readonly toCountries: readonly string[];
  readonly tradeDegree: number;
  readonly isCuratedHub: boolean;
  readonly rank: number;
}

export interface CanonicalCountry {
  readonly code: string;
  readonly name: string;
}

export interface CutAuditEntry {
  readonly passage: string;
  readonly featureCount: number;
  readonly edgeCount: number;
  readonly minDetourKm: number | null;
  readonly disconnectsBasin: boolean;
  readonly bypassLeaks: number;
}

export interface GoldenRouteBaseline {
  readonly routeId: string;
  readonly from: string;
  readonly to: string;
  readonly hops: number | null;
  readonly totalKm: number | null;
  readonly isolated: boolean;
}

export interface PresetIsolationBaseline {
  readonly presetId: string;
  readonly blockedPassages: readonly string[];
  readonly referenceHubCode: string;
  readonly reachablePorts: number;
  readonly isolatedPorts: number;
  readonly sampleIsolatedCodes: readonly string[];
}

export interface BuildReceipt {
  readonly schemaVersion: 1;
  readonly inputs: {
    readonly linestrings: number;
    readonly multilinestring_parts: number;
    readonly total_flattened_lines: number;
    readonly self_loops_dropped: number;
    readonly degenerate_segments_dropped: number;
    readonly south_africa_bypass_features_patched: readonly number[];
    readonly t_junction_vertices_preserved: number;
    readonly t_junction_endpoint_incidences: number;
    readonly raw_ports_total: number;
    readonly raw_duplicate_locodes: number;
    readonly ports_t1_total: number;
    readonly ports_inland_or_far_dropped: number;
    readonly ports_duplicate_t1_resolved: number;
  };
  readonly graph: {
    readonly waypoints: number;
    readonly anchor_waypoints: number;
    readonly synthetic_waypoints: number;
    readonly maritime_edges: number;
    readonly port_link_edges: number;
    readonly total_sea_and_passage_edges: number;
    readonly ports: number;
    readonly countries: number;
    readonly trades_with_edges: number;
    readonly static_rel_types_count: number;
    readonly edges_by_rel_type: Readonly<Record<string, number>>;
    readonly resample_step_km: number;
    readonly max_snap_dist_km: number;
  };
  readonly invariants: {
    readonly connected_components: number;
    readonly ports_on_non_main: number;
    readonly duplicate_port_ids: number;
    readonly max_port_snap_dist_km: number;
    readonly uncleaned_country_names: number;
    readonly northwest_default_blocked: boolean;
    readonly cut_audit_clean: boolean;
    readonly unintended_local_bypasses: number;
  };
  readonly cut_audit: readonly CutAuditEntry[];
  readonly isolation_baselines: Readonly<Record<string, PresetIsolationBaseline>>;
  readonly golden_route_baselines: Readonly<Record<string, readonly GoldenRouteBaseline[]>>;
}

export interface CanonicalGraph {
  readonly schemaVersion: 1;
  readonly waypoints: readonly CanonicalWaypoint[];
  readonly edges: readonly CanonicalEdge[];
  readonly ports: readonly CanonicalPort[];
  readonly countries: readonly CanonicalCountry[];
  readonly receipt: BuildReceipt;
}

export type WasmWaypointTuple = readonly [id: string, lon: number, lat: number];
export type WasmPortTuple = readonly [
  code: string,
  name: string,
  country: string,
  lon: number,
  lat: number,
  snapWpId: string,
  snapDistKm: number,
  wpDistKm: number,
  tradeDegree: number,
  rank: number,
  isCuratedHub: 0 | 1,
];
export type WasmCountryTuple = readonly [code: string, name: string];
export type WasmEdgeTuple = readonly [id: string, from: string, to: string, km: number];
export type WasmTradesWithTuple = readonly [portCode: string, countryCode: string];

export interface WasmGraphPayload {
  readonly schemaVersion: 1;
  readonly catalogMeta: {
    readonly openSeaRelType: string;
    readonly referenceHubCode: string;
    readonly fallbackReferenceHubCode: string;
    readonly defaultBlockedPassages: readonly string[];
    readonly staticRelTypes: readonly string[];
  };
  readonly waypoints: readonly WasmWaypointTuple[];
  readonly ports: readonly WasmPortTuple[];
  readonly countries: readonly WasmCountryTuple[];
  readonly edgesByRelType: Readonly<Record<string, readonly WasmEdgeTuple[]>>;
  readonly tradesWith: readonly WasmTradesWithTuple[];
}

export interface MapLibreEdgeFeature {
  readonly type: 'Feature';
  readonly properties: {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly relType: string;
    readonly passage: string | null;
    readonly km: number;
  };
  readonly geometry:
    | { readonly type: 'LineString'; readonly coordinates: readonly [number, number][] }
    | { readonly type: 'MultiLineString'; readonly coordinates: readonly (readonly [number, number][])[] };
}

export interface MapLibreGeoJson {
  readonly type: 'FeatureCollection';
  readonly features: readonly MapLibreEdgeFeature[];
}

export interface BuildGraphOptions {
  readonly marnetGeoJson: unknown;
  readonly portsGeoJson: unknown;
  readonly catalog: ChokepointCatalog;
  readonly resampleStepKm?: number;
  readonly maxSnapDistKm?: number;
  readonly patchSouthAfricaBypass?: boolean;
  readonly skipCutAudit?: boolean;
}

export class EtlInvariantError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`ETL invariant check failed (${violations.length}): ${violations.join('; ')}`);
    this.name = 'EtlInvariantError';
    this.violations = violations;
  }
}

interface FlattenedLine {
  readonly featIdx: number;
  readonly partIdx: number;
  readonly passage: string | null;
  readonly coords: readonly [number, number][];
}

interface RawSegment {
  readonly u: string;
  readonly v: string;
  passage: string | null;
  readonly km: number;
  sourceFeatIdx: number;
  sourcePartIdx: number;
}

interface AdjEntry {
  readonly ek: string;
  readonly to: string;
  readonly passage: string | null;
  readonly km: number;
  readonly sourceFeatIdx: number;
  readonly sourcePartIdx: number;
}

const SOUTH_AFRICA_BYPASS_SPECS: readonly {
  readonly featIdx: number;
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
}[] = [
  { featIdx: 706, start: [18, -35], end: [20, -40] },
  { featIdx: 4107, start: [20, -40], end: [22, -35] },
];

// Shortest legitimate macro-detour across any passage is ~1,750 km (west-side Cape leg)
// / ~2,673 km (Sunda via Malacca); the unpatched Cape parallel bypass (#706/#4107) is ~1,164 km.
const LOCAL_BYPASS_THRESHOLD_KM = 1500;
const REGION_DISPLAY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCoordPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

function formatCoordToken(value: number): string {
  const fixed = roundCoord(value, 6).toFixed(6).replace(/\.?0+$/, '');
  return fixed === '-0' ? '0' : fixed;
}

function coordKey(lon: number, lat: number): string {
  const nLon = normalizeLon(lon);
  return `${formatCoordToken(nLon)},${formatCoordToken(lat)}`;
}

function anchorWpIdFromKey(key: string): string {
  const [lonToken, latToken] = key.split(',');
  return `wp_${lonToken}_${latToken}`;
}

function coordsMatchEndpoint(actual: readonly [number, number], expected: readonly [number, number]): boolean {
  return (
    Math.abs(normalizeLon(actual[0]) - normalizeLon(expected[0])) < 1e-4 &&
    Math.abs(actual[1] - expected[1]) < 1e-4
  );
}

function matchesSouthAfricaBypass(
  featIdx: number,
  coords: readonly [number, number][],
): boolean {
  const spec = SOUTH_AFRICA_BYPASS_SPECS.find((s) => s.featIdx === featIdx);
  if (!spec || coords.length < 2) {
    return false;
  }
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (!first || !last) {
    return false;
  }
  return (
    (coordsMatchEndpoint(first, spec.start) && coordsMatchEndpoint(last, spec.end)) ||
    (coordsMatchEndpoint(first, spec.end) && coordsMatchEndpoint(last, spec.start))
  );
}

function parseCoordinateLine(rawLine: unknown, label: string): [number, number][] {
  if (!Array.isArray(rawLine) || rawLine.length < 2) {
    throw new EtlInvariantError([`${label} must have at least 2 coordinate pairs`]);
  }
  const out: [number, number][] = [];
  for (let i = 0; i < rawLine.length; i++) {
    const pt = rawLine[i];
    if (!isCoordPair(pt)) {
      throw new EtlInvariantError([`${label}[${i}] must be a finite [lon, lat] pair`]);
    }
    const lon = normalizeLon(pt[0]);
    const lat = pt[1];
    if (lat < -90 || lat > 90) {
      throw new EtlInvariantError([`${label}[${i}] latitude out of [-90, 90]: ${lat}`]);
    }
    out.push([lon, lat]);
  }
  return out;
}

function computeConnectedComponents(
  adj: ReadonlyMap<string, readonly { readonly to: string }[]>,
): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];
  const sortedKeys = [...adj.keys()].sort();
  for (const start of sortedKeys) {
    if (visited.has(start)) continue;
    const queue: string[] = [start];
    visited.add(start);
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      if (cur === undefined) continue;
      for (const edge of adj.get(cur) ?? []) {
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    components.push(queue);
  }
  components.sort((a, b) => b.length - a.length);
  return components;
}

function dijkstraKm(
  adj: ReadonlyMap<string, readonly { readonly to: string; readonly passage: string | null; readonly km: number }[]>,
  start: string,
  goal: string,
  blockedPassages: ReadonlySet<string>,
): number {
  if (start === goal) return 0;
  const dist = new Map<string, number>([[start, 0]]);
  const visited = new Set<string>();
  // Binary min-heap avoids O(V^2) scans during cut-audit across 10k+ nodes.
  const heap: Array<[number, string]> = [[0, start]];

  const pushHeap = (item: [number, string]): void => {
    heap.push(item);
    let idx = heap.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      const pItem = heap[parent];
      const cItem = heap[idx];
      if (!pItem || !cItem || pItem[0] <= cItem[0]) break;
      heap[parent] = cItem;
      heap[idx] = pItem;
      idx = parent;
    }
  };

  const popHeap = (): [number, string] | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let idx = 0;
      while (true) {
        const left = idx * 2 + 1;
        const right = left + 1;
        let smallest = idx;
        const sItem = heap[smallest];
        const lItem = heap[left];
        const rItem = heap[right];
        if (left < heap.length && lItem && sItem && lItem[0] < sItem[0]) {
          smallest = left;
        }
        const curSmall = heap[smallest];
        if (right < heap.length && rItem && curSmall && rItem[0] < curSmall[0]) {
          smallest = right;
        }
        if (smallest === idx) break;
        const tmp = heap[idx];
        const swap = heap[smallest];
        if (tmp && swap) {
          heap[idx] = swap;
          heap[smallest] = tmp;
        }
        idx = smallest;
      }
    }
    return top;
  };

  while (heap.length > 0) {
    const popped = popHeap();
    if (!popped) break;
    const [d, u] = popped;
    if (visited.has(u)) continue;
    visited.add(u);
    if (u === goal) return d;
    for (const edge of adj.get(u) ?? []) {
      if (edge.passage !== null && blockedPassages.has(edge.passage)) continue;
      const nextDist = d + edge.km;
      if (nextDist < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nextDist);
        pushHeap([nextDist, edge.to]);
      }
    }
  }
  return Infinity;
}

function bfsShortestPath(
  adj: ReadonlyMap<string, readonly { readonly to: string; readonly passage: string | null; readonly km: number }[]>,
  startWp: string,
  goalWp: string,
  blockedPassages: ReadonlySet<string>,
): { readonly hops: number; readonly km: number } | null {
  if (startWp === goalWp) {
    return { hops: 0, km: 0 };
  }
  const prev = new Map<string, { readonly from: string; readonly km: number } | null>([[startWp, null]]);
  const queue: string[] = [startWp];
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    if (u === undefined) continue;
    if (u === goalWp) {
      let hops = 0;
      let km = 0;
      let cur: string = goalWp;
      while (true) {
        const step = prev.get(cur);
        if (!step) break;
        hops++;
        km += step.km;
        cur = step.from;
      }
      return { hops, km };
    }
    for (const edge of adj.get(u) ?? []) {
      if (edge.passage !== null && blockedPassages.has(edge.passage)) continue;
      if (!prev.has(edge.to)) {
        prev.set(edge.to, { from: u, km: edge.km });
        queue.push(edge.to);
      }
    }
  }
  return null;
}

function bfsReachable(
  adj: ReadonlyMap<string, readonly { readonly to: string; readonly passage: string | null }[]>,
  startWp: string,
  blockedPassages: ReadonlySet<string>,
): Set<string> {
  const visited = new Set<string>([startWp]);
  const queue: string[] = [startWp];
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    if (u === undefined) continue;
    for (const edge of adj.get(u) ?? []) {
      if (edge.passage !== null && blockedPassages.has(edge.passage)) continue;
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return visited;
}

function resolveCountryNameFromIso2(code: string): string {
  try {
    const resolved = REGION_DISPLAY_NAMES.of(code);
    if (typeof resolved === 'string' && resolved.length > 0 && resolved !== code) {
      return resolved;
    }
  } catch {
    // Fall back to the ISO-2 code if Intl.DisplayNames rejects a non-standard region code.
  }
  return code;
}

export function buildGraph(options: BuildGraphOptions): CanonicalGraph {
  const resampleStepKm = options.resampleStepKm ?? 250;
  const maxSnapDistKm = options.maxSnapDistKm ?? 100;
  const patchSouthAfricaBypass = options.patchSouthAfricaBypass ?? true;
  const skipCutAudit = options.skipCutAudit ?? false;

  const catalogResult = validateCatalog(options.catalog, {
    marnetGeoJson: options.marnetGeoJson,
    portsGeoJson: options.portsGeoJson,
  });
  const catalog = catalogResult.catalog;

  const marnetFc = options.marnetGeoJson as GeoJsonFeatureCollection;
  const portsFc = options.portsGeoJson as GeoJsonFeatureCollection;

  // Step 1: Flatten all LineString and MultiLineString features with part_idx provenance.
  let linestrings = 0;
  let multilinestringParts = 0;
  const patchedBypassIndices: number[] = [];
  const flattenedLines: FlattenedLine[] = [];

  for (let featIdx = 0; featIdx < marnetFc.features.length; featIdx++) {
    const feat = marnetFc.features[featIdx];
    if (!feat || !feat.geometry) {
      throw new EtlInvariantError([`marnet feature[${featIdx}] is missing geometry`]);
    }
    const rawPassage = feat.properties?.passage;
    let passage = typeof rawPassage === 'string' && rawPassage.length > 0 ? rawPassage : null;

    if (feat.geometry.type === 'LineString') {
      linestrings++;
      const coords = parseCoordinateLine(feat.geometry.coordinates, `marnet[${featIdx}]`);
      if (patchSouthAfricaBypass && passage === null && matchesSouthAfricaBypass(featIdx, coords)) {
        passage = 'south_africa';
        patchedBypassIndices.push(featIdx);
      }
      flattenedLines.push({ featIdx, partIdx: 0, passage, coords });
    } else if (feat.geometry.type === 'MultiLineString') {
      const parts = feat.geometry.coordinates;
      if (!Array.isArray(parts) || parts.length === 0) {
        throw new EtlInvariantError([`marnet MultiLineString feature[${featIdx}] has empty coordinates`]);
      }
      for (let partIdx = 0; partIdx < parts.length; partIdx++) {
        multilinestringParts++;
        const coords = parseCoordinateLine(parts[partIdx], `marnet[${featIdx}].part[${partIdx}]`);
        flattenedLines.push({ featIdx, partIdx, passage, coords });
      }
    } else {
      throw new EtlInvariantError([
        `marnet feature[${featIdx}] has unsupported geometry type: ${String(feat.geometry.type)}`,
      ]);
    }
  }

  // Step 2: Count T-junctions & drop self-loops cleanly before registering vertices.
  const interiorKeys = new Set<string>();
  for (const line of flattenedLines) {
    const first = line.coords[0];
    const last = line.coords[line.coords.length - 1];
    if (!first || !last) continue;
    if (coordKey(first[0], first[1]) === coordKey(last[0], last[1])) continue;
    for (let j = 1; j < line.coords.length - 1; j++) {
      const pt = line.coords[j];
      if (pt) {
        interiorKeys.add(coordKey(pt[0], pt[1]));
      }
    }
  }

  const tJunctionVertexSet = new Set<string>();
  let tJunctionEndpointIncidences = 0;
  let selfLoopsDropped = 0;
  let degenerateSegmentsDropped = 0;

  const rawNodeCoords = new Map<string, [number, number]>();
  const rawSegments = new Map<string, RawSegment>();
  const passageFeatureEndpoints = new Map<string, Array<{ featIdx: number; u: string; v: string }>>();

  for (const line of flattenedLines) {
    const keys = line.coords.map(([lon, lat]) => coordKey(lon, lat));
    const startKey = keys[0];
    const endKey = keys[keys.length - 1];
    if (!startKey || !endKey) continue;
    if (startKey === endKey) {
      selfLoopsDropped++;
      continue;
    }

    if (interiorKeys.has(startKey)) {
      tJunctionEndpointIncidences++;
      tJunctionVertexSet.add(startKey);
    }
    if (interiorKeys.has(endKey)) {
      tJunctionEndpointIncidences++;
      tJunctionVertexSet.add(endKey);
    }

    if (line.passage !== null) {
      const list = passageFeatureEndpoints.get(line.passage) ?? [];
      list.push({ featIdx: line.featIdx, u: startKey, v: endKey });
      passageFeatureEndpoints.set(line.passage, list);
    }

    for (let j = 0; j < keys.length - 1; j++) {
      const u = keys[j];
      const v = keys[j + 1];
      const cU = line.coords[j];
      const cV = line.coords[j + 1];
      if (!u || !v || !cU || !cV) continue;
      if (u === v) {
        degenerateSegmentsDropped++;
        continue;
      }

      if (!rawNodeCoords.has(u)) rawNodeCoords.set(u, [cU[0], cU[1]]);
      if (!rawNodeCoords.has(v)) rawNodeCoords.set(v, [cV[0], cV[1]]);

      const [canonU, canonV] = u < v ? [u, v] : [v, u];
      const ek = `${canonU}|${canonV}`;
      const existing = rawSegments.get(ek);
      if (!existing) {
        const pU = rawNodeCoords.get(canonU);
        const pV = rawNodeCoords.get(canonV);
        if (!pU || !pV) continue;
        rawSegments.set(ek, {
          u: canonU,
          v: canonV,
          passage: line.passage,
          km: haversineKm(pU[0], pU[1], pV[0], pV[1]),
          sourceFeatIdx: line.featIdx,
          sourcePartIdx: line.partIdx,
        });
      } else {
        if (line.passage !== null) {
          if (existing.passage !== null && existing.passage !== line.passage) {
            throw new EtlInvariantError([
              `conflicting passages on segment ${ek}: "${existing.passage}" vs "${line.passage}"`,
            ]);
          }
          existing.passage = line.passage;
        }
        if (
          line.featIdx < existing.sourceFeatIdx ||
          (line.featIdx === existing.sourceFeatIdx && line.partIdx < existing.sourcePartIdx)
        ) {
          existing.sourceFeatIdx = line.featIdx;
          existing.sourcePartIdx = line.partIdx;
        }
      }
    }
  }

  // Step 3: Build raw segment adjacency and identify anchors (all degree != 2, T-junctions, and passage vertices).
  const rawAdj = new Map<string, AdjEntry[]>();
  for (const [ek, seg] of rawSegments.entries()) {
    const listU = rawAdj.get(seg.u) ?? [];
    listU.push({
      ek,
      to: seg.v,
      passage: seg.passage,
      km: seg.km,
      sourceFeatIdx: seg.sourceFeatIdx,
      sourcePartIdx: seg.sourcePartIdx,
    });
    rawAdj.set(seg.u, listU);

    const listV = rawAdj.get(seg.v) ?? [];
    listV.push({
      ek,
      to: seg.u,
      passage: seg.passage,
      km: seg.km,
      sourceFeatIdx: seg.sourceFeatIdx,
      sourcePartIdx: seg.sourcePartIdx,
    });
    rawAdj.set(seg.v, listV);
  }

  for (const entries of rawAdj.values()) {
    entries.sort((a, b) => a.to.localeCompare(b.to) || a.ek.localeCompare(b.ek));
  }

  const anchorKeys = new Set<string>();
  for (const [nodeKey, entries] of rawAdj.entries()) {
    if (entries.length !== 2 || entries.some((e) => e.passage !== null) || tJunctionVertexSet.has(nodeKey)) {
      anchorKeys.add(nodeKey);
    }
  }

  // Step 4: Collapse degree-2 non-chokepoint chains and uniformly resample at ~250 km arc length.
  const visitedRawEdges = new Set<string>();
  const waypointMap = new Map<
    string,
    {
      readonly id: string;
      readonly lon: number;
      readonly lat: number;
      readonly kind: 'anchor' | 'synthetic';
      readonly sourceFeatIdx: number | null;
      readonly sourcePartIdx: number | null;
    }
  >();

  const ensureAnchorWp = (nodeKey: string): string => {
    const id = anchorWpIdFromKey(nodeKey);
    if (!waypointMap.has(id)) {
      const coord = rawNodeCoords.get(nodeKey);
      if (!coord) {
        throw new EtlInvariantError([`missing coordinates for anchor key ${nodeKey}`]);
      }
      waypointMap.set(id, {
        id,
        lon: roundCoord(coord[0], 6),
        lat: roundCoord(coord[1], 6),
        kind: 'anchor',
        sourceFeatIdx: null,
        sourcePartIdx: null,
      });
    }
    return id;
  };

  interface TracedChain {
    readonly startAnchor: string;
    readonly endAnchor: string;
    readonly passage: string | null;
    readonly sourceFeatIdx: number;
    readonly sourcePartIdx: number;
    readonly coords: readonly [number, number][];
  }

  const tracedChains: TracedChain[] = [];
  const sortedAnchors = [...anchorKeys].sort();

  for (const startAnchor of sortedAnchors) {
    for (const first of rawAdj.get(startAnchor) ?? []) {
      if (visitedRawEdges.has(first.ek)) continue;
      visitedRawEdges.add(first.ek);

      const nodeKeys: string[] = [startAnchor, first.to];
      let minFeatIdx = first.sourceFeatIdx;
      let minPartIdx = first.sourcePartIdx;
      const passage = first.passage;
      let cur = first.to;
      let prev = startAnchor;

      while (!anchorKeys.has(cur)) {
        const nextEdge = (rawAdj.get(cur) ?? []).find(
          (e) => e.to !== prev && !visitedRawEdges.has(e.ek),
        );
        if (!nextEdge) break;
        visitedRawEdges.add(nextEdge.ek);
        if (
          nextEdge.sourceFeatIdx < minFeatIdx ||
          (nextEdge.sourceFeatIdx === minFeatIdx && nextEdge.sourcePartIdx < minPartIdx)
        ) {
          minFeatIdx = nextEdge.sourceFeatIdx;
          minPartIdx = nextEdge.sourcePartIdx;
        }
        nodeKeys.push(nextEdge.to);
        prev = cur;
        cur = nextEdge.to;
      }

      const endAnchor = cur;
      const forwardCoords = nodeKeys.map((k) => {
        const c = rawNodeCoords.get(k);
        if (!c) throw new EtlInvariantError([`missing coord for ${k}`]);
        return [c[0], c[1]] as [number, number];
      });

      // Canonicalize chain orientation so edge/waypoint generation is order-independent.
      const shouldReverse = startAnchor > endAnchor;
      tracedChains.push({
        startAnchor: shouldReverse ? endAnchor : startAnchor,
        endAnchor: shouldReverse ? startAnchor : endAnchor,
        passage,
        sourceFeatIdx: minFeatIdx,
        sourcePartIdx: minPartIdx,
        coords: shouldReverse ? [...forwardCoords].reverse() : forwardCoords,
      });
    }
  }

  // Handle any rare pure degree-2 cycle detached from anchors (none in marnet, defensive check).
  for (const [ek, seg] of rawSegments.entries()) {
    if (!visitedRawEdges.has(ek)) {
      visitedRawEdges.add(ek);
      anchorKeys.add(seg.u);
      anchorKeys.add(seg.v);
      const pU = rawNodeCoords.get(seg.u);
      const pV = rawNodeCoords.get(seg.v);
      if (pU && pV) {
        tracedChains.push({
          startAnchor: seg.u,
          endAnchor: seg.v,
          passage: seg.passage,
          sourceFeatIdx: seg.sourceFeatIdx,
          sourcePartIdx: seg.sourcePartIdx,
          coords: [pU, pV],
        });
      }
    }
  }

  tracedChains.sort(
    (a, b) =>
      a.startAnchor.localeCompare(b.startAnchor) ||
      a.endAnchor.localeCompare(b.endAnchor) ||
      a.sourceFeatIdx - b.sourceFeatIdx ||
      a.sourcePartIdx - b.sourcePartIdx ||
      (a.passage ?? '').localeCompare(b.passage ?? ''),
  );

  // Track direct anchor pairs so parallel 1-segment chains keep a synthetic midpoint instead of colliding.
  const directPairs = new Set<string>();
  const syntheticCountByOrigin = new Map<string, number>();

  interface DraftEdge {
    readonly from: string;
    readonly to: string;
    readonly relType: string;
    readonly passage: string | null;
    readonly km: number;
    readonly geometry: readonly [number, number][];
  }

  const draftEdges: DraftEdge[] = [];

  for (const chain of tracedChains) {
    const startWpId = ensureAnchorWp(chain.startAnchor);
    const endWpId = ensureAnchorWp(chain.endAnchor);
    const relType =
      chain.passage !== null ? toPassageRelType(chain.passage) : catalog.openSeaRelType;

    const pairKey = startWpId < endWpId ? `${startWpId}|${endWpId}` : `${endWpId}|${startWpId}`;
    const minSegments = startWpId === endWpId ? 3 : directPairs.has(pairKey) ? 2 : 1;
    const sampled = resamplePolyline(chain.coords, resampleStepKm, minSegments);
    if (sampled.length === 2) {
      directPairs.add(pairKey);
    }

    const originKey = `f${chain.sourceFeatIdx}_p${chain.sourcePartIdx}`;
    const chainSeq = syntheticCountByOrigin.get(originKey) ?? 0;
    if (sampled.length > 2) {
      syntheticCountByOrigin.set(originKey, chainSeq + 1);
    }

    let prevId = startWpId;
    for (let step = 1; step < sampled.length; step++) {
      const pt = sampled[step];
      if (!pt) continue;
      let nextId: string;
      if (step === sampled.length - 1) {
        nextId = endWpId;
      } else {
        // Embed featIdx and partIdx so MultiLineString parts can never collide.
        nextId = `wp_syn_${originKey}_c${chainSeq}_s${step}`;
        if (waypointMap.has(nextId)) {
          throw new EtlInvariantError([`synthetic waypoint ID collision: ${nextId}`]);
        }
        waypointMap.set(nextId, {
          id: nextId,
          lon: roundCoord(pt[0], 6),
          lat: roundCoord(pt[1], 6),
          kind: 'synthetic',
          sourceFeatIdx: chain.sourceFeatIdx,
          sourcePartIdx: chain.sourcePartIdx,
        });
      }

      const prevWp = waypointMap.get(prevId);
      const nextWp = waypointMap.get(nextId);
      if (!prevWp || !nextWp) {
        throw new EtlInvariantError([`missing endpoint waypoint for edge ${prevId} -> ${nextId}`]);
      }

      const km = roundCoord(haversineKm(prevWp.lon, prevWp.lat, nextWp.lon, nextWp.lat), 3);
      const [fromId, toId, geom] =
        prevId < nextId
          ? [prevId, nextId, [[prevWp.lon, prevWp.lat], [nextWp.lon, nextWp.lat]] as [number, number][]]
          : [nextId, prevId, [[nextWp.lon, nextWp.lat], [prevWp.lon, prevWp.lat]] as [number, number][]];

      draftEdges.push({
        from: fromId,
        to: toId,
        relType,
        passage: chain.passage,
        km,
        geometry: geom,
      });
      prevId = nextId;
    }
  }

  draftEdges.sort(
    (a, b) =>
      a.relType.localeCompare(b.relType) ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to),
  );

  const edges: CanonicalEdge[] = draftEdges.map((edge, idx) => ({
    id: `e_${idx}`,
    ...edge,
  }));

  // Compute waypoint degrees and resampled adjacency.
  const resAdj = new Map<string, Array<{ readonly to: string; readonly passage: string | null; readonly km: number }>>();
  for (const id of waypointMap.keys()) {
    resAdj.set(id, []);
  }
  for (const edge of edges) {
    resAdj.get(edge.from)?.push({ to: edge.to, passage: edge.passage, km: edge.km });
    resAdj.get(edge.to)?.push({ to: edge.from, passage: edge.passage, km: edge.km });
  }
  for (const list of resAdj.values()) {
    list.sort((a, b) => a.to.localeCompare(b.to));
  }

  const waypoints: CanonicalWaypoint[] = [...waypointMap.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((wp) => ({
      ...wp,
      degree: resAdj.get(wp.id)?.length ?? 0,
    }));

  // Step 5: Connected components check (must be strictly 1).
  const components = computeConnectedComponents(resAdj);
  const mainComponent = new Set(components[0] ?? []);
  const connectedComponentsCount = components.length;

  // Step 6: Automated chokepoint cut-audit across all 13 passages.
  const edgesByRelType: Record<string, number> = {
    [catalog.openSeaRelType]: 0,
  };
  for (const passage of catalog.passages) {
    edgesByRelType[passage.relType] = 0;
  }
  for (const edge of edges) {
    edgesByRelType[edge.relType] = (edgesByRelType[edge.relType] ?? 0) + 1;
  }

  const cutAudit: CutAuditEntry[] = [];
  let unintendedLocalBypasses = 0;

  for (const passageEntry of catalog.passages) {
    const pid = passageEntry.id;
    const edgeCount = edgesByRelType[passageEntry.relType] ?? 0;
    const endpoints = passageFeatureEndpoints.get(pid) ?? [];

    if (skipCutAudit) {
      cutAudit.push({
        passage: pid,
        featureCount: endpoints.length,
        edgeCount,
        minDetourKm: null,
        disconnectsBasin: false,
        bypassLeaks: 0,
      });
      continue;
    }

    let minFiniteDetour = Infinity;
    let disconnectsBasin = false;
    let bypassLeaks = 0;
    const blocked = new Set<string>([pid]);

    for (const ep of endpoints) {
      const uId = anchorWpIdFromKey(ep.u);
      const vId = anchorWpIdFromKey(ep.v);
      const detourKm = dijkstraKm(resAdj, uId, vId, blocked);
      if (!Number.isFinite(detourKm)) {
        disconnectsBasin = true;
      } else {
        if (detourKm < minFiniteDetour) {
          minFiniteDetour = detourKm;
        }
        if (detourKm < LOCAL_BYPASS_THRESHOLD_KM) {
          bypassLeaks++;
        }
      }
    }

    unintendedLocalBypasses += bypassLeaks;
    cutAudit.push({
      passage: pid,
      featureCount: endpoints.length,
      edgeCount,
      minDetourKm: Number.isFinite(minFiniteDetour) ? roundCoord(minFiniteDetour, 1) : null,
      disconnectsBasin,
      bypassLeaks,
    });
  }

  // Step 7: Ingest and filter ports.geojson strictly to t == 1.0 && snap_dist_km <= maxSnapDistKm.
  const rawSegList = [...rawSegments.values()].map((seg) => {
    const a = rawNodeCoords.get(seg.u);
    const b = rawNodeCoords.get(seg.v);
    if (!a || !b) {
      throw new EtlInvariantError([`missing coords for raw segment ${seg.u}|${seg.v}`]);
    }
    return { a, b, minLat: Math.min(a[1], b[1]), maxLat: Math.max(a[1], b[1]) };
  });

  const curatedHubSet = new Set(catalog.curatedHubPorts.map((h) => h.code));
  const rawLocodeCounts = new Map<string, number>();
  let rawPortsTotal = 0;
  let portsT1Total = 0;
  let portsInlandOrFarDropped = 0;

  interface CandidatePort {
    readonly rawIdx: number;
    readonly code: string;
    readonly name: string;
    readonly country: string;
    readonly lon: number;
    readonly lat: number;
    readonly snapWpId: string;
    readonly snapDistKm: number;
    readonly wpDistKm: number;
    readonly toCountries: readonly string[];
    readonly isCuratedHub: boolean;
  }

  const candidatesByCode = new Map<string, CandidatePort[]>();

  for (let i = 0; i < portsFc.features.length; i++) {
    const feat = portsFc.features[i];
    if (!feat || !isRecord(feat.properties) || !feat.geometry) {
      throw new EtlInvariantError([`ports feature[${i}] is missing properties or geometry`]);
    }
    rawPortsTotal++;
    const rawCode = feat.properties.port;
    if (typeof rawCode === 'string' && rawCode.trim().length > 0) {
      rawLocodeCounts.set(rawCode, (rawLocodeCounts.get(rawCode) ?? 0) + 1);
    }

    // Strict maritime terminal filter: t == 1.0 only.
    if (feat.properties.t !== 1) {
      continue;
    }
    portsT1Total++;

    if (feat.geometry.type !== 'Point' || !isCoordPair(feat.geometry.coordinates)) {
      throw new EtlInvariantError([`ports feature[${i}] must have a valid Point geometry`]);
    }

    const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
    if (code.length === 0) {
      throw new EtlInvariantError([`ports feature[${i}] with t==1 is missing port code`]);
    }

    const lon = normalizeLon(feat.geometry.coordinates[0]);
    const lat = feat.geometry.coordinates[1];

    // Measure coastal snap distance to nearest maritime lane segment (antimeridian-safe).
    let segSnapKm = Infinity;
    for (const seg of rawSegList) {
      if (segSnapKm < 200 && (seg.minLat - 3 > lat || seg.maxLat + 3 < lat)) {
        continue;
      }
      const d = pointToSegmentKm(lon, lat, seg.a[0], seg.a[1], seg.b[0], seg.b[1]);
      if (d < segSnapKm) {
        segSnapKm = d;
      }
    }

    if (segSnapKm > maxSnapDistKm) {
      portsInlandOrFarDropped++;
      continue;
    }

    // Attach accepted port to nearest waypoint on the resampled maritime graph.
    let bestWpId = '';
    let bestWpDistKm = Infinity;
    for (const wp of waypoints) {
      const d = haversineKm(lon, lat, wp.lon, wp.lat);
      if (d < bestWpDistKm || (d === bestWpDistKm && wp.id < bestWpId)) {
        bestWpDistKm = d;
        bestWpId = wp.id;
      }
    }

    const rawName = typeof feat.properties.name === 'string' ? feat.properties.name.trim() : code;
    const rawCty = typeof feat.properties.cty === 'string' ? feat.properties.cty : 'Unknown';
    const country = formatCountryName(rawCty);

    const rawToCty = Array.isArray(feat.properties.to_cty) ? feat.properties.to_cty : [];
    const toCountrySet = new Set<string>();
    for (const item of rawToCty) {
      if (typeof item === 'string') {
        const trimmed = item.trim().toUpperCase();
        if (/^[A-Z]{2}$/.test(trimmed)) {
          toCountrySet.add(trimmed);
        }
      }
    }
    const toCountries = [...toCountrySet].sort();

    const candidate: CandidatePort = {
      rawIdx: i,
      code,
      name: rawName.length > 0 ? rawName : code,
      country,
      lon: roundCoord(lon, 6),
      lat: roundCoord(lat, 6),
      snapWpId: bestWpId,
      snapDistKm: roundCoord(segSnapKm, 3),
      wpDistKm: roundCoord(bestWpDistKm, 3),
      toCountries,
      isCuratedHub: curatedHubSet.has(code),
    };

    const existingList = candidatesByCode.get(code) ?? [];
    existingList.push(candidate);
    candidatesByCode.set(code, existingList);
  }

  let rawDuplicateLocodes = 0;
  for (const count of rawLocodeCounts.values()) {
    if (count > 1) {
      rawDuplicateLocodes++;
    }
  }

  let portsDuplicateT1Resolved = 0;
  const dedupedPorts: CandidatePort[] = [];
  for (const list of candidatesByCode.values()) {
    if (list.length > 1) {
      portsDuplicateT1Resolved += list.length - 1;
    }
    list.sort(
      (a, b) =>
        a.snapDistKm - b.snapDistKm ||
        b.toCountries.length - a.toCountries.length ||
        Number(b.isCuratedHub) - Number(a.isCuratedHub) ||
        a.name.localeCompare(b.name) ||
        a.country.localeCompare(b.country) ||
        a.rawIdx - b.rawIdx,
    );
    const winner = list[0];
    if (winner) {
      dedupedPorts.push(winner);
    }
  }

  // Rank ports deterministically with explicit tie-breakers.
  dedupedPorts.sort(
    (a, b) =>
      Number(b.isCuratedHub) - Number(a.isCuratedHub) ||
      b.toCountries.length - a.toCountries.length ||
      a.snapDistKm - b.snapDistKm ||
      a.code.localeCompare(b.code),
  );

  const ports: CanonicalPort[] = dedupedPorts.map((p, idx) => ({
    id: `port_${p.code}`,
    code: p.code,
    name: p.name,
    country: p.country,
    lon: p.lon,
    lat: p.lat,
    snapWpId: p.snapWpId,
    snapDistKm: p.snapDistKm,
    wpDistKm: p.wpDistKm,
    toCountries: p.toCountries,
    tradeDegree: p.toCountries.length,
    isCuratedHub: p.isCuratedHub,
    rank: idx + 1,
  }));

  // Build canonical :Country list from surviving ports' to_cty edges.
  const countryCodes = new Set<string>();
  let tradesWithEdges = 0;
  for (const port of ports) {
    for (const cCode of port.toCountries) {
      countryCodes.add(cCode);
      tradesWithEdges++;
    }
  }
  const countries: CanonicalCountry[] = [...countryCodes]
    .sort()
    .map((code) => ({ code, name: resolveCountryNameFromIso2(code) }));

  // Step 8: Compute receipt invariants and fail-fast assertions.
  const portIdSet = new Set<string>();
  let duplicatePortIds = 0;
  let portsOnNonMain = 0;
  let maxObservedPortSnapKm = 0;
  let uncleanedCountryNames = 0;
  const portByCode = new Map<string, CanonicalPort>();

  for (const port of ports) {
    if (portIdSet.has(port.id)) duplicatePortIds++;
    portIdSet.add(port.id);
    portByCode.set(port.code, port);
    if (!mainComponent.has(port.snapWpId)) portsOnNonMain++;
    if (port.snapDistKm > maxObservedPortSnapKm) maxObservedPortSnapKm = port.snapDistKm;
    if (port.country.includes('_')) uncleanedCountryNames++;
  }

  const defaultBlocked = getDefaultBlockedPassageIds(catalog);
  const northwestDefaultBlocked = defaultBlocked.includes('northwest');
  const cutAuditClean = unintendedLocalBypasses === 0;

  const violations: string[] = [];
  if (connectedComponentsCount !== 1) {
    violations.push(`expected connected_components == 1, got ${connectedComponentsCount}`);
  }
  if (portsOnNonMain !== 0) {
    violations.push(`expected ports_on_non_main == 0, got ${portsOnNonMain}`);
  }
  if (duplicatePortIds !== 0) {
    violations.push(`expected duplicate_port_ids == 0, got ${duplicatePortIds}`);
  }
  if (maxObservedPortSnapKm > maxSnapDistKm) {
    violations.push(
      `expected max_port_snap_dist_km <= ${maxSnapDistKm}, got ${maxObservedPortSnapKm}`,
    );
  }
  if (uncleanedCountryNames !== 0) {
    violations.push(`expected zero uncleaned country names with underscores, got ${uncleanedCountryNames}`);
  }
  if (!northwestDefaultBlocked) {
    violations.push('expected northwest to be default-blocked in catalog');
  }
  if (!cutAuditClean) {
    violations.push(
      `cut-audit detected ${unintendedLocalBypasses} unintended local parallel bypass leak(s)`,
    );
  }
  for (const hub of catalog.curatedHubPorts) {
    if (!portByCode.has(hub.code)) {
      violations.push(`curated hub port "${hub.code}" missing from surviving ports`);
    }
  }
  for (const route of catalog.goldenRoutes) {
    if (!portByCode.has(route.from)) {
      violations.push(`golden route origin "${route.from}" missing from surviving ports`);
    }
    if (!portByCode.has(route.to)) {
      violations.push(`golden route destination "${route.to}" missing from surviving ports`);
    }
  }

  if (violations.length > 0) {
    throw new EtlInvariantError(violations);
  }

  // Step 9: Compute deterministic isolation & golden route baselines for build-receipt.json.
  const refHubPort = portByCode.get(catalog.referenceHubCode);
  if (!refHubPort) {
    throw new EtlInvariantError([`reference hub "${catalog.referenceHubCode}" not found`]);
  }

  const isolationBaselines: Record<string, PresetIsolationBaseline> = {};
  const goldenRouteBaselines: Record<string, GoldenRouteBaseline[]> = {};

  const computeGoldenRoutesForBlocked = (blocked: ReadonlySet<string>): GoldenRouteBaseline[] =>
    catalog.goldenRoutes.map((route) => {
      const fromPort = portByCode.get(route.from);
      const toPort = portByCode.get(route.to);
      if (!fromPort || !toPort) {
        return { routeId: route.id, from: route.from, to: route.to, hops: null, totalKm: null, isolated: true };
      }
      const res = bfsShortestPath(resAdj, fromPort.snapWpId, toPort.snapWpId, blocked);
      if (!res) {
        return { routeId: route.id, from: route.from, to: route.to, hops: null, totalKm: null, isolated: true };
      }
      // +2 hops and +wpDistKm for the two (:Port)-[:SEA_OPEN]->(:WP) link edges.
      return {
        routeId: route.id,
        from: route.from,
        to: route.to,
        hops: res.hops + 2,
        totalKm: roundCoord(res.km + fromPort.wpDistKm + toPort.wpDistKm, 1),
        isolated: false,
      };
    });

  const openBlockedSet = new Set<string>(defaultBlocked);
  goldenRouteBaselines.open = computeGoldenRoutesForBlocked(openBlockedSet);

  for (const preset of catalog.presets) {
    const blocked = new Set<string>([...defaultBlocked, ...preset.blockedPassages]);
    const reachableWps = bfsReachable(resAdj, refHubPort.snapWpId, blocked);
    const isolated = ports.filter((p) => !reachableWps.has(p.snapWpId));
    isolationBaselines[preset.id] = {
      presetId: preset.id,
      blockedPassages: [...blocked].sort(),
      referenceHubCode: catalog.referenceHubCode,
      reachablePorts: ports.length - isolated.length,
      isolatedPorts: isolated.length,
      sampleIsolatedCodes: isolated.slice(0, 10).map((p) => p.code),
    };
    goldenRouteBaselines[preset.id] = computeGoldenRoutesForBlocked(blocked);
  }

  const anchorWaypoints = waypoints.filter((w) => w.kind === 'anchor').length;
  const syntheticWaypoints = waypoints.length - anchorWaypoints;

  const receipt: BuildReceipt = {
    schemaVersion: 1,
    inputs: {
      linestrings,
      multilinestring_parts: multilinestringParts,
      total_flattened_lines: flattenedLines.length,
      self_loops_dropped: selfLoopsDropped,
      degenerate_segments_dropped: degenerateSegmentsDropped,
      south_africa_bypass_features_patched: patchedBypassIndices,
      t_junction_vertices_preserved: tJunctionVertexSet.size,
      t_junction_endpoint_incidences: tJunctionEndpointIncidences,
      raw_ports_total: rawPortsTotal,
      raw_duplicate_locodes: rawDuplicateLocodes,
      ports_t1_total: portsT1Total,
      ports_inland_or_far_dropped: portsInlandOrFarDropped,
      ports_duplicate_t1_resolved: portsDuplicateT1Resolved,
    },
    graph: {
      waypoints: waypoints.length,
      anchor_waypoints: anchorWaypoints,
      synthetic_waypoints: syntheticWaypoints,
      maritime_edges: edges.length,
      port_link_edges: ports.length,
      total_sea_and_passage_edges: edges.length + ports.length,
      ports: ports.length,
      countries: countries.length,
      trades_with_edges: tradesWithEdges,
      static_rel_types_count: catalogResult.staticRelTypes.length,
      edges_by_rel_type: edgesByRelType,
      resample_step_km: resampleStepKm,
      max_snap_dist_km: maxSnapDistKm,
    },
    invariants: {
      connected_components: connectedComponentsCount,
      ports_on_non_main: portsOnNonMain,
      duplicate_port_ids: duplicatePortIds,
      max_port_snap_dist_km: roundCoord(maxObservedPortSnapKm, 3),
      uncleaned_country_names: uncleanedCountryNames,
      northwest_default_blocked: northwestDefaultBlocked,
      cut_audit_clean: cutAuditClean,
      unintended_local_bypasses: unintendedLocalBypasses,
    },
    cut_audit: cutAudit,
    isolation_baselines: isolationBaselines,
    golden_route_baselines: goldenRouteBaselines,
  };

  return {
    schemaVersion: 1,
    waypoints,
    edges,
    ports,
    countries,
    receipt,
  };
}

export function projectToWasmPayload(
  graph: CanonicalGraph,
  catalog: ChokepointCatalog,
): WasmGraphPayload {
  const staticRelTypes = [catalog.openSeaRelType, ...catalog.passages.map((p) => p.relType)];
  const edgesByRelType: Record<string, WasmEdgeTuple[]> = {};
  for (const relType of staticRelTypes) {
    edgesByRelType[relType] = [];
  }
  for (const edge of graph.edges) {
    const bucket = edgesByRelType[edge.relType];
    if (!bucket) {
      throw new EtlInvariantError([`edge "${edge.id}" has unknown relType "${edge.relType}"`]);
    }
    bucket.push([edge.id, edge.from, edge.to, roundCoord(edge.km, 2)]);
  }

  const tradesWith: WasmTradesWithTuple[] = [];
  for (const port of graph.ports) {
    for (const countryCode of port.toCountries) {
      tradesWith.push([port.code, countryCode]);
    }
  }

  return {
    schemaVersion: 1,
    catalogMeta: {
      openSeaRelType: catalog.openSeaRelType,
      referenceHubCode: catalog.referenceHubCode,
      fallbackReferenceHubCode: catalog.fallbackReferenceHubCode,
      defaultBlockedPassages: getDefaultBlockedPassageIds(catalog),
      staticRelTypes,
    },
    waypoints: graph.waypoints.map((w) => [w.id, roundCoord(w.lon, 5), roundCoord(w.lat, 5)]),
    ports: graph.ports.map((p) => [
      p.code,
      p.name,
      p.country,
      roundCoord(p.lon, 5),
      roundCoord(p.lat, 5),
      p.snapWpId,
      roundCoord(p.snapDistKm, 2),
      roundCoord(p.wpDistKm, 2),
      p.tradeDegree,
      p.rank,
      p.isCuratedHub ? 1 : 0,
    ]),
    countries: graph.countries.map((c) => [c.code, c.name]),
    edgesByRelType,
    tradesWith,
  };
}

export function projectToMapLibreGeoJson(graph: CanonicalGraph): MapLibreGeoJson {
  const features: MapLibreEdgeFeature[] = graph.edges.map((edge) => {
    const parts = splitAntimeridianLine(edge.geometry).map((part) =>
      part.map(([lon, lat]) => [roundCoord(lon, 4), roundCoord(lat, 4)] as [number, number]),
    );
    const geometry: MapLibreEdgeFeature['geometry'] =
      parts.length === 1 && parts[0]
        ? { type: 'LineString', coordinates: parts[0] }
        : { type: 'MultiLineString', coordinates: parts };

    return {
      type: 'Feature',
      properties: {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        relType: edge.relType,
        passage: edge.passage,
        km: roundCoord(edge.km, 2),
      },
      geometry,
    };
  });

  return {
    type: 'FeatureCollection',
    features,
  };
}
