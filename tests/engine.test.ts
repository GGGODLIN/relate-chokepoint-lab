import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getDefaultBlockedPassageIds,
  type ChokepointCatalog,
} from '../src/contracts/catalog.ts';
import type { WasmGraphPayload } from '../src/etl/build-graph.ts';
import {
  ChokepointEngine,
  ChokepointWorkerClient,
  DEFAULT_MAX_LON_SPAN_DEG,
  normalizeDragBBox,
  QueryBuilder,
  RelateQueryError,
  StaleRequestError,
  WasmTrapError,
  WorkerDisposedError,
  WorkerTimeoutError,
  type BootTelemetry,
  type DragBBoxResult,
  type ScreenPoint,
  type ScreenUnprojector,
  type WorkerErrorEventLike,
  type WorkerLike,
  type WorkerMessageEventLike,
  type WorkerRequest,
  type WorkerResponse,
} from '../src/engine/index.ts';
import { initRelateWasmNode } from '../src/engine/probe.ts';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const catalog = JSON.parse(
  readFileSync(resolve(ROOT_DIR, 'contracts/chokepoint-catalog.json'), 'utf8'),
) as ChokepointCatalog;
const wasmPayload = JSON.parse(
  readFileSync(resolve(ROOT_DIR, 'public/data/graph.wasm.json'), 'utf8'),
) as WasmGraphPayload;

// --- Independent Oracle for Conditional PBT P2 (QueryBuilder static disjunction) ---

function evaluateQueryBuilderP2Oracle(
  cypher: string,
  cat: ChokepointCatalog,
  blockedPassageIds: readonly string[],
): {
  readonly pSingleColonOnly: boolean;
  readonly pNoEdgePropertyWhere: boolean;
  readonly pExactOpenComplement: boolean;
} {
  const hasDoubleColon = /\|\s*:/.test(cypher);
  const shortestPathMatches = [...cypher.matchAll(/shortestPath\s*\(([^)]*\([^)]*\)[^)]*)\)/gi)];
  let singleColonBracketOk = shortestPathMatches.length > 0 && !hasDoubleColon;

  const blockedSet = new Set(blockedPassageIds);
  const expectedOpen = new Set<string>([cat.openSeaRelType]);
  const blockedRelTypes = new Set<string>();
  for (const p of cat.passages) {
    if (blockedSet.has(p.id)) {
      blockedRelTypes.add(p.relType);
    } else {
      expectedOpen.add(p.relType);
    }
  }

  let exactComplementOk = shortestPathMatches.length > 0;
  for (const match of shortestPathMatches) {
    const body = match[1] ?? '';
    const bracket = /\[([^\]]*)\]/.exec(body);
    if (!bracket) {
      singleColonBracketOk = false;
      exactComplementOk = false;
      continue;
    }
    const spec = (bracket[1] ?? '').trim();
    const validSpec = /^:([A-Z][A-Z0-9_]*(?:\|[A-Z][A-Z0-9_]*)*)\*$/.exec(spec);
    if (!validSpec) {
      singleColonBracketOk = false;
      exactComplementOk = false;
      continue;
    }
    const types = (validSpec[1] ?? '').split('|');
    const emittedSet = new Set(types);
    if (emittedSet.size !== types.length || emittedSet.size !== expectedOpen.size) {
      exactComplementOk = false;
    }
    for (const relType of emittedSet) {
      if (!expectedOpen.has(relType) || blockedRelTypes.has(relType)) {
        exactComplementOk = false;
      }
    }
  }

  for (const blockedRelType of blockedRelTypes) {
    if (new RegExp(`\\b${blockedRelType}\\b`).test(cypher)) {
      exactComplementOk = false;
    }
  }

  const hasEdgePredicate =
    /\[[^\]]*\bWHERE\b[^\]]*\]/i.test(cypher) ||
    /\(\([^)]*\bWHERE\b[^)]*\)\)/i.test(cypher) ||
    /\b(?:ALL|NONE|ANY|SINGLE)\s*\([^)]*relationships\s*\(/i.test(cypher) ||
    /\bWHERE\b[^\n]*\b[a-z_][a-z0-9_]*\.(?:passage|kind|blocked|km)\b/i.test(cypher) ||
    shortestPathMatches.some((m) => /\{[^}]*\}/.test(m[1] ?? '') || /\bWHERE\b/i.test(m[1] ?? ''));

  return {
    pSingleColonOnly: singleColonBracketOk,
    pNoEdgePropertyWhere: !hasEdgePredicate,
    pExactOpenComplement: exactComplementOk,
  };
}

// --- Independent Oracle for Conditional PBT P3 (normalizeDragBBox screen geometry) ---

function createLinearViewportUnprojector(
  originLon: number,
  degPerPxX: number,
  originLat: number,
  degPerPxY: number,
  wrapOutput: boolean,
): ScreenUnprojector {
  return ([x, y]) => {
    const rawLng = originLon + x * degPerPxX;
    const lat = Math.max(-85, Math.min(85, originLat - y * degPerPxY));
    if (!wrapOutput) {
      return { lng: rawLng, lat };
    }
    const wrapped = ((((rawLng + 180) % 360) + 360) % 360) - 180;
    return { lng: wrapped === 180 ? -180 : wrapped, lat };
  };
}

function strictlyCrossesOddMultipleOf180(westContinuous: number, eastContinuous: number): boolean {
  const span = eastContinuous - westContinuous;
  if (span <= 1e-9 || span >= 360 - 1e-9) {
    return false;
  }
  // Check whether there is an integer k such that west < 180 + 360*k < east.
  const kMin = Math.floor((westContinuous - 180) / 360) + 1;
  const crossingLon = 180 + 360 * kMin;
  return crossingLon > westContinuous + 1e-9 && crossingLon < eastContinuous - 1e-9;
}

function evaluateBBoxP3Oracle(
  start: ScreenPoint,
  end: ScreenPoint,
  originLon: number,
  degPerPxX: number,
  result: DragBBoxResult,
  swappedResult: DragBBoxResult,
): {
  readonly pValidRects: boolean;
  readonly pDirectionInvariant: boolean;
  readonly pSpanConserved: boolean;
  readonly pSplitOnlyOnGenuineAntimeridian: boolean;
  readonly pWarningThreshold: boolean;
} {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const westContinuous = originLon + minX * degPerPxX;
  const eastContinuous = originLon + maxX * degPerPxX;
  const expectedSpan = Math.min(360, Math.max(0, eastContinuous - westContinuous));
  const expectedCrossing = strictlyCrossesOddMultipleOf180(westContinuous, eastContinuous);

  const pValidRects =
    result.rects.length >= 1 &&
    result.rects.length <= 2 &&
    result.rects.every(
      (r) =>
        Number.isFinite(r.swLon) &&
        Number.isFinite(r.neLon) &&
        Number.isFinite(r.swLat) &&
        Number.isFinite(r.neLat) &&
        r.swLon >= -180 &&
        r.neLon <= 180 &&
        r.swLon <= r.neLon &&
        r.swLat >= -90 &&
        r.neLat <= 90 &&
        r.swLat <= r.neLat,
    );

  const pDirectionInvariant =
    result.rects.length === swappedResult.rects.length &&
    result.crossesAntimeridian === swappedResult.crossesAntimeridian &&
    Math.abs(result.lonSpanDeg - swappedResult.lonSpanDeg) <= 1e-6 &&
    result.rects.every((r, idx) => {
      const s = swappedResult.rects[idx];
      return (
        s !== undefined &&
        Math.abs(r.swLon - s.swLon) <= 1e-6 &&
        Math.abs(r.neLon - s.neLon) <= 1e-6 &&
        Math.abs(r.swLat - s.swLat) <= 1e-6 &&
        Math.abs(r.neLat - s.neLat) <= 1e-6
      );
    });

  const rectLonSum = result.rects.reduce((sum, r) => sum + (r.neLon - r.swLon), 0);
  const pSpanConserved =
    Math.abs(result.lonSpanDeg - expectedSpan) <= 1e-5 &&
    Math.abs(rectLonSum - expectedSpan) <= 1e-5;

  const pSplitOnlyOnGenuineAntimeridian =
    result.crossesAntimeridian === expectedCrossing &&
    result.rects.length === (expectedCrossing ? 2 : 1);

  const expectedWarn = expectedSpan > DEFAULT_MAX_LON_SPAN_DEG + 1e-7
    ? true
    : expectedSpan < DEFAULT_MAX_LON_SPAN_DEG - 1e-7
      ? false
      : result.exceedsMaxSpanWarning;
  const pWarningThreshold =
    result.exceedsMaxSpanWarning === expectedWarn &&
    (result.warning !== null) === result.exceedsMaxSpanWarning;

  return {
    pValidRects,
    pDirectionInvariant,
    pSpanConserved,
    pSplitOnlyOnGenuineAntimeridian,
    pWarningThreshold,
  };
}

// --- Controllable Mock Worker for Transport Resilience Tests ---

class MockWorker implements WorkerLike {
  readonly received: WorkerRequest[] = [];
  terminated = false;
  private readonly messageListeners = new Set<
    (event: WorkerMessageEventLike<WorkerResponse>) => void
  >();
  private readonly errorListeners = new Set<(event: WorkerErrorEventLike) => void>();
  private readonly handler: (msg: WorkerRequest, worker: MockWorker) => void;

  constructor(handler: (msg: WorkerRequest, worker: MockWorker) => void) {
    this.handler = handler;
  }

  postMessage(message: unknown): void {
    if (this.terminated) {
      throw new Error('Cannot postMessage to terminated worker');
    }
    const req = message as WorkerRequest;
    this.received.push(req);
    this.handler(req, this);
  }

  emitResponse(response: WorkerResponse): void {
    if (this.terminated) {
      return;
    }
    for (const listener of [...this.messageListeners]) {
      listener({ data: response });
    }
  }

  emitError(errorEvent: WorkerErrorEventLike): void {
    if (this.terminated) {
      return;
    }
    for (const listener of [...this.errorListeners]) {
      listener(errorEvent);
    }
  }

  terminate(): void {
    this.terminated = true;
    this.messageListeners.clear();
    this.errorListeners.clear();
  }

  addEventListener(
    type: 'message' | 'error',
    listener:
      | ((event: WorkerMessageEventLike<WorkerResponse>) => void)
      | ((event: WorkerErrorEventLike) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.add(
        listener as (event: WorkerMessageEventLike<WorkerResponse>) => void,
      );
    } else {
      this.errorListeners.add(listener as (event: WorkerErrorEventLike) => void);
    }
  }

  removeEventListener(
    type: 'message' | 'error',
    listener:
      | ((event: WorkerMessageEventLike<WorkerResponse>) => void)
      | ((event: WorkerErrorEventLike) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.delete(
        listener as (event: WorkerMessageEventLike<WorkerResponse>) => void,
      );
    } else {
      this.errorListeners.delete(listener as (event: WorkerErrorEventLike) => void);
    }
  }
}

describe('Seam 2 — QueryBuilder & Conditional PBT P2', () => {
  const allPassageIds = catalog.passages.map((p) => p.id);

  it('Role 1: builds valid static disjunction Cypher for concrete scenarios, PROFILE wrapping, and same-waypoint short-circuit', () => {
    const defaultBlocked = getDefaultBlockedPassageIds(catalog);
    const openRoute = QueryBuilder.buildRouteQuery(catalog, defaultBlocked);
    expect(openRoute).toContain('reduce(km = 0.0, r IN relationships(p) | km + r.km)');
    expect(openRoute).toContain(':SEA_OPEN|PASSAGE_BABALMANDAB|');
    expect(openRoute).not.toContain('PASSAGE_NORTHWEST');
    expect(openRoute).not.toContain('|:');
    expect(evaluateQueryBuilderP2Oracle(openRoute, catalog, defaultBlocked)).toEqual({
      pSingleColonOnly: true,
      pNoEdgePropertyWhere: true,
      pExactOpenComplement: true,
    });

    const allBlockedRoute = QueryBuilder.buildRouteQuery(catalog, allPassageIds);
    expect(allBlockedRoute).toContain('[:SEA_OPEN*]');
    expect(evaluateQueryBuilderP2Oracle(allBlockedRoute, catalog, allPassageIds)).toEqual({
      pSingleColonOnly: true,
      pNoEdgePropertyWhere: true,
      pExactOpenComplement: true,
    });

    const isoQuery = QueryBuilder.buildIsolationQuery(catalog, ['northwest', 'ormuz']);
    expect(isoQuery).toContain('WHERE p2 <> hub');
    expect(isoQuery).not.toContain('PASSAGE_ORMUZ');
    expect(evaluateQueryBuilderP2Oracle(isoQuery, catalog, ['northwest', 'ormuz'])).toEqual({
      pSingleColonOnly: true,
      pNoEdgePropertyWhere: true,
      pExactOpenComplement: true,
    });

    const tradeQuery = QueryBuilder.buildTradeExposureForPortsQuery();
    expect(tradeQuery).toContain('(isolated:Port)-[:TRADES_WITH]->(c:Country)');
    expect(tradeQuery).not.toContain('LIMIT');

    const sameWpQuery = QueryBuilder.buildRouteQuery(catalog, defaultBlocked, {
      shortCircuitSameWaypoint: true,
    });
    expect(sameWpQuery).not.toContain('shortestPath');
    expect(sameWpQuery).toContain('0.0 AS totalKm');

    expect(QueryBuilder.wrapWithProfile('MATCH (n) RETURN n')).toBe('PROFILE MATCH (n) RETURN n');
    expect(QueryBuilder.wrapWithProfile('PROFILE MATCH (n) RETURN n')).toBe(
      'PROFILE MATCH (n) RETURN n',
    );
    expect(QueryBuilder.wrapWithProfile('EXPLAIN MATCH (n) RETURN n')).toBe(
      'PROFILE MATCH (n) RETURN n',
    );
    expect(() => QueryBuilder.wrapWithProfile('   ')).toThrow();
  });

  it('Role 2: P2 property guardian over arbitrary subsets of the 13 chokepoints', () => {
    let emptyBlockedCount = 0;
    let partialBlockedCount = 0;
    let allBlockedCount = 0;

    fc.assert(
      fc.property(fc.subarray(allPassageIds), (blockedIds) => {
        if (blockedIds.length === 0) emptyBlockedCount++;
        else if (blockedIds.length === allPassageIds.length) allBlockedCount++;
        else partialBlockedCount++;

        const queries = [
          QueryBuilder.buildRouteQuery(catalog, blockedIds),
          QueryBuilder.buildIsolationQuery(catalog, blockedIds),
        ];

        for (const cypher of queries) {
          const verdict = evaluateQueryBuilderP2Oracle(cypher, catalog, blockedIds);
          if (
            !verdict.pSingleColonOnly ||
            !verdict.pNoEdgePropertyWhere ||
            !verdict.pExactOpenComplement
          ) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 200 },
    );

    // Explicitly include exact boundary endpoints alongside random reachability witnesses.
    for (const edgeSubset of [[], allPassageIds]) {
      const q = QueryBuilder.buildRouteQuery(catalog, edgeSubset);
      const verdict = evaluateQueryBuilderP2Oracle(q, catalog, edgeSubset);
      expect(verdict).toEqual({
        pSingleColonOnly: true,
        pNoEdgePropertyWhere: true,
        pExactOpenComplement: true,
      });
    }
    expect(partialBlockedCount).toBeGreaterThan(0);
    expect(emptyBlockedCount + partialBlockedCount + allBlockedCount).toBe(200);
  });

  it('Role 3: P2 independent oracle calibration rejects each violation class individually', () => {
    const base = QueryBuilder.buildRouteQuery(catalog, ['northwest', 'suez']);

    // 1. Double-colon disjunction violation
    const doubleColonCypher = base.replace('|PASSAGE_PANAMA', '|:PASSAGE_PANAMA');
    const v1 = evaluateQueryBuilderP2Oracle(doubleColonCypher, catalog, ['northwest', 'suez']);
    expect(v1.pSingleColonOnly).toBe(false);

    // 2. Edge-property WHERE predicate inside shortestPath / relationships(p)
    const whereEdgeCypher = base.replace(
      'WHERE a <> b',
      "WHERE a <> b AND ALL(r IN relationships(p) WHERE r.passage <> 'suez')",
    );
    const v2 = evaluateQueryBuilderP2Oracle(whereEdgeCypher, catalog, ['northwest', 'suez']);
    expect(v2.pNoEdgePropertyWhere).toBe(false);

    // 3. Blocked passage relationship type leaked into disjunction
    const leakedSuezCypher = base.replace('[:SEA_OPEN|', '[:SEA_OPEN|PASSAGE_SUEZ|');
    const v3 = evaluateQueryBuilderP2Oracle(leakedSuezCypher, catalog, ['northwest', 'suez']);
    expect(v3.pExactOpenComplement).toBe(false);
  });
});

describe('Seam 2 — normalizeDragBBox & Conditional PBT P3', () => {
  it('Role 1: handles right-to-left Red Sea drags, genuine antimeridian splits, +180 boundary, and >120 deg warnings', () => {
    const redSeaUnproject = createLinearViewportUnprojector(20, 0.1, 45, 0.1, false);
    // Right-to-left drag across Red Sea: start at x=240 (44E) -> end at x=120 (32E).
    const rtl = normalizeDragBBox({ x: 240, y: 150 }, { x: 120, y: 300 }, redSeaUnproject);
    const ltr = normalizeDragBBox({ x: 120, y: 300 }, { x: 240, y: 150 }, redSeaUnproject);

    expect(rtl.crossesAntimeridian).toBe(false);
    expect(rtl.exceedsMaxSpanWarning).toBe(false);
    expect(rtl.warning).toBeNull();
    expect(rtl.rects).toHaveLength(1);
    expect(rtl.rects[0]?.swLon).toBeCloseTo(32, 6);
    expect(rtl.rects[0]?.neLon).toBeCloseTo(44, 6);
    expect(rtl.lonSpanDeg).toBeCloseTo(12, 6);
    expect(rtl.rects).toEqual(ltr.rects);

    // Genuine antimeridian crossing (unwrapped continuous projector: 170E -> 195E = -165W).
    const pacificContinuous = createLinearViewportUnprojector(150, 0.2, 65, 0.1, false);
    const fijiContinuous = normalizeDragBBox(
      { x: 100, y: 50 },
      { x: 225, y: 150 },
      pacificContinuous,
    );
    expect(fijiContinuous.crossesAntimeridian).toBe(true);
    expect(fijiContinuous.exceedsMaxSpanWarning).toBe(false);
    expect(fijiContinuous.lonSpanDeg).toBeCloseTo(25, 6);
    expect(fijiContinuous.rects).toEqual([
      { swLon: 170, swLat: 50, neLon: 180, neLat: 60 },
      { swLon: -180, swLat: 50, neLon: -165, neLat: 60 },
    ]);

    // Same antimeridian crossing with a wrapped [-180, 180) projector (170E -> -165W).
    const pacificWrapped = createLinearViewportUnprojector(150, 0.2, 65, 0.1, true);
    const fijiWrapped = normalizeDragBBox({ x: 225, y: 150 }, { x: 100, y: 50 }, pacificWrapped);
    expect(fijiWrapped.crossesAntimeridian).toBe(true);
    expect(fijiWrapped.lonSpanDeg).toBeCloseTo(25, 6);
    expect(fijiWrapped.rects).toEqual(fijiContinuous.rects);

    // Boundary: east edge lands exactly on +180 deg -> single box [160, 180], no degenerate second box.
    const exact180 = normalizeDragBBox({ x: 50, y: 50 }, { x: 150, y: 150 }, pacificContinuous);
    expect(exact180.crossesAntimeridian).toBe(false);
    expect(exact180.rects).toEqual([{ swLon: 160, swLat: 50, neLon: 180, neLat: 60 }]);

    // Wide span > 120 deg warns.
    const wide = normalizeDragBBox(
      { x: 0, y: 100 },
      { x: 700, y: 200 },
      createLinearViewportUnprojector(-20, 0.2, 40, 0.1, false),
    );
    expect(wide.lonSpanDeg).toBeCloseTo(140, 6);
    expect(wide.exceedsMaxSpanWarning).toBe(true);
    expect(wide.warning).toContain('140.0°');
  });

  it('Role 2: P3 property guardian over arbitrary screen drags & antimeridian viewports', () => {
    let rtlCount = 0;
    let crossingCount = 0;
    let nonCrossingCount = 0;
    let over120Count = 0;
    let under120Count = 0;

    fc.assert(
      fc.property(
        fc.double({ min: -360, max: 360, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.05, max: 0.6, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 400, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 400, noNaN: true, noDefaultInfinity: true }),
        (originLon, degPerPxX, x1, x2, y1, y2) => {
          const start: ScreenPoint = { x: x1, y: y1 };
          const end: ScreenPoint = { x: x2, y: y2 };
          if (x1 > x2) rtlCount++;

          const unproject = createLinearViewportUnprojector(originLon, degPerPxX, 60, 0.15, false);
          const result = normalizeDragBBox(start, end, unproject);
          const swapped = normalizeDragBBox(end, start, unproject);

          if (result.crossesAntimeridian) crossingCount++;
          else nonCrossingCount++;
          if (result.exceedsMaxSpanWarning) over120Count++;
          else under120Count++;

          const verdict = evaluateBBoxP3Oracle(
            start,
            end,
            originLon,
            degPerPxX,
            result,
            swapped,
          );
          if (
            !verdict.pValidRects ||
            !verdict.pDirectionInvariant ||
            !verdict.pSpanConserved ||
            !verdict.pSplitOnlyOnGenuineAntimeridian ||
            !verdict.pWarningThreshold
          ) {
            return false;
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );

    expect(rtlCount).toBeGreaterThan(0);
    expect(crossingCount).toBeGreaterThan(0);
    expect(nonCrossingCount).toBeGreaterThan(0);
    expect(over120Count).toBeGreaterThan(0);
    expect(under120Count).toBeGreaterThan(0);
  });

  it('Role 3: P3 oracle calibration rejects inverted RTL box, missing antimeridian split, and bad warning flag individually', () => {
    const start: ScreenPoint = { x: 240, y: 150 };
    const end: ScreenPoint = { x: 120, y: 300 };
    const unproject = createLinearViewportUnprojector(20, 0.1, 45, 0.1, false);
    const valid = normalizeDragBBox(start, end, unproject);
    const swapped = normalizeDragBBox(end, start, unproject);

    // 1. Simulated naive RTL bug: inverts [32, 44] into a 348-deg global split [44, 180] + [-180, 32]
    const invertedBug: DragBBoxResult = {
      ...valid,
      rects: [
        { swLon: 44, swLat: 15, neLon: 180, neLat: 30 },
        { swLon: -180, swLat: 15, neLon: 32, neLat: 30 },
      ],
      lonSpanDeg: 348,
      crossesAntimeridian: true,
      exceedsMaxSpanWarning: true,
      warning: 'wide',
    };
    const vInverted = evaluateBBoxP3Oracle(start, end, 20, 0.1, invertedBug, swapped);
    expect(vInverted.pSpanConserved).toBe(false);
    expect(vInverted.pSplitOnlyOnGenuineAntimeridian).toBe(false);
    expect(vInverted.pDirectionInvariant).toBe(false);

    // 2. Invalid rect with swLon > neLon (missing split)
    const invalidRectBug: DragBBoxResult = {
      ...valid,
      rects: [{ swLon: 170, swLat: 15, neLon: -165, neLat: 30 }],
    };
    const vInvalidRect = evaluateBBoxP3Oracle(start, end, 20, 0.1, invalidRectBug, swapped);
    expect(vInvalidRect.pValidRects).toBe(false);

    // 3. Wrong warning threshold
    const wrongWarnBug: DragBBoxResult = {
      ...valid,
      exceedsMaxSpanWarning: true,
      warning: 'spurious warning',
    };
    const vWarn = evaluateBBoxP3Oracle(start, end, 20, 0.1, wrongWarnBug, swapped);
    expect(vWarn.pWarningThreshold).toBe(false);
  });
});

describe('Seam 2 — ChokepointEngine on real @relate/relate-wasm@1.1.0 + canonical graph', () => {
  const defaultBlocked = getDefaultBlockedPassageIds(catalog);
  let engine: ChokepointEngine;
  let bootTelemetry: BootTelemetry;

  beforeAll(() => {
    initRelateWasmNode();
    engine = new ChokepointEngine(catalog);
    bootTelemetry = engine.boot(wasmPayload, 5000);
  });

  afterAll(() => {
    engine.dispose();
  });

  it('boots via 5,000-row chunked UNWIND and builds ONLINE POINT INDEXes on :WP(loc) and :Port(loc)', () => {
    expect(bootTelemetry.chunkSize).toBe(5000);
    expect(bootTelemetry.batchesExecuted).toBeGreaterThan(10);
    expect(bootTelemetry.pointIndexesOnline).toEqual(
      expect.arrayContaining(['wp_loc_idx', 'port_loc_idx']),
    );
    expect(bootTelemetry.counts).toEqual({
      waypoints: 10560,
      ports: 758,
      countries: 175,
      maritimeEdges: 16801,
      tradesWith: 6427,
    });
    const meta = engine.getMetadata();
    expect(meta.booted).toBe(true);
    expect(meta.portCount).toBe(758);
    expect(meta.dirtyCustomBoxes).toBe(false);
  });

  it('runs single-pair BFS (<100 ms) with route geometry and Suez detour', () => {
    const t0 = performance.now();
    const open = engine.queryRoute('TWKHH', 'NLRTM', defaultBlocked);
    const openElapsed = performance.now() - t0;

    expect(openElapsed).toBeLessThan(100);
    expect(open.isolated).toBe(false);
    expect(open.shortCircuited).toBe(false);
    expect(open.hops).toBe(126);
    expect(open.totalKm).toBe(19882.1);
    expect(open.nodeIds.length).toBeGreaterThan(2);
    expect(open.coords.length).toBe(open.hops! + 1);
    expect(open.segments.length).toBeGreaterThanOrEqual(1);
    expect(open.passagesTraversed).toContain('suez');
    expect(typeof open.telemetry.executeMs).toBe('number');

    const t1 = performance.now();
    const suezBlocked = engine.queryRoute('TWKHH', 'NLRTM', [...defaultBlocked, 'suez']);
    const blockedElapsed = performance.now() - t1;

    expect(blockedElapsed).toBeLessThan(100);
    expect(suezBlocked.isolated).toBe(false);
    expect(suezBlocked.totalKm).not.toBeNull();
    expect(suezBlocked.totalKm!).toBeGreaterThan(25000);
    expect(suezBlocked.passagesTraversed).toContain('south_africa');
    expect(suezBlocked.passagesTraversed).not.toContain('suez');
  });

  it('short-circuits same-port and same-waypoint O-D pairs to 0 km without triggering ShortestPathCommonEndNodes', () => {
    const samePort = engine.queryRoute('TWKHH', 'TWKHH', defaultBlocked);
    expect(samePort.shortCircuited).toBe(true);
    expect(samePort.isolated).toBe(false);
    expect(samePort.hops).toBe(0);
    expect(samePort.totalKm).toBe(0);
    expect(samePort.edgeIds).toEqual([]);
    expect(samePort.coords).toHaveLength(1);

    // SGSIN and MYJOB both snap to wp_103.763466_1.259893 in the canonical graph.
    const sameWaypoint = engine.queryRoute('SGSIN', 'MYJOB', defaultBlocked);
    expect(sameWaypoint.shortCircuited).toBe(true);
    expect(sameWaypoint.isolated).toBe(false);
    expect(sameWaypoint.hops).toBe(0);
    expect(sameWaypoint.totalKm).toBe(0);
    expect(sameWaypoint.edgeIds).toEqual([]);
    expect(sameWaypoint.coords).toHaveLength(2);
  });

  it('runs 1-to-ALL isolation and TRADES_WITH exposure (<1,500 ms) matching canonical baselines for all 3 presets', () => {
    // 1. Hormuz: 20 isolated ports + partner country exposure ranking
    const t0 = performance.now();
    const hormuz = engine.evaluateScenario({
      blockedPassageIds: [...defaultBlocked, 'ormuz'],
      routeFrom: 'AEJEA',
      routeTo: 'ITGOA',
    });
    const hormuzElapsed = performance.now() - t0;

    expect(hormuzElapsed).toBeLessThan(1500);
    expect(hormuz.route?.isolated).toBe(true);
    expect(hormuz.isolation?.isolatedCount).toBe(20);
    expect(hormuz.isolation?.isolatedPorts.map((p) => p.code)).toContain('AEJEA');
    expect(hormuz.tradeExposure?.countries[0]).toEqual({
      countryCode: 'AE',
      countryName: 'United Arab Emirates',
      exposedPorts: 11,
    });
    // Trade exposure returns all exposed partner countries without premature truncation.
    expect(hormuz.tradeExposure?.countries.length).toBeGreaterThan(15);

    // 2. Suez + Bab el-Mandeb: 9 isolated Red Sea ports
    const t1 = performance.now();
    const redSea = engine.evaluateScenario({
      blockedPassageIds: [...defaultBlocked, 'suez', 'babalmandab'],
    });
    const redSeaElapsed = performance.now() - t1;

    expect(redSeaElapsed).toBeLessThan(1500);
    expect(redSea.isolation?.isolatedCount).toBe(9);
    expect(redSea.isolation?.isolatedPorts.map((p) => p.code)).toEqual(
      expect.arrayContaining(['SAJED', 'JOAQB', 'YEHOD']),
    );

    // 3. Gibraltar + Suez: 103 isolated Mediterranean + Black Sea ports
    const t2 = performance.now();
    const med = engine.evaluateScenario({
      blockedPassageIds: [...defaultBlocked, 'gibraltar', 'suez'],
    });
    const medElapsed = performance.now() - t2;

    expect(medElapsed).toBeLessThan(1500);
    expect(med.isolation?.isolatedCount).toBe(103);
    expect(med.isolation?.isolatedPorts.map((p) => p.code)).toEqual(
      expect.arrayContaining(['ESVLC', 'ITGOA', 'EGPSD']),
    );
    expect(med.tradeExposure?.countries.length).toBeGreaterThan(5);
  });

  it('handles 0-edge custom bbox without mutating, deletes edges for Suez bbox to force detour, and restores 19882.1 km on reset', () => {
    // 0-edge Sahara inland box must NOT mutate the graph.
    const zeroHit = engine.applyCustomBoxes([
      {
        id: 'box-sahara',
        rects: [{ swLon: 10, swLat: 20, neLon: 15, neLat: 25 }],
      },
    ]);
    expect(zeroHit.matchedEdgeCount).toBe(0);
    expect(zeroHit.deletedEdgeCount).toBe(0);
    expect(zeroHit.mutated).toBe(false);
    expect(zeroHit.reseeded).toBe(false);
    expect(engine.getMetadata().dirtyCustomBoxes).toBe(false);

    // Real Suez corridor box deletes maritime segments and forces Cape detour.
    const suezHit = engine.applyCustomBoxes([
      {
        id: 'box-suez',
        rects: [{ swLon: 32.0, swLat: 28.0, neLon: 34.5, neLat: 31.5 }],
      },
    ]);
    expect(suezHit.matchedEdgeCount).toBeGreaterThan(0);
    expect(suezHit.deletedEdgeCount).toBe(suezHit.matchedEdgeCount);
    expect(suezHit.mutated).toBe(true);
    expect(engine.getMetadata().dirtyCustomBoxes).toBe(true);

    const detoured = engine.queryRoute('TWKHH', 'NLRTM', defaultBlocked);
    expect(detoured.isolated).toBe(false);
    expect(detoured.totalKm!).toBeGreaterThan(25000);
    expect(detoured.passagesTraversed).toContain('south_africa');
    expect(detoured.passagesTraversed).not.toContain('suez');

    // Removing all custom boxes cleanly re-seeds :memory: state and restores baseline 19882.1 km.
    const reset = engine.applyCustomBoxes([]);
    expect(reset.reseeded).toBe(true);
    expect(reset.activeBoxCount).toBe(0);
    expect(engine.getMetadata().dirtyCustomBoxes).toBe(false);

    const restored = engine.queryRoute('TWKHH', 'NLRTM', defaultBlocked);
    expect(restored.hops).toBe(126);
    expect(restored.totalKm).toBe(19882.1);
    expect(restored.passagesTraversed).toContain('suez');
  });

  it('applies antimeridian-split custom boxes and preserves remaining boxes on partial removal', () => {
    const beringSplitBox = {
      id: 'box-bering-split',
      rects: [
        { swLon: 175.0, swLat: 50.0, neLon: 180.0, neLat: 70.0 },
        { swLon: -180.0, swLat: 50.0, neLon: -165.0, neLat: 70.0 },
      ],
    };
    const suezBox = {
      id: 'box-suez-extra',
      rects: [{ swLon: 32.0, swLat: 28.0, neLon: 34.5, neLat: 31.5 }],
    };

    try {
      const both = engine.applyCustomBoxes([beringSplitBox, suezBox]);
      expect(both.mutated).toBe(true);
      expect(both.activeBoxIds).toEqual(['box-bering-split', 'box-suez-extra']);
      expect(both.boxMatches[0]?.matchedEdgeCount).toBeGreaterThan(0);
      expect(both.boxMatches[1]?.matchedEdgeCount).toBeGreaterThan(0);

      // Removing suezBox while keeping beringSplitBox re-seeds and restores Suez route.
      const partial = engine.applyCustomBoxes([beringSplitBox]);
      expect(partial.reseeded).toBe(true);
      expect(partial.activeBoxIds).toEqual(['box-bering-split']);
      const route = engine.queryRoute('TWKHH', 'NLRTM', defaultBlocked);
      expect(route.totalKm).toBe(19882.1);
    } finally {
      engine.applyCustomBoxes([]);
    }
  });

  it('supports Live Cypher with PROFILE telemetry and surfaces malformed Cypher errors without breaking subsequent queries', () => {
    const valid = engine.runCustomCypher(
      'MATCH (p:Port {code: $code}) RETURN p.code AS code, p.name AS name',
      { code: 'TWKHH' },
      { profile: true },
    );
    expect(valid.ok).toBe(true);
    expect(valid.error).toBeNull();
    expect(valid.cypher.startsWith('PROFILE ')).toBe(true);
    expect(valid.rows).toEqual([{ code: 'TWKHH', name: 'Kaohsiung' }]);
    expect(typeof valid.telemetry.executeMs).toBe('number');
    expect(typeof valid.telemetry.elapsedMs).toBe('number');
    expect(typeof valid.telemetry.planCache).toBe('string');
    expect(valid.telemetry.plan).toMatchObject({ profiled: true });

    const malformedCypher = 'MATCH (p:Port RETURN p.code';
    const malformed = engine.runCustomCypher(malformedCypher);
    expect(malformed.ok).toBe(false);
    expect(malformed.error).not.toBeNull();
    expect(malformed.error!).toMatch(/syntax error/i);
    expect(malformed.cypher).toBe(malformedCypher);
    expect(malformed.rows).toEqual([]);

    // Subsequent valid query on the same engine instance still succeeds.
    const recovery = engine.runCustomCypher('RETURN 1 + 1 AS sum');
    expect(recovery.ok).toBe(true);
    expect(recovery.rows).toEqual([{ sum: 2 }]);

    // Unknown port code surfaces RelateQueryError with offending query and telemetry.
    expect(() => engine.queryRoute('ZZZZZ', 'NLRTM', defaultBlocked)).toThrow(RelateQueryError);
  });
});

describe('Seam 2 — ChokepointWorkerClient transport & recovery resilience', () => {
  it('discards stale overlapping scenario responses and never overwrites newer state (F1.1)', async () => {
    const mockWorker = new MockWorker((msg, worker) => {
      if (msg.type === 'evaluateScenario') {
        const isFirst = msg.request.blockedPassageIds.includes('suez');
        const delayMs = isFirst ? 50 : 5;
        setTimeout(() => {
          worker.emitResponse({
            type: 'result',
            id: msg.id,
            data: {
              blockedPassageIds: msg.request.blockedPassageIds,
              openRelTypes: ['SEA_OPEN'],
              customBoxResult: null,
              route: null,
              isolation: null,
              tradeExposure: null,
              totalElapsedMs: delayMs,
            },
          });
        }, delayMs);
      }
    });

    const client = new ChokepointWorkerClient({
      workerFactory: () => mockWorker,
      timeoutMs: 2000,
    });

    try {
      const stalePromise = client.evaluateScenario({
        blockedPassageIds: ['northwest', 'suez'],
      });
      const freshPromise = client.evaluateScenario({
        blockedPassageIds: ['northwest', 'ormuz'],
      });

      await expect(stalePromise).rejects.toThrow(StaleRequestError);
      const freshResult = await freshPromise;
      expect(freshResult.blockedPassageIds).toEqual(['northwest', 'ormuz']);

      // Wait past the stale response timer to confirm it is discarded cleanly without errors.
      await new Promise((r) => setTimeout(r, 80));
      expect(client.getStats().discardedStaleCount).toBe(1);
      expect(client.getStats().pendingCount).toBe(0);
    } finally {
      client.dispose();
    }
  });

  it('rejects in-flight queries on dispose() and starts no post-close work (F1.11)', async () => {
    let workersSpawned = 0;
    const workers: MockWorker[] = [];
    const client = new ChokepointWorkerClient({
      workerFactory: () => {
        workersSpawned++;
        const w = new MockWorker(() => {
          // Intentionally stay in-flight until disposed.
        });
        workers.push(w);
        return w;
      },
      timeoutMs: 5000,
    });

    const inflight = client.runCustomCypher('MATCH (n) RETURN count(n)');
    expect(workersSpawned).toBe(1);
    client.dispose();

    await expect(inflight).rejects.toThrow(WorkerDisposedError);
    expect(workers[0]?.terminated).toBe(true);
    expect(client.getStats().disposed).toBe(true);
    expect(client.getStats().pendingCount).toBe(0);

    // Subsequent calls after dispose must reject immediately without spawning new workers.
    await expect(client.runCustomCypher('RETURN 1')).rejects.toThrow(WorkerDisposedError);
    expect(workersSpawned).toBe(1);
  });

  it('enforces timeout watchdog by terminating hung worker and auto-recovering on next query (F4.1)', async () => {
    const spawned: MockWorker[] = [];
    const client = new ChokepointWorkerClient({
      workerFactory: () => {
        const workerIdx = spawned.length;
        const w = new MockWorker((msg, worker) => {
          if (msg.type === 'boot') {
            queueMicrotask(() => {
              worker.emitResponse({
                type: 'result',
                id: msg.id,
                data: {
                  bootMs: 1,
                  batchesExecuted: 1,
                  chunkSize: 5000,
                  pointIndexesOnline: ['wp_loc_idx'],
                  totalIndexesOnline: 1,
                  counts: { waypoints: 1, ports: 1, countries: 1, maritimeEdges: 1, tradesWith: 0 },
                },
              });
            });
            return;
          }
          // First worker hangs on query; second (respawned) worker responds normally.
          if (workerIdx === 0) {
            return;
          }
          queueMicrotask(() => {
            worker.emitResponse({
              type: 'result',
              id: msg.id,
              data: {
                ok: true,
                cypher: msg.type === 'runCustomCypher' ? msg.cypher : '',
                params: null,
                columns: ['ok'],
                columnTypes: ['INTEGER'],
                rows: [{ ok: 1 }],
                error: null,
                telemetry: {
                  elapsedMs: 1,
                  executeMs: 1,
                  planCache: 'miss',
                  plan: null,
                  notifications: [],
                  stats: {},
                },
              },
            });
          });
        });
        spawned.push(w);
        return w;
      },
      timeoutMs: 40,
    });

    try {
      await client.boot({ payloadUrl: '/data/graph.wasm.json' }, { timeoutMs: 500 });
      const hungCypher = 'MATCH (a)-[*]-(b) RETURN count(*)';
      await expect(client.runCustomCypher(hungCypher)).rejects.toThrow(WorkerTimeoutError);
      expect(spawned[0]?.terminated).toBe(true);
      expect(client.getStats().respawnCount).toBe(1);

      // Next query runs on cleanly respawned and rebooted worker.
      const recovered = await client.runCustomCypher('RETURN 1 AS ok');
      expect(recovered.ok).toBe(true);
      expect(recovered.rows).toEqual([{ ok: 1 }]);
      expect(spawned.length).toBe(2);
      expect(spawned[1]?.received.some((m) => m.type === 'boot')).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it('increments respawnCount on non-trap worker error events without double-counting', async () => {
    const spawned: MockWorker[] = [];
    const client = new ChokepointWorkerClient({
      workerFactory: () => {
        const w = new MockWorker((msg, worker) => {
          if (msg.type === 'boot') {
            queueMicrotask(() => {
              worker.emitResponse({
                type: 'result',
                id: msg.id,
                data: {
                  bootMs: 1,
                  batchesExecuted: 1,
                  chunkSize: 5000,
                  pointIndexesOnline: ['wp_loc_idx'],
                  totalIndexesOnline: 1,
                  counts: { waypoints: 1, ports: 1, countries: 1, maritimeEdges: 1, tradesWith: 0 },
                },
              });
            });
            return;
          }
          queueMicrotask(() => {
            worker.emitResponse({
              type: 'result',
              id: msg.id,
              data: {
                ok: true,
                cypher: msg.type === 'runCustomCypher' ? msg.cypher : '',
                params: null,
                columns: ['ok'],
                columnTypes: ['INTEGER'],
                rows: [{ ok: 1 }],
                error: null,
                telemetry: {
                  elapsedMs: 1,
                  executeMs: 1,
                  planCache: 'miss',
                  plan: null,
                  notifications: [],
                  stats: {},
                },
              },
            });
          });
        });
        spawned.push(w);
        return w;
      },
      timeoutMs: 2000,
    });

    try {
      await client.boot({ payloadUrl: '/data/graph.wasm.json' });
      expect(client.getStats().respawnCount).toBe(0);

      spawned[0]?.emitError({ message: 'Script load failure' });
      expect(spawned[0]?.terminated).toBe(true);
      expect(client.getStats().respawnCount).toBe(1);
      expect(client.getStats().hasLiveWorker).toBe(false);

      const recovered = await client.runCustomCypher('RETURN 1 AS ok');
      expect(recovered.ok).toBe(true);
      expect(spawned.length).toBe(2);
      expect(client.getStats().respawnCount).toBe(1);
    } finally {
      client.dispose();
    }
  });

  it('triggers worker termination and respawn when a superseded request replies with a WASM trap', async () => {
    const spawned: MockWorker[] = [];
    let firstRequestId: number | null = null;
    const client = new ChokepointWorkerClient({
      workerFactory: () => {
        const workerIdx = spawned.length;
        const w = new MockWorker((msg, worker) => {
          if (msg.type === 'boot') {
            queueMicrotask(() => {
              worker.emitResponse({
                type: 'result',
                id: msg.id,
                data: {
                  bootMs: 1,
                  batchesExecuted: 1,
                  chunkSize: 5000,
                  pointIndexesOnline: ['wp_loc_idx'],
                  totalIndexesOnline: 1,
                  counts: { waypoints: 1, ports: 1, countries: 1, maritimeEdges: 1, tradesWith: 0 },
                },
              });
            });
            return;
          }

          if (workerIdx === 0 && msg.type === 'evaluateScenario') {
            if (firstRequestId === null) {
              firstRequestId = msg.id;
              return;
            }
            // Request B superseded A; now A's delayed WASM trap arrives from the poisoned worker.
            const trappedId = firstRequestId;
            queueMicrotask(() => {
              worker.emitResponse({
                type: 'error',
                id: trappedId,
                message: 'RuntimeError: unreachable executed in relate_bg.wasm',
                wasmTrap: true,
                cypher: 'MATCH (a)-[*]-(b) RETURN a',
                telemetry: null,
              });
            });
            return;
          }

          queueMicrotask(() => {
            worker.emitResponse({
              type: 'result',
              id: msg.id,
              data: {
                ok: true,
                cypher: msg.type === 'runCustomCypher' ? msg.cypher : '',
                params: null,
                columns: ['alive'],
                columnTypes: ['BOOLEAN'],
                rows: [{ alive: true }],
                error: null,
                telemetry: {
                  elapsedMs: 1,
                  executeMs: 1,
                  planCache: 'miss',
                  plan: null,
                  notifications: [],
                  stats: {},
                },
              },
            });
          });
        });
        spawned.push(w);
        return w;
      },
      timeoutMs: 2000,
    });

    try {
      await client.boot({ payloadUrl: '/data/graph.wasm.json' });
      const reqA = client.evaluateScenario({ blockedPassageIds: ['northwest', 'suez'] });
      const reqB = client.evaluateScenario({ blockedPassageIds: ['northwest', 'ormuz'] });

      await expect(reqA).rejects.toThrow(StaleRequestError);
      await expect(reqB).rejects.toThrow(WasmTrapError);
      expect(spawned[0]?.terminated).toBe(true);
      expect(client.getStats().respawnCount).toBe(1);

      const followUp = await client.runCustomCypher('RETURN true AS alive');
      expect(followUp.ok).toBe(true);
      expect(followUp.rows).toEqual([{ alive: true }]);
      expect(spawned.length).toBe(2);
      expect(spawned[1]?.terminated).toBe(false);
      expect(spawned[1]?.received.some((m) => m.type === 'boot')).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it('uses lastBootTimeoutMs during auto-respawn and cleans up unbooted worker when respawn boot fails', async () => {
    const spawned: MockWorker[] = [];
    let releaseWorker1BootError: (() => void) | null = null;
    const client = new ChokepointWorkerClient({
      workerFactory: () => {
        const workerIdx = spawned.length;
        const w = new MockWorker((msg, worker) => {
          if (msg.type === 'boot') {
            if (workerIdx === 1) {
              // Transient HTTP 503 failure during first auto-respawn attempt, triggered deterministically.
              releaseWorker1BootError = () => {
                worker.emitResponse({
                  type: 'error',
                  id: msg.id,
                  message: 'HTTP 503 Service Unavailable fetching graph.wasm.json',
                  wasmTrap: false,
                  cypher: null,
                  telemetry: null,
                });
              };
              return;
            }
            // Worker 2 boots slower (70ms) than query timeoutMs (40ms) but within boot timeoutMs (400ms).
            const bootDelayMs = workerIdx === 2 ? 70 : 1;
            setTimeout(() => {
              worker.emitResponse({
                type: 'result',
                id: msg.id,
                data: {
                  bootMs: bootDelayMs,
                  batchesExecuted: 1,
                  chunkSize: 5000,
                  pointIndexesOnline: ['wp_loc_idx'],
                  totalIndexesOnline: 1,
                  counts: { waypoints: 1, ports: 1, countries: 1, maritimeEdges: 1, tradesWith: 0 },
                },
              });
            }, bootDelayMs);
            return;
          }

          if (workerIdx === 0 && msg.type === 'runCustomCypher') {
            queueMicrotask(() => {
              worker.emitResponse({
                type: 'error',
                id: msg.id,
                message: 'RuntimeError: unreachable executed',
                wasmTrap: true,
                cypher: msg.cypher,
                telemetry: null,
              });
            });
            return;
          }

          queueMicrotask(() => {
            worker.emitResponse({
              type: 'result',
              id: msg.id,
              data: {
                ok: true,
                cypher: msg.type === 'runCustomCypher' ? msg.cypher : '',
                params: null,
                columns: ['ok'],
                columnTypes: ['INTEGER'],
                rows: [{ ok: 1 }],
                error: null,
                telemetry: {
                  elapsedMs: 1,
                  executeMs: 1,
                  planCache: 'miss',
                  plan: null,
                  notifications: [],
                  stats: {},
                },
              },
            });
          });
        });
        spawned.push(w);
        return w;
      },
      timeoutMs: 40,
    });

    try {
      await client.boot({ payloadUrl: '/data/graph.wasm.json' }, { timeoutMs: 400 });
      await expect(client.runCustomCypher('MATCH (n) RETURN n')).rejects.toThrow(WasmTrapError);
      expect(releaseWorker1BootError).not.toBeNull();

      // First post-trap call awaits the failing auto-respawn boot (HTTP 503).
      const failedCall = client.runCustomCypher('RETURN 1 AS ok');
      releaseWorker1BootError!();
      await expect(failedCall).rejects.toThrow(/HTTP 503/);
      // Failed unbooted worker #1 must be terminated so client knows no live worker exists.
      expect(spawned[1]?.terminated).toBe(true);
      expect(client.getStats().hasLiveWorker).toBe(false);

      // Next call retries auto-respawn with lastBootTimeoutMs (400ms > 70ms > query 40ms) and succeeds.
      const recovered = await client.runCustomCypher('RETURN 1 AS ok');
      expect(recovered.ok).toBe(true);
      expect(recovered.rows).toEqual([{ ok: 1 }]);
      expect(spawned.length).toBe(3);
      expect(spawned[2]?.terminated).toBe(false);
    } finally {
      client.dispose();
    }
  });

  it('catches isWasmTrap, terminates poisoned worker, surfaces triggering Cypher, and auto-respawns cleanly (F4.2, F4.5)', async () => {
    const spawned: MockWorker[] = [];

    const client = new ChokepointWorkerClient({
      workerFactory: () => {
        const workerIdx = spawned.length;
        const w = new MockWorker((msg, worker) => {
          if (msg.type === 'boot') {
            queueMicrotask(() => {
              worker.emitResponse({
                type: 'result',
                id: msg.id,
                data: {
                  bootMs: 2,
                  batchesExecuted: 1,
                  chunkSize: 5000,
                  pointIndexesOnline: ['wp_loc_idx', 'port_loc_idx'],
                  totalIndexesOnline: 5,
                  counts: { waypoints: 1, ports: 1, countries: 1, maritimeEdges: 1, tradesWith: 0 },
                },
              });
            });
            return;
          }

          if (workerIdx === 0 && msg.type === 'runCustomCypher') {
            queueMicrotask(() => {
              worker.emitResponse({
                type: 'error',
                id: msg.id,
                message: 'RuntimeError: unreachable executed in relate_bg.wasm',
                wasmTrap: true,
                cypher: msg.cypher,
                telemetry: null,
              });
            });
            return;
          }

          queueMicrotask(() => {
            worker.emitResponse({
              type: 'result',
              id: msg.id,
              data: {
                ok: true,
                cypher: msg.type === 'runCustomCypher' ? msg.cypher : '',
                params: null,
                columns: ['alive'],
                columnTypes: ['BOOLEAN'],
                rows: [{ alive: true }],
                error: null,
                telemetry: {
                  elapsedMs: 1.2,
                  executeMs: 0.8,
                  planCache: 'miss',
                  plan: null,
                  notifications: [],
                  stats: {},
                },
              },
            });
          });
        });
        spawned.push(w);
        return w;
      },
      timeoutMs: 2000,
    });

    try {
      await client.boot({ payloadUrl: '/data/graph.wasm.json' });
      const offendingCypher = 'MATCH p = shortestPath((a)-[*]->(b)) RETURN p';

      let caught: unknown = null;
      try {
        await client.runCustomCypher(offendingCypher);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(WasmTrapError);
      expect((caught as WasmTrapError).cypher).toBe(offendingCypher);
      expect(spawned[0]?.terminated).toBe(true);
      expect(client.getStats().respawnCount).toBe(1);

      // Subsequent valid query runs on the auto-respawned, re-booted clean worker and succeeds.
      const afterRespawn = await client.runCustomCypher('RETURN true AS alive');
      expect(afterRespawn.ok).toBe(true);
      expect(afterRespawn.rows).toEqual([{ alive: true }]);
      expect(spawned.length).toBe(2);
      expect(spawned[1]?.terminated).toBe(false);
      expect(spawned[1]?.received.some((m) => m.type === 'boot')).toBe(true);
    } finally {
      client.dispose();
    }
  });
});

describe('Seam 2 — Static architecture guard (zero OPFS in src/engine/)', () => {
  it('contains zero opfs:// strings, zero @relate/relate-wasm/opfs imports, and zero RelateDb.open calls', () => {
    const forbiddenRe = /opfs:\/\/|@relate\/relate-wasm\/opfs|RelateDb\.open\s*\(/;
    // Positive control: ensure our matcher catches every forbidden pattern.
    expect(forbiddenRe.test("RelateDb.open('opfs://maritime')")).toBe(true);
    expect(forbiddenRe.test("import '@relate/relate-wasm/opfs.js'")).toBe(true);

    const engineDir = resolve(ROOT_DIR, 'src/engine');
    const files = readdirSync(engineDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(5);

    for (const file of files) {
      const content = readFileSync(resolve(engineDir, file), 'utf8');
      expect(forbiddenRe.test(content), `Forbidden OPFS pattern found in src/engine/${file}`).toBe(
        false,
      );
    }
  });
});
