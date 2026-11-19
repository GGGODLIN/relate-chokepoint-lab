import {
  getDefaultBlockedPassageIds,
  getOpenRelTypes,
  type ChokepointCatalog,
} from '../contracts/catalog.ts';
import type { BuildReceipt } from './build-graph.ts';
import {
  buildIsolatedPortsCypher,
  buildShortestRouteCypher,
  buildStaticRelTypeDisjunction,
} from './relate-loader.ts';

export interface RuntimeCounts {
  readonly waypoints: number;
  readonly ports: number;
  readonly countries: number;
  readonly tradesWith: number;
  readonly totalMaritimeAndPortEdges: number;
  readonly edgesByRelType: Readonly<Record<string, number>>;
}

export interface RouteQueryOutcome {
  readonly scenarioId: string;
  readonly routeId: string;
  readonly fromCode: string;
  readonly toCode: string;
  readonly hops: number | null;
  readonly totalKm: number | null;
  readonly isolated: boolean;
}

export interface IsolationQueryOutcome {
  readonly presetId: string;
  readonly isolatedCount: number;
  readonly isolatedCodes: readonly string[];
}

export interface TradeExposureRow {
  readonly countryCode: string;
  readonly countryName: string;
  readonly exposedPorts: number;
}

export interface ParitySnapshot {
  readonly runtime: string;
  readonly counts: RuntimeCounts;
  readonly routes: readonly RouteQueryOutcome[];
  readonly isolations: readonly IsolationQueryOutcome[];
  readonly hormuzTopCountries: readonly TradeExposureRow[];
}

export interface ParityQuerySpec {
  readonly label: string;
  readonly cypher: string;
  readonly params: Readonly<Record<string, unknown>> | null;
}

export type QueryRunner = (
  cypher: string,
  params: Readonly<Record<string, unknown>> | null,
) => readonly Record<string, unknown>[];

export function buildHormuzTradeExposureCypher(openRelTypes: readonly string[]): string {
  const relPattern = buildStaticRelTypeDisjunction(openRelTypes);
  return [
    'MATCH (hub:Port {code: $refHub})',
    `OPTIONAL MATCH p = shortestPath((hub)-[${relPattern}*]-(p2:Port))`,
    'WHERE p2 <> hub',
    'WITH hub, collect(p2.code) + [hub.code] AS reachableCodes',
    'MATCH (isolated:Port)-[:TRADES_WITH]->(c:Country)',
    'WHERE NOT isolated.code IN reachableCodes',
    'RETURN c.code AS countryCode, c.name AS countryName, count(DISTINCT isolated) AS exposedPorts',
    'ORDER BY exposedPorts DESC, c.code ASC',
    'LIMIT 10',
  ].join('\n');
}

function readRequiredNumber(row: Record<string, unknown> | undefined, field: string, label: string): number {
  const value = row?.[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} expected finite numeric "${field}", got ${JSON.stringify(row)}`);
  }
  return value;
}

export function collectRuntimeParitySnapshot(
  runtime: string,
  catalog: ChokepointCatalog,
  runQuery: QueryRunner,
): ParitySnapshot {
  const wpCount = readRequiredNumber(
    runQuery('MATCH (w:WP) RETURN count(w) AS c', null)[0],
    'c',
    `${runtime}:WP count`,
  );
  const portCount = readRequiredNumber(
    runQuery('MATCH (p:Port) RETURN count(p) AS c', null)[0],
    'c',
    `${runtime}:Port count`,
  );
  const countryCount = readRequiredNumber(
    runQuery('MATCH (c:Country) RETURN count(c) AS c', null)[0],
    'c',
    `${runtime}:Country count`,
  );
  const tradesWithCount = readRequiredNumber(
    runQuery('MATCH ()-[r:TRADES_WITH]->() RETURN count(r) AS c', null)[0],
    'c',
    `${runtime}:TRADES_WITH count`,
  );

  const staticRelTypes = [catalog.openSeaRelType, ...catalog.passages.map((p) => p.relType)];
  const edgesByRelType: Record<string, number> = {};
  let totalMaritimeAndPortEdges = 0;

  for (const relType of staticRelTypes) {
    const count = readRequiredNumber(
      runQuery(`MATCH ()-[r:${relType}]->() RETURN count(r) AS c`, null)[0],
      'c',
      `${runtime}:${relType} count`,
    );
    edgesByRelType[relType] = count;
    totalMaritimeAndPortEdges += count;
  }

  const defaultBlocked = getDefaultBlockedPassageIds(catalog);
  const scenarios: Array<{ readonly id: string; readonly blocked: readonly string[] }> = [
    { id: 'open', blocked: defaultBlocked },
    ...catalog.presets.map((preset) => ({
      id: preset.id,
      blocked: [...new Set([...defaultBlocked, ...preset.blockedPassages])],
    })),
  ];

  const routes: RouteQueryOutcome[] = [];
  for (const scenario of scenarios) {
    const openRelTypes = getOpenRelTypes(catalog, scenario.blocked);
    const routeCypher = buildShortestRouteCypher(openRelTypes);
    for (const route of catalog.goldenRoutes) {
      const rows = runQuery(routeCypher, { from: route.from, to: route.to });
      if (rows.length !== 1) {
        throw new Error(
          `${runtime} route ${scenario.id}/${route.id} expected 1 row, got ${rows.length}`,
        );
      }
      const row = rows[0];
      const hops = typeof row?.hops === 'number' ? row.hops : null;
      const totalKm = typeof row?.totalKm === 'number' ? Math.round(row.totalKm * 10) / 10 : null;
      routes.push({
        scenarioId: scenario.id,
        routeId: route.id,
        fromCode: String(row?.fromCode ?? ''),
        toCode: String(row?.toCode ?? ''),
        hops,
        totalKm,
        isolated: hops === null,
      });
    }
  }

  const isolations: IsolationQueryOutcome[] = [];
  for (const preset of catalog.presets) {
    const blocked = [...new Set([...defaultBlocked, ...preset.blockedPassages])];
    const openRelTypes = getOpenRelTypes(catalog, blocked);
    const isoCypher = buildIsolatedPortsCypher(openRelTypes);
    const rows = runQuery(isoCypher, { refHub: catalog.referenceHubCode });
    const isolatedCodes = rows.map((r) => String(r.code ?? ''));
    isolations.push({
      presetId: preset.id,
      isolatedCount: isolatedCodes.length,
      isolatedCodes,
    });
  }

  const hormuzOpenRelTypes = getOpenRelTypes(catalog, [...new Set([...defaultBlocked, 'ormuz'])]);
  const hormuzCountryRows = runQuery(buildHormuzTradeExposureCypher(hormuzOpenRelTypes), {
    refHub: catalog.referenceHubCode,
  });
  const hormuzTopCountries: TradeExposureRow[] = hormuzCountryRows.map((row) => ({
    countryCode: String(row.countryCode ?? ''),
    countryName: String(row.countryName ?? ''),
    exposedPorts: readRequiredNumber(row, 'exposedPorts', `${runtime}:hormuzTopCountries`),
  }));

  return {
    runtime,
    counts: {
      waypoints: wpCount,
      ports: portCount,
      countries: countryCount,
      tradesWith: tradesWithCount,
      totalMaritimeAndPortEdges,
      edgesByRelType,
    },
    routes,
    isolations,
    hormuzTopCountries,
  };
}

export function compareParitySnapshots(
  nativeSnap: ParitySnapshot,
  wasmSnap: ParitySnapshot,
  receipt: BuildReceipt,
): string[] {
  const diffs: string[] = [];

  // 1. Fail-closed non-zero and receipt count checks.
  const expectedCounts = {
    waypoints: receipt.graph.waypoints,
    ports: receipt.graph.ports,
    countries: receipt.graph.countries,
    tradesWith: receipt.graph.trades_with_edges,
    totalMaritimeAndPortEdges: receipt.graph.total_sea_and_passage_edges,
  };

  for (const [key, expected] of Object.entries(expectedCounts)) {
    const nVal = nativeSnap.counts[key as keyof typeof expectedCounts];
    const wVal = wasmSnap.counts[key as keyof typeof expectedCounts];
    if (expected <= 0) {
      diffs.push(`receipt count "${key}" must be > 0 (got ${expected})`);
    }
    if (nVal !== expected) {
      diffs.push(`native count "${key}" mismatch: expected ${expected}, got ${nVal}`);
    }
    if (wVal !== expected) {
      diffs.push(`wasm count "${key}" mismatch: expected ${expected}, got ${wVal}`);
    }
  }

  // Per-relationship-type counts (SEA_OPEN includes port_link edges in the live store).
  for (const [relType, receiptMaritimeCount] of Object.entries(receipt.graph.edges_by_rel_type)) {
    const expectedStoreCount =
      relType === 'SEA_OPEN'
        ? receiptMaritimeCount + receipt.graph.port_link_edges
        : receiptMaritimeCount;
    const nVal = nativeSnap.counts.edgesByRelType[relType];
    const wVal = wasmSnap.counts.edgesByRelType[relType];
    if (nVal !== expectedStoreCount || wVal !== expectedStoreCount) {
      diffs.push(
        `relType ${relType} count mismatch: receipt=${expectedStoreCount}, native=${String(nVal)}, wasm=${String(wVal)}`,
      );
    }
  }

  // 2. Golden routes across open + all presets.
  if (nativeSnap.routes.length !== wasmSnap.routes.length) {
    diffs.push(
      `route result count mismatch: native=${nativeSnap.routes.length}, wasm=${wasmSnap.routes.length}`,
    );
  }
  const wasmByKey = new Map(wasmSnap.routes.map((r) => [`${r.scenarioId}:${r.routeId}`, r]));
  for (const nRoute of nativeSnap.routes) {
    const key = `${nRoute.scenarioId}:${nRoute.routeId}`;
    const wRoute = wasmByKey.get(key);
    if (!wRoute) {
      diffs.push(`missing wasm route result for ${key}`);
      continue;
    }
    const receiptRoute = receipt.golden_route_baselines[nRoute.scenarioId]?.find(
      (r) => r.routeId === nRoute.routeId,
    );
    if (!receiptRoute) {
      diffs.push(`missing receipt baseline for route ${key}`);
      continue;
    }
    if (nRoute.isolated !== wRoute.isolated || nRoute.isolated !== receiptRoute.isolated) {
      diffs.push(
        `route ${key} isolation mismatch: receipt=${receiptRoute.isolated}, native=${nRoute.isolated}, wasm=${wRoute.isolated}`,
      );
    }
    if (!receiptRoute.isolated && (nRoute.hops === null || wRoute.hops === null)) {
      diffs.push(`route ${key} unexpectedly returned 0/null path`);
    }
    if (nRoute.hops !== wRoute.hops || nRoute.hops !== receiptRoute.hops) {
      diffs.push(
        `route ${key} hops mismatch: receipt=${String(receiptRoute.hops)}, native=${String(nRoute.hops)}, wasm=${String(wRoute.hops)}`,
      );
    }
    if (nRoute.totalKm !== wRoute.totalKm) {
      diffs.push(
        `route ${key} native vs wasm totalKm mismatch: native=${String(nRoute.totalKm)}, wasm=${String(wRoute.totalKm)}`,
      );
    }
  }

  // 3. Preset isolation counts and exact ordered port lists.
  const wasmIsoByPreset = new Map(wasmSnap.isolations.map((i) => [i.presetId, i]));
  for (const nIso of nativeSnap.isolations) {
    const wIso = wasmIsoByPreset.get(nIso.presetId);
    const rIso = receipt.isolation_baselines[nIso.presetId];
    if (!wIso || !rIso) {
      diffs.push(`missing isolation comparison entry for preset "${nIso.presetId}"`);
      continue;
    }
    if (nIso.isolatedCount <= 0 || wIso.isolatedCount <= 0) {
      diffs.push(`preset "${nIso.presetId}" unexpectedly returned 0 isolated ports`);
    }
    if (nIso.isolatedCount !== rIso.isolatedPorts || wIso.isolatedCount !== rIso.isolatedPorts) {
      diffs.push(
        `preset "${nIso.presetId}" isolated count mismatch: receipt=${rIso.isolatedPorts}, native=${nIso.isolatedCount}, wasm=${wIso.isolatedCount}`,
      );
    }
    if (JSON.stringify(nIso.isolatedCodes) !== JSON.stringify(wIso.isolatedCodes)) {
      diffs.push(`preset "${nIso.presetId}" isolated port code lists differ between native and wasm`);
    }
  }

  // 4. Trade exposure top countries parity.
  if (nativeSnap.hormuzTopCountries.length === 0 || wasmSnap.hormuzTopCountries.length === 0) {
    diffs.push('hormuz trade exposure query unexpectedly returned 0 countries');
  }
  if (JSON.stringify(nativeSnap.hormuzTopCountries) !== JSON.stringify(wasmSnap.hormuzTopCountries)) {
    diffs.push(
      `hormuz trade exposure mismatch: native=${JSON.stringify(nativeSnap.hormuzTopCountries)} vs wasm=${JSON.stringify(wasmSnap.hormuzTopCountries)}`,
    );
  }

  return diffs;
}
