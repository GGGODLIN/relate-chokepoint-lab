import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { initSync, RelateDb } from '@relate/relate-wasm';
import {
  parseRelateEnvelope,
  RelateEnvelopeError,
  type ParsedRelateEnvelope,
  type RelateEnvelopeStats,
} from './envelope.ts';

export {
  parseRelateEnvelope,
  RelateEnvelopeError,
  type ParsedRelateEnvelope,
  type RelateEnvelopeStats,
};

export interface RelateWasmProbeResult {
  readonly wasmPackageVersion: string;
  readonly indexEnvelope: ParsedRelateEnvelope;
  readonly openRouteEnvelope: ParsedRelateEnvelope;
  readonly blockedRouteEnvelope: ParsedRelateEnvelope;
}

let wasmInitialized = false;

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
