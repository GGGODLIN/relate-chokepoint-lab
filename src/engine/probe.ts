import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { initSync, RelateDb } from '@relate/relate-wasm';

export interface RelateEnvelopeStats {
  readonly nodes_created?: number;
  readonly relationships_created?: number;
  readonly indexes_added?: number;
  readonly [key: string]: number | undefined;
}

export interface ParsedRelateEnvelope {
  readonly columns: readonly string[];
  readonly columnTypes: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly error: string | null;
  readonly elapsedMs: number | null;
  readonly executeMs: number | null;
  readonly planCache: string | null;
  readonly plan: unknown;
  readonly notifications: readonly unknown[];
  readonly stats: RelateEnvelopeStats;
}

export interface RelateWasmProbeResult {
  readonly wasmPackageVersion: string;
  readonly indexEnvelope: ParsedRelateEnvelope;
  readonly openRouteEnvelope: ParsedRelateEnvelope;
  readonly blockedRouteEnvelope: ParsedRelateEnvelope;
}

export class RelateEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelateEnvelopeError';
  }
}

let wasmInitialized = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractErrorMessage(rawError: unknown): string | null {
  if (rawError === null || rawError === undefined) {
    return null;
  }
  if (typeof rawError === 'string') {
    return rawError;
  }
  if (isRecord(rawError) && typeof rawError.message === 'string') {
    return rawError.message;
  }
  return JSON.stringify(rawError);
}

export function parseRelateEnvelope(rawJson: string): ParsedRelateEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RelateEnvelopeError(`Failed to parse Relate wire envelope JSON: ${detail}`);
  }

  if (!isRecord(parsed)) {
    throw new RelateEnvelopeError('Relate wire envelope must be a JSON object');
  }

  const error = extractErrorMessage(parsed.error);

  // Native CLI error envelopes omit columns/rows; success envelopes always include both arrays.
  const columns = Array.isArray(parsed.columns)
    ? parsed.columns.map((col) => String(col))
    : error !== null
      ? []
      : null;
  if (columns === null) {
    throw new RelateEnvelopeError('Relate wire envelope is missing columns array');
  }

  const rows = Array.isArray(parsed.rows)
    ? parsed.rows
    : error !== null
      ? []
      : null;
  if (rows === null) {
    throw new RelateEnvelopeError('Relate wire envelope is missing rows array');
  }

  const typedRows: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!isRecord(row)) {
      throw new RelateEnvelopeError(`Relate wire envelope rows[${i}] must be an object`);
    }
    typedRows.push(row);
  }

  const columnTypes = Array.isArray(parsed.columnTypes)
    ? parsed.columnTypes.map((t) => String(t))
    : [];

  const timings = isRecord(parsed.timings) ? parsed.timings : null;
  const elapsedMs = readOptionalNumber(parsed.elapsed_ms) ?? readOptionalNumber(timings?.elapsed_ms);
  const executeMs = readOptionalNumber(parsed.execute_ms) ?? readOptionalNumber(timings?.execute_ms);

  const planCache =
    typeof parsed.plan_cache === 'string'
      ? parsed.plan_cache
      : typeof parsed.planCache === 'string'
        ? parsed.planCache
        : null;

  const notifications = Array.isArray(parsed.notifications) ? parsed.notifications : [];
  const stats: RelateEnvelopeStats = isRecord(parsed.stats)
    ? (parsed.stats as RelateEnvelopeStats)
    : {};

  return {
    columns,
    columnTypes,
    rows: typedRows,
    error,
    elapsedMs,
    executeMs,
    planCache,
    plan: parsed.plan ?? null,
    notifications,
    stats,
  };
}

export function initRelateWasmNode(): void {
  if (wasmInitialized) {
    return;
  }
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('@relate/relate-wasm/relate_bg.wasm');
  const wasmBytes = readFileSync(wasmPath);
  initSync({ module: wasmBytes });
  wasmInitialized = true;
}

export const PROBE_SEED_CYPHER = `
CREATE (a:Port {code: 'TWKHH', name: 'Kaohsiung', loc: point({longitude: 120.271968, latitude: 22.642017})}),
       (b:Port {code: 'NLRTM', name: 'Rotterdam', loc: point({longitude: 4.442447, latitude: 51.904383})}),
       (wSuez:WP {id: 'wp_probe_suez', loc: point({longitude: 33.4051, latitude: 29.0515})}),
       (wCape:WP {id: 'wp_probe_cape', loc: point({longitude: 20.0, latitude: -35.0})}),
       (wCape2:WP {id: 'wp_probe_cape2', loc: point({longitude: -15.0, latitude: 15.0})}),
       (a)-[:SEA_OPEN {km: 9500.0}]->(wSuez),
       (wSuez)-[:PASSAGE_SUEZ {km: 6200.0}]->(b),
       (a)-[:SEA_OPEN {km: 12500.0}]->(wCape),
       (wCape)-[:PASSAGE_SOUTH_AFRICA {km: 5800.0}]->(wCape2),
       (wCape2)-[:SEA_OPEN {km: 5700.0}]->(b)
`.trim();

export const PROBE_INDEX_CYPHER =
  'CREATE POINT INDEX probe_port_loc_idx IF NOT EXISTS FOR (p:Port) ON (p.loc)';

export const PROBE_OPEN_ROUTE_CYPHER = `
MATCH (a:Port {code: $from}), (b:Port {code: $to})
MATCH p = shortestPath((a)-[:SEA_OPEN|PASSAGE_SUEZ|PASSAGE_SOUTH_AFRICA*]-(b))
RETURN a.code AS fromCode,
       b.code AS toCode,
       length(p) AS hops,
       reduce(km = 0.0, r IN relationships(p) | km + r.km) AS totalKm
`.trim();

export const PROBE_BLOCKED_SUEZ_CYPHER = `
MATCH (a:Port {code: $from}), (b:Port {code: $to})
MATCH p = shortestPath((a)-[:SEA_OPEN|PASSAGE_SOUTH_AFRICA*]-(b))
RETURN a.code AS fromCode,
       b.code AS toCode,
       length(p) AS hops,
       reduce(km = 0.0, r IN relationships(p) | km + r.km) AS totalKm
`.trim();

export function resolveRelateWasmPackageVersion(): string {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('@relate/relate-wasm/relate_bg.wasm');
  const pkgPath = join(dirname(wasmPath), 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  return pkg.version ?? 'unknown';
}

export function probeRelateWasm(): RelateWasmProbeResult {
  initRelateWasmNode();
  const wasmPackageVersion = resolveRelateWasmPackageVersion();

  const db = new RelateDb();
  try {
    const seedEnvelope = parseRelateEnvelope(db.execute(PROBE_SEED_CYPHER, null));
    if (seedEnvelope.error !== null) {
      throw new RelateEnvelopeError(`Probe seed failed: ${seedEnvelope.error}`);
    }

    const indexEnvelope = parseRelateEnvelope(db.execute(PROBE_INDEX_CYPHER, null));
    if (indexEnvelope.error !== null) {
      throw new RelateEnvelopeError(`Probe POINT INDEX failed: ${indexEnvelope.error}`);
    }

    const paramsJson = JSON.stringify({ from: 'TWKHH', to: 'NLRTM' });
    const openRouteEnvelope = parseRelateEnvelope(db.execute(PROBE_OPEN_ROUTE_CYPHER, paramsJson));
    const blockedRouteEnvelope = parseRelateEnvelope(
      db.execute(PROBE_BLOCKED_SUEZ_CYPHER, paramsJson),
    );

    return {
      wasmPackageVersion,
      indexEnvelope,
      openRouteEnvelope,
      blockedRouteEnvelope,
    };
  } finally {
    db.free();
  }
}
