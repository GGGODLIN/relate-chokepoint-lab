import { RelateDb } from '@relate/relate-wasm';
import {
  getBundledCatalog,
  getOpenRelTypes,
  type ChokepointCatalog,
} from '../contracts/catalog.ts';
import type { WasmGraphPayload } from '../etl/build-graph.ts';
import { splitAntimeridianLine, type LonLat } from '../etl/geo.ts';
import {
  DEFAULT_UNWIND_CHUNK_SIZE,
  loadWasmGraphPayloadIntoRelateDb,
} from '../etl/relate-loader.ts';
import type { BBoxRect } from './bbox.ts';
import {
  extractTelemetry,
  parseRelateEnvelope,
  type ParsedRelateEnvelope,
  type QueryTelemetry,
} from './envelope.ts';
import {
  DEFAULT_BBOX_EDGE_LIMIT,
  QueryBuilder,
} from './query-builder.ts';

export interface PortRecord {
  readonly code: string;
  readonly name: string;
  readonly country: string;
  readonly lon: number;
  readonly lat: number;
  readonly snapWpId: string;
  readonly snapDistKm: number;
  readonly wpDistKm: number;
  readonly tradeDegree: number;
  readonly rank: number;
  readonly isCuratedHub: boolean;
}

export interface GraphCountsSummary {
  readonly waypoints: number;
  readonly ports: number;
  readonly countries: number;
  readonly maritimeEdges: number;
  readonly tradesWith: number;
}

export interface BootTelemetry {
  readonly bootMs: number;
  readonly batchesExecuted: number;
  readonly chunkSize: number;
  readonly pointIndexesOnline: readonly string[];
  readonly totalIndexesOnline: number;
  readonly counts: GraphCountsSummary;
}

export interface CustomBBoxInput {
  readonly id: string;
  readonly rects: readonly BBoxRect[];
}

export interface CustomBBoxMatchSummary {
  readonly boxId: string;
  readonly matchedEdgeIds: readonly string[];
  readonly matchedEdgeCount: number;
  readonly truncated: boolean;
}

export interface CustomBBoxApplyResult {
  readonly matchedEdgeCount: number;
  readonly deletedEdgeCount: number;
  readonly mutated: boolean;
  readonly reseeded: boolean;
  readonly reseedMs: number | null;
  readonly activeBoxCount: number;
  readonly activeBoxIds: readonly string[];
  readonly truncated: boolean;
  readonly boxMatches: readonly CustomBBoxMatchSummary[];
  readonly cypher: string | null;
  readonly telemetry: QueryTelemetry | null;
}

export interface RouteEvaluationResult {
  readonly fromCode: string;
  readonly toCode: string;
  readonly hops: number | null;
  readonly totalKm: number | null;
  readonly isolated: boolean;
  readonly shortCircuited: boolean;
  readonly coords: readonly [number, number][];
  readonly segments: readonly (readonly [number, number][])[];
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly passagesTraversed: readonly string[];
  readonly cypher: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly telemetry: QueryTelemetry;
}

export interface IsolatedPortRecord {
  readonly code: string;
  readonly name: string;
  readonly country: string;
  readonly lon: number;
  readonly lat: number;
  readonly rank: number;
  readonly tradeDegree: number;
}

export interface IsolationEvaluationResult {
  readonly referenceHubCode: string;
  readonly totalPorts: number;
  readonly reachablePorts: number;
  readonly isolatedCount: number;
  readonly isolatedPorts: readonly IsolatedPortRecord[];
  readonly cypher: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly telemetry: QueryTelemetry;
}

export interface TradeExposureRecord {
  readonly countryCode: string;
  readonly countryName: string;
  readonly exposedPorts: number;
}

export interface TradeExposureEvaluationResult {
  readonly countries: readonly TradeExposureRecord[];
  readonly cypher: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly telemetry: QueryTelemetry | null;
}

export interface ScenarioEvaluationRequest {
  readonly blockedPassageIds: readonly string[];
  readonly routeFrom?: string;
  readonly routeTo?: string;
  readonly profile?: boolean;
}

export interface ScenarioEvaluationResult {
  readonly blockedPassageIds: readonly string[];
  readonly openRelTypes: readonly string[];
  readonly route: RouteEvaluationResult | null;
  readonly isolation: IsolationEvaluationResult | null;
  readonly tradeExposure: TradeExposureEvaluationResult | null;
  readonly totalElapsedMs: number;
}

export interface CypherExecutionResult {
  readonly ok: boolean;
  readonly cypher: string;
  readonly params: Readonly<Record<string, unknown>> | null;
  readonly columns: readonly string[];
  readonly columnTypes: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly error: string | null;
  readonly telemetry: QueryTelemetry;
}

export interface EngineMetadata {
  readonly booted: boolean;
  readonly bootTelemetry: BootTelemetry | null;
  readonly dirtyCustomBoxes: boolean;
  readonly activeBoxIds: readonly string[];
  readonly deletedCustomEdgeCount: number;
  readonly portCount: number;
  readonly catalog: ChokepointCatalog;
}

export class RelateQueryError extends Error {
  readonly cypher: string;
  readonly params: Readonly<Record<string, unknown>> | null;
  readonly relateError: string;
  readonly telemetry: QueryTelemetry;

  constructor(
    relateError: string,
    cypher: string,
    params: Readonly<Record<string, unknown>> | null,
    telemetry: QueryTelemetry,
  ) {
    super(`Relate query error: ${relateError}`);
    this.name = 'RelateQueryError';
    this.relateError = relateError;
    this.cypher = cypher;
    this.params = params;
    this.telemetry = telemetry;
  }
}

function parseCoords(raw: unknown): [number, number][] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const coords: [number, number][] = [];
  for (const item of raw) {
    if (
      Array.isArray(item) &&
      item.length >= 2 &&
      typeof item[0] === 'number' &&
      typeof item[1] === 'number' &&
      Number.isFinite(item[0]) &&
      Number.isFinite(item[1])
    ) {
      coords.push([item[0], item[1]]);
    }
  }
  return coords;
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === 'string');
}

function requireFiniteNumber(
  row: Record<string, unknown>,
  field: string,
  cypher: string,
  params: Readonly<Record<string, unknown>>,
  telemetry: QueryTelemetry,
): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RelateQueryError(
      `Expected finite numeric column "${field}" in row ${JSON.stringify(row)}`,
      cypher,
      params,
      telemetry,
    );
  }
  return value;
}

function requireString(
  row: Record<string, unknown>,
  field: string,
  cypher: string,
  params: Readonly<Record<string, unknown>>,
  telemetry: QueryTelemetry,
): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new RelateQueryError(
      `Expected string column "${field}" in row ${JSON.stringify(row)}`,
      cypher,
      params,
      telemetry,
    );
  }
  return value;
}

export class ChokepointEngine {
  private readonly catalog: ChokepointCatalog;
  private readonly relTypeToPassageId: ReadonlyMap<string, string>;

  private db: RelateDb | null = null;
  private payload: WasmGraphPayload | null = null;
  private chunkSize = DEFAULT_UNWIND_CHUNK_SIZE;
  private bootTelemetry: BootTelemetry | null = null;
  private portsByCode = new Map<string, PortRecord>();
  private dirtyCustomBoxes = false;
  private activeCustomBoxes: CustomBBoxInput[] = [];
  private deletedCustomEdgeIds = new Set<string>();

  constructor(catalog: ChokepointCatalog = getBundledCatalog()) {
    this.catalog = catalog;
    this.relTypeToPassageId = new Map(
      this.catalog.passages.map((entry) => [entry.relType, entry.id]),
    );
  }

  private requireDb(): RelateDb {
    if (this.db === null) {
      throw new Error('ChokepointEngine has not been booted; call boot(payload) first.');
    }
    return this.db;
  }

  private freeDb(): void {
    if (this.db !== null) {
      const current = this.db;
      this.db = null;
      current.free();
    }
  }

  private executeRaw(
    cypher: string,
    params: Readonly<Record<string, unknown>> | null,
  ): ParsedRelateEnvelope {
    const db = this.requireDb();
    const paramsJson = params !== null ? JSON.stringify(params) : null;
    const rawJson = db.execute(cypher, paramsJson);
    return parseRelateEnvelope(rawJson);
  }

  private executeChecked(
    cypher: string,
    params: Readonly<Record<string, unknown>> | null,
  ): ParsedRelateEnvelope {
    const envelope = this.executeRaw(cypher, params);
    if (envelope.error !== null) {
      throw new RelateQueryError(envelope.error, cypher, params, extractTelemetry(envelope));
    }
    return envelope;
  }

  private indexPortsFromPayload(payload: WasmGraphPayload): void {
    this.portsByCode.clear();
    for (const tuple of payload.ports) {
      const record: PortRecord = {
        code: tuple[0],
        name: tuple[1],
        country: tuple[2],
        lon: tuple[3],
        lat: tuple[4],
        snapWpId: tuple[5],
        snapDistKm: tuple[6],
        wpDistKm: tuple[7],
        tradeDegree: tuple[8],
        rank: tuple[9],
        isCuratedHub: tuple[10] === 1,
      };
      this.portsByCode.set(record.code, record);
    }
  }

  private seedFreshDb(
    payload: WasmGraphPayload,
    chunkSize: number,
  ): { readonly batchesExecuted: number; readonly elapsedMs: number } {
    this.freeDb();
    // Always construct in-memory RelateDb (strictly zero OPFS).
    const nextDb = new RelateDb();
    try {
      const loadStats = loadWasmGraphPayloadIntoRelateDb(nextDb, payload, chunkSize);
      this.db = nextDb;
      this.dirtyCustomBoxes = false;
      this.activeCustomBoxes = [];
      this.deletedCustomEdgeIds.clear();
      return loadStats;
    } catch (err) {
      nextDb.free();
      throw err;
    }
  }

  boot(payload: WasmGraphPayload, chunkSize = DEFAULT_UNWIND_CHUNK_SIZE): BootTelemetry {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError(`chunkSize must be a positive integer (got ${String(chunkSize)})`);
    }

    const start = performance.now();
    this.payload = payload;
    this.chunkSize = chunkSize;
    this.indexPortsFromPayload(payload);

    const loadStats = this.seedFreshDb(payload, chunkSize);

    const indexesEnv = this.executeChecked('SHOW INDEXES', null);
    const pointIndexesOnline: string[] = [];
    let totalIndexesOnline = 0;
    for (const row of indexesEnv.rows) {
      if (row.state === 'ONLINE') {
        totalIndexesOnline++;
        if (row.type === 'POINT' && typeof row.name === 'string') {
          pointIndexesOnline.push(row.name);
        }
      }
    }

    let maritimeEdges = 0;
    for (const relEdges of Object.values(payload.edgesByRelType)) {
      maritimeEdges += relEdges.length;
    }

    this.bootTelemetry = {
      bootMs: performance.now() - start,
      batchesExecuted: loadStats.batchesExecuted,
      chunkSize,
      pointIndexesOnline,
      totalIndexesOnline,
      counts: {
        waypoints: payload.waypoints.length,
        ports: payload.ports.length,
        countries: payload.countries.length,
        maritimeEdges,
        tradesWith: payload.tradesWith.length,
      },
    };
    return this.bootTelemetry;
  }

  getMetadata(): EngineMetadata {
    return {
      booted: this.db !== null,
      bootTelemetry: this.bootTelemetry,
      dirtyCustomBoxes: this.dirtyCustomBoxes,
      activeBoxIds: this.activeCustomBoxes.map((b) => b.id),
      deletedCustomEdgeCount: this.deletedCustomEdgeIds.size,
      portCount: this.portsByCode.size,
      catalog: this.catalog,
    };
  }

  getPorts(): readonly PortRecord[] {
    return [...this.portsByCode.values()];
  }

  queryRoute(
    fromCode: string,
    toCode: string,
    blockedPassageIds: readonly string[],
    options: { readonly profile?: boolean } = {},
  ): RouteEvaluationResult {
    this.requireDb();
    const fromPort = this.portsByCode.get(fromCode);
    const toPort = this.portsByCode.get(toCode);
    const isSameWaypoint =
      fromCode === toCode ||
      (fromPort !== undefined && toPort !== undefined && fromPort.snapWpId === toPort.snapWpId);

    const params = { from: fromCode, to: toCode };
    const cypher = isSameWaypoint
      ? QueryBuilder.buildSameWaypointRouteQuery({ profile: options.profile })
      : QueryBuilder.buildRouteQuery(this.catalog, blockedPassageIds, {
          profile: options.profile,
        });

    const env = this.executeChecked(cypher, params);
    const telemetry = extractTelemetry(env);
    const row = env.rows[0];
    if (!row) {
      throw new RelateQueryError(
        `Port code not found (from="${fromCode}", to="${toCode}")`,
        cypher,
        params,
        telemetry,
      );
    }

    const shortCircuited = row.shortCircuited === true || isSameWaypoint;
    const hops = typeof row.hops === 'number' ? row.hops : null;
    const totalKm =
      typeof row.totalKm === 'number' ? Math.round(row.totalKm * 10) / 10 : null;
    const coords = parseCoords(row.coords);
    const segments: readonly (readonly [number, number][])[] =
      coords.length >= 2
        ? splitAntimeridianLine(coords as readonly LonLat[])
        : coords.length === 1
          ? [coords]
          : [];
    const nodeIds = parseStringArray(row.nodeIds);
    const edgeIds = parseStringArray(row.edgeIds);
    const relTypes = parseStringArray(row.relTypes);

    const passagesSet = new Set<string>();
    for (const relType of relTypes) {
      const passageId = this.relTypeToPassageId.get(relType);
      if (passageId !== undefined) {
        passagesSet.add(passageId);
      }
    }

    return {
      fromCode: typeof row.fromCode === 'string' ? row.fromCode : fromCode,
      toCode: typeof row.toCode === 'string' ? row.toCode : toCode,
      hops: shortCircuited ? 0 : hops,
      totalKm: shortCircuited ? 0 : totalKm,
      isolated: !shortCircuited && hops === null,
      shortCircuited,
      coords,
      segments,
      nodeIds,
      edgeIds,
      passagesTraversed: [...passagesSet],
      cypher,
      params,
      telemetry,
    };
  }

  private queryBBoxEdgesForOneBox(
    box: CustomBBoxInput,
    limit: number,
  ): {
    readonly summary: CustomBBoxMatchSummary;
    readonly cypher: string;
    readonly telemetry: QueryTelemetry;
  } {
    const cypher = QueryBuilder.buildBBoxEdgesQuery();
    const params = {
      boxes: box.rects.map((rect) => ({
        swLon: rect.swLon,
        swLat: rect.swLat,
        neLon: rect.neLon,
        neLat: rect.neLat,
      })),
      limit,
    };
    const env = this.executeChecked(cypher, params);
    const matchedEdgeIds: string[] = [];
    for (const row of env.rows) {
      if (typeof row.edgeId === 'string') {
        matchedEdgeIds.push(row.edgeId);
      }
    }
    return {
      summary: {
        boxId: box.id,
        matchedEdgeIds,
        matchedEdgeCount: matchedEdgeIds.length,
        truncated: matchedEdgeIds.length >= limit,
      },
      cypher,
      telemetry: extractTelemetry(env),
    };
  }

  applyCustomBoxes(
    boxes: readonly CustomBBoxInput[],
    options: { readonly limit?: number } = {},
  ): CustomBBoxApplyResult {
    this.requireDb();
    const limit = options.limit ?? DEFAULT_BBOX_EDGE_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(`limit must be a positive integer (got ${String(limit)})`);
    }

    let reseeded = false;
    let reseedMs: number | null = null;

    if (this.dirtyCustomBoxes && this.payload !== null) {
      const res = this.seedFreshDb(this.payload, this.chunkSize);
      reseeded = true;
      reseedMs = res.elapsedMs;
    } else if (boxes.length === 0) {
      this.activeCustomBoxes = [];
    }

    if (boxes.length === 0) {
      return {
        matchedEdgeCount: 0,
        deletedEdgeCount: 0,
        mutated: false,
        reseeded,
        reseedMs,
        activeBoxCount: 0,
        activeBoxIds: [],
        truncated: false,
        boxMatches: [],
        cypher: null,
        telemetry: null,
      };
    }

    const boxMatches: CustomBBoxMatchSummary[] = [];
    const newEdgeIdsToDelete = new Set<string>();
    const appliedBoxes: CustomBBoxInput[] = [];
    let lastCypher: string | null = null;
    let lastTelemetry: QueryTelemetry | null = null;
    let truncated = false;

    for (const box of boxes) {
      const { summary, cypher, telemetry } = this.queryBBoxEdgesForOneBox(box, limit);
      lastCypher = cypher;
      lastTelemetry = telemetry;
      boxMatches.push(summary);
      if (summary.truncated) {
        truncated = true;
      }
      if (summary.matchedEdgeIds.length > 0) {
        appliedBoxes.push(box);
        for (const edgeId of summary.matchedEdgeIds) {
          newEdgeIdsToDelete.add(edgeId);
        }
      }
    }

    if (newEdgeIdsToDelete.size === 0) {
      // Zero maritime edges matched: leave the disposable :memory: graph untouched.
      return {
        matchedEdgeCount: 0,
        deletedEdgeCount: 0,
        mutated: false,
        reseeded,
        reseedMs,
        activeBoxCount: this.activeCustomBoxes.length,
        activeBoxIds: this.activeCustomBoxes.map((b) => b.id),
        truncated,
        boxMatches,
        cypher: lastCypher,
        telemetry: lastTelemetry,
      };
    }

    const edgeIds = [...newEdgeIdsToDelete];
    const deleteCypher = QueryBuilder.buildDeleteEdgesByIdsQuery();
    const deleteEnv = this.executeChecked(deleteCypher, { edgeIds });
    const deletedRow = deleteEnv.rows[0];
    const deletedEdgeCount =
      typeof deletedRow?.deletedCount === 'number'
        ? deletedRow.deletedCount
        : deleteEnv.stats.relationships_deleted ?? edgeIds.length;

    for (const id of edgeIds) {
      this.deletedCustomEdgeIds.add(id);
    }
    this.activeCustomBoxes = appliedBoxes;
    this.dirtyCustomBoxes = true;

    return {
      matchedEdgeCount: edgeIds.length,
      deletedEdgeCount,
      mutated: deletedEdgeCount > 0,
      reseeded,
      reseedMs,
      activeBoxCount: this.activeCustomBoxes.length,
      activeBoxIds: this.activeCustomBoxes.map((b) => b.id),
      truncated,
      boxMatches,
      cypher: lastCypher,
      telemetry: extractTelemetry(deleteEnv),
    };
  }

  evaluateScenario(request: ScenarioEvaluationRequest): ScenarioEvaluationResult {
    this.requireDb();
    const start = performance.now();

    const blockedPassageIds = [...new Set(request.blockedPassageIds)];
    const openRelTypes = getOpenRelTypes(this.catalog, blockedPassageIds);

    const route =
      request.routeFrom !== undefined && request.routeTo !== undefined
        ? this.queryRoute(request.routeFrom, request.routeTo, blockedPassageIds, {
            profile: request.profile,
          })
        : null;

    const referenceHubCode = this.catalog.referenceHubCode;
    const isoCypher = QueryBuilder.buildIsolationQuery(this.catalog, blockedPassageIds, {
      profile: request.profile,
    });
    const isoParams = { refHub: referenceHubCode };
    const isoEnv = this.executeChecked(isoCypher, isoParams);
    const isoTelemetry = extractTelemetry(isoEnv);

    const isolatedPorts: IsolatedPortRecord[] = isoEnv.rows.map((row) => ({
      code: requireString(row, 'code', isoCypher, isoParams, isoTelemetry),
      name: requireString(row, 'name', isoCypher, isoParams, isoTelemetry),
      country: requireString(row, 'country', isoCypher, isoParams, isoTelemetry),
      lon: requireFiniteNumber(row, 'lon', isoCypher, isoParams, isoTelemetry),
      lat: requireFiniteNumber(row, 'lat', isoCypher, isoParams, isoTelemetry),
      rank: requireFiniteNumber(row, 'rank', isoCypher, isoParams, isoTelemetry),
      tradeDegree: requireFiniteNumber(row, 'tradeDegree', isoCypher, isoParams, isoTelemetry),
    }));

    const totalPorts = this.portsByCode.size;
    const isolatedCount = isolatedPorts.length;
    const isolation: IsolationEvaluationResult = {
      referenceHubCode,
      totalPorts,
      reachablePorts: Math.max(0, totalPorts - isolatedCount),
      isolatedCount,
      isolatedPorts,
      cypher: isoCypher,
      params: isoParams,
      telemetry: isoTelemetry,
    };

    const tradeCypher = QueryBuilder.buildTradeExposureForPortsQuery({
      profile: request.profile,
    });

    let tradeExposure: TradeExposureEvaluationResult;
    if (isolatedCount === 0) {
      tradeExposure = {
        countries: [],
        cypher: tradeCypher,
        params: { isolatedCodes: [] },
        telemetry: null,
      };
    } else {
      // Reuse isolated port codes from the 1-to-ALL pass so we avoid running BFS twice.
      const tradeParams = {
        isolatedCodes: isolatedPorts.map((p) => p.code),
      };
      const tradeEnv = this.executeChecked(tradeCypher, tradeParams);
      const tradeTelemetry = extractTelemetry(tradeEnv);
      const countries: TradeExposureRecord[] = tradeEnv.rows.map((row) => ({
        countryCode: requireString(row, 'countryCode', tradeCypher, tradeParams, tradeTelemetry),
        countryName: requireString(row, 'countryName', tradeCypher, tradeParams, tradeTelemetry),
        exposedPorts: requireFiniteNumber(
          row,
          'exposedPorts',
          tradeCypher,
          tradeParams,
          tradeTelemetry,
        ),
      }));
      tradeExposure = {
        countries,
        cypher: tradeCypher,
        params: tradeParams,
        telemetry: tradeTelemetry,
      };
    }

    return {
      blockedPassageIds,
      openRelTypes,
      route,
      isolation,
      tradeExposure,
      totalElapsedMs: performance.now() - start,
    };
  }

  runCustomCypher(
    cypher: string,
    params: Readonly<Record<string, unknown>> | null = null,
    options: { readonly profile?: boolean } = {},
  ): CypherExecutionResult {
    this.requireDb();
    const effectiveCypher = options.profile ? QueryBuilder.wrapWithProfile(cypher) : cypher;
    const env = this.executeRaw(effectiveCypher, params);
    return {
      ok: env.error === null,
      cypher: effectiveCypher,
      params,
      columns: env.columns,
      columnTypes: env.columnTypes,
      rows: env.rows,
      error: env.error,
      telemetry: extractTelemetry(env),
    };
  }

  dispose(): void {
    this.freeDb();
    this.payload = null;
    this.bootTelemetry = null;
    this.portsByCode.clear();
    this.dirtyCustomBoxes = false;
    this.activeCustomBoxes = [];
    this.deletedCustomEdgeIds.clear();
  }
}
