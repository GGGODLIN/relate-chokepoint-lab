import { parseRelateEnvelope, type ParsedRelateEnvelope } from '../engine/envelope.ts';
import type { WasmGraphPayload } from './build-graph.ts';

export const DEFAULT_UNWIND_CHUNK_SIZE = 5000;

export const SCHEMA_INDEX_STATEMENTS: readonly string[] = [
  'CREATE INDEX wp_id_idx IF NOT EXISTS FOR (w:WP) ON (w.id)',
  'CREATE INDEX port_code_idx IF NOT EXISTS FOR (p:Port) ON (p.code)',
  'CREATE INDEX country_code_idx IF NOT EXISTS FOR (c:Country) ON (c.code)',
  'CREATE POINT INDEX wp_loc_idx IF NOT EXISTS FOR (w:WP) ON (w.loc)',
  'CREATE POINT INDEX port_loc_idx IF NOT EXISTS FOR (p:Port) ON (p.loc)',
];

export const SEED_WAYPOINTS_CYPHER =
  'UNWIND $rows AS r CREATE (:WP {id: r[0], lon: r[1], lat: r[2], loc: point({longitude: r[1], latitude: r[2]})})';

export const SEED_COUNTRIES_CYPHER =
  'UNWIND $rows AS r CREATE (:Country {code: r[0], name: r[1]})';

export const SEED_PORTS_CYPHER =
  'UNWIND $rows AS r CREATE (:Port {code: r[0], name: r[1], country: r[2], lon: r[3], lat: r[4], snapWpId: r[5], snapDistKm: r[6], wpDistKm: r[7], tradeDegree: r[8], rank: r[9], isCuratedHub: r[10] = 1, loc: point({longitude: r[3], latitude: r[4]})})';

export const SEED_PORT_LINKS_CYPHER =
  "UNWIND $rows AS r MATCH (p:Port {code: r[0]}), (w:WP {id: r[5]}) CREATE (p)-[:SEA_OPEN {id: 'pe_' + r[0], km: r[7], kind: 'port_link'}]->(w)";

export const SEED_TRADES_WITH_CYPHER =
  'UNWIND $rows AS r MATCH (p:Port {code: r[0]}), (c:Country {code: r[1]}) CREATE (p)-[:TRADES_WITH]->(c)';

const SAFE_REL_TYPE_RE = /^[A-Z][A-Z0-9_]*$/;

export function assertSafeRelType(relType: string): string {
  if (!SAFE_REL_TYPE_RE.test(relType)) {
    throw new Error(`Unsafe Cypher relationship type: ${JSON.stringify(relType)}`);
  }
  return relType;
}

export function buildSeedEdgesCypher(relType: string): string {
  const safe = assertSafeRelType(relType);
  return `UNWIND $rows AS r MATCH (a:WP {id: r[1]}), (b:WP {id: r[2]}) CREATE (a)-[:${safe} {id: r[0], km: r[3], kind: 'lane'}]->(b)`;
}

export function buildStaticRelTypeDisjunction(openRelTypes: readonly string[]): string {
  if (openRelTypes.length === 0) {
    throw new Error('openRelTypes must contain at least one relationship type');
  }
  const safeTypes = openRelTypes.map(assertSafeRelType);
  // Relate v1.1.0 Cypher 25 requires a single leading colon across the union.
  return `:${safeTypes.join('|')}`;
}

export function buildShortestRouteCypher(openRelTypes: readonly string[]): string {
  const relPattern = buildStaticRelTypeDisjunction(openRelTypes);
  return [
    'MATCH (a:Port {code: $from}), (b:Port {code: $to})',
    `OPTIONAL MATCH p = shortestPath((a)-[${relPattern}*]-(b))`,
    'RETURN a.code AS fromCode,',
    '       b.code AS toCode,',
    '       CASE WHEN p IS NULL THEN null ELSE length(p) END AS hops,',
    '       CASE WHEN p IS NULL THEN null ELSE round(reduce(km = 0.0, r IN relationships(p) | km + r.km), 1) END AS totalKm',
  ].join('\n');
}

export function buildIsolatedPortsCypher(openRelTypes: readonly string[]): string {
  const relPattern = buildStaticRelTypeDisjunction(openRelTypes);
  return [
    'MATCH (hub:Port {code: $refHub})',
    `OPTIONAL MATCH p = shortestPath((hub)-[${relPattern}*]-(p2:Port))`,
    'WHERE p2 <> hub',
    'WITH hub, collect(p2.code) + [hub.code] AS reachableCodes',
    'MATCH (isolated:Port)',
    'WHERE NOT isolated.code IN reachableCodes',
    'RETURN isolated.code AS code, isolated.name AS name, isolated.country AS country, isolated.rank AS rank',
    'ORDER BY isolated.rank ASC, isolated.code ASC',
  ].join('\n');
}

export interface SeedBatch {
  readonly label: string;
  readonly cypher: string;
  readonly rows: readonly unknown[] | null;
}

export function chunkArray<T>(items: readonly T[], chunkSize = DEFAULT_UNWIND_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export function generateSeedBatches(
  payload: WasmGraphPayload,
  chunkSize = DEFAULT_UNWIND_CHUNK_SIZE,
): SeedBatch[] {
  const batches: SeedBatch[] = [];

  for (let i = 0; i < SCHEMA_INDEX_STATEMENTS.length; i++) {
    const stmt = SCHEMA_INDEX_STATEMENTS[i];
    if (stmt) {
      batches.push({ label: `index_${i}`, cypher: stmt, rows: null });
    }
  }

  for (const [idx, rows] of chunkArray(payload.waypoints, chunkSize).entries()) {
    batches.push({ label: `waypoints_${idx}`, cypher: SEED_WAYPOINTS_CYPHER, rows });
  }

  for (const [idx, rows] of chunkArray(payload.countries, chunkSize).entries()) {
    batches.push({ label: `countries_${idx}`, cypher: SEED_COUNTRIES_CYPHER, rows });
  }

  for (const [idx, rows] of chunkArray(payload.ports, chunkSize).entries()) {
    batches.push({ label: `ports_${idx}`, cypher: SEED_PORTS_CYPHER, rows });
  }

  for (const relType of payload.catalogMeta.staticRelTypes) {
    const relEdges = payload.edgesByRelType[relType] ?? [];
    if (relEdges.length === 0) continue;
    const cypher = buildSeedEdgesCypher(relType);
    for (const [idx, rows] of chunkArray(relEdges, chunkSize).entries()) {
      batches.push({ label: `edges_${relType}_${idx}`, cypher, rows });
    }
  }

  for (const [idx, rows] of chunkArray(payload.ports, chunkSize).entries()) {
    batches.push({ label: `port_links_${idx}`, cypher: SEED_PORT_LINKS_CYPHER, rows });
  }

  for (const [idx, rows] of chunkArray(payload.tradesWith, chunkSize).entries()) {
    batches.push({ label: `trades_with_${idx}`, cypher: SEED_TRADES_WITH_CYPHER, rows });
  }

  return batches;
}

export interface RelateLikeExecutor {
  execute(query: string, paramsJson: string | null): string;
}

export function loadWasmGraphPayloadIntoRelateDb(
  db: RelateLikeExecutor,
  payload: WasmGraphPayload,
  chunkSize = DEFAULT_UNWIND_CHUNK_SIZE,
): { readonly batchesExecuted: number; readonly elapsedMs: number } {
  const start = performance.now();
  const batches = generateSeedBatches(payload, chunkSize);
  for (const batch of batches) {
    const paramsJson = batch.rows !== null ? JSON.stringify({ rows: batch.rows }) : null;
    const raw = db.execute(batch.cypher, paramsJson);
    let envelope: ParsedRelateEnvelope;
    try {
      envelope = parseRelateEnvelope(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Relate WASM seed batch "${batch.label}" returned invalid envelope: ${detail}`, {
        cause: err,
      });
    }
    if (envelope.error !== null) {
      throw new Error(`Relate WASM seed batch "${batch.label}" failed: ${envelope.error}`);
    }
  }
  return {
    batchesExecuted: batches.length,
    elapsedMs: Math.round((performance.now() - start) * 10) / 10,
  };
}
