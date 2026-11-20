import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ChokepointCatalog } from '../src/contracts/catalog.ts';
import {
  buildGraph,
  EtlInvariantError,
  projectToMapLibreGeoJson,
  projectToWasmPayload,
  type BuildReceipt,
} from '../src/etl/build-graph.ts';
import {
  formatCountryName,
  normalizeLon,
  resamplePolyline,
  splitAntimeridianLine,
} from '../src/etl/geo.ts';
import {
  compareParitySnapshots,
  type ParitySnapshot,
} from '../src/etl/parity.ts';
import { loadWasmGraphPayloadIntoRelateDb } from '../src/etl/relate-loader.ts';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const rawCatalog = JSON.parse(
  readFileSync(resolve(ROOT_DIR, 'contracts/chokepoint-catalog.json'), 'utf8'),
) as ChokepointCatalog;
const rawMarnetGeoJson = JSON.parse(
  readFileSync(resolve(ROOT_DIR, 'data/raw/marnet_searoute.geojson'), 'utf8'),
) as {
  type: string;
  features: Array<{
    type: string;
    properties?: Record<string, unknown> | null;
    geometry?: { type?: string; coordinates?: unknown } | null;
  }>;
};
const rawPortsGeoJson = JSON.parse(
  readFileSync(resolve(ROOT_DIR, 'data/raw/ports.geojson'), 'utf8'),
) as {
  type: string;
  features: Array<{
    type: string;
    properties?: Record<string, unknown> | null;
    geometry?: { type?: string; coordinates?: unknown } | null;
  }>;
};

// Independent modular-arithmetic oracle for Conditional PBT P1 on normalizeLon.
function evaluateNormalizeLonOracle(
  inputLon: number,
  candidateFn: (lon: number) => number,
): {
  readonly pRange: boolean;
  readonly pNoNegZero: boolean;
  readonly pCongruent: boolean;
  readonly pIdempotent: boolean;
} {
  const out = candidateFn(inputLon);
  const pRange = Number.isFinite(out) && out >= -180 && out < 180;
  const pNoNegZero = !Object.is(out, -0);
  const turns = (inputLon - out) / 360;
  const pCongruent = Math.abs(turns - Math.round(turns)) <= 1e-9;
  const second = candidateFn(out);
  const pIdempotent = Number.isFinite(second) && second === out;
  return { pRange, pNoNegZero, pCongruent, pIdempotent };
}

describe('Seam 1 — geo helpers & Conditional PBT P1 (normalizeLon)', () => {
  it('Role 1: maps concrete boundary and Bering longitudes accurately, preserves strict === idempotence, and rejects non-finite values', () => {
    expect(normalizeLon(190.8498)).toBeCloseTo(-169.1502, 10);
    expect(normalizeLon(180)).toBe(-180);
    expect(normalizeLon(-180)).toBe(-180);
    expect(normalizeLon(360)).toBe(0);
    expect(normalizeLon(-360)).toBe(0);
    expect(normalizeLon(540)).toBe(-180);
    expect(normalizeLon(-540)).toBe(-180);
    expect(normalizeLon(-720)).toBe(0);
    expect(normalizeLon(720)).toBe(0);
    expect(Object.is(normalizeLon(-0), -0)).toBe(false);
    expect(normalizeLon(-0)).toBe(0);

    // Counterexample replay: strict === idempotence & zero ULP drift for in-range values.
    expect(normalizeLon(0.1)).toBe(0.1);
    expect(normalizeLon(-25.2)).toBe(-25.2);
    for (const sample of [-180.2, 0.1, -25.2, 190.8498, -180, 180, -0, 0]) {
      const once = normalizeLon(sample);
      const twice = normalizeLon(once);
      expect(twice).toBe(once);
    }

    expect(() => normalizeLon(Number.NaN)).toThrow(RangeError);
    expect(() => normalizeLon(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => normalizeLon(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });

  it('Role 2: P1 property guardian over [-720, 720] verifies range, congruence, no -0, and idempotence', () => {
    let belowNeg180Count = 0;
    let inCanonicalRangeCount = 0;
    let atOrAbove180Count = 0;

    fc.assert(
      fc.property(
        fc.double({ min: -720, max: 720, noNaN: true, noDefaultInfinity: true }),
        (lon) => {
          if (lon < -180) belowNeg180Count++;
          else if (lon >= 180) atOrAbove180Count++;
          else inCanonicalRangeCount++;

          const verdict = evaluateNormalizeLonOracle(lon, normalizeLon);
          if (
            !verdict.pRange ||
            !verdict.pNoNegZero ||
            !verdict.pCongruent ||
            !verdict.pIdempotent
          ) {
            return false;
          }
          return true;
        },
      ),
      { numRuns: 500 },
    );

    // Reachability witnesses checked after fc.assert completes across the full batch.
    expect(belowNeg180Count).toBeGreaterThan(0);
    expect(inCanonicalRangeCount).toBeGreaterThan(0);
    expect(atOrAbove180Count).toBeGreaterThan(0);
  });

  it('Role 3: calibrates the P1 independent oracle against test-local faulty candidates individually', () => {
    const identityBug = (lon: number): number => lon;
    const rangeCheck = evaluateNormalizeLonOracle(190.8498, identityBug);
    expect(rangeCheck.pRange).toBe(false);

    const constantZeroBug = (_lon: number): number => 0;
    const congruentCheck = evaluateNormalizeLonOracle(25.5, constantZeroBug);
    expect(congruentCheck.pCongruent).toBe(false);

    const negZeroBug = (lon: number): number => (lon === 0 ? -0 : normalizeLon(lon));
    const negZeroCheck = evaluateNormalizeLonOracle(0, negZeroBug);
    expect(negZeroCheck.pNoNegZero).toBe(false);

    const shiftBug = (lon: number): number => normalizeLon(lon + 10);
    const idempotentCheck = evaluateNormalizeLonOracle(15, shiftBug);
    expect(idempotentCheck.pIdempotent).toBe(false);

    // Calibration against the ULP-drift counterexample (-180.2) without fast-path short-circuit.
    const ulpDriftBug = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;
    const ulpCheck = evaluateNormalizeLonOracle(-180.2, ulpDriftBug);
    expect(ulpCheck.pIdempotent).toBe(false);
  });

  it('cleans underscored country names and splits antimeridian-crossing lines cleanly', () => {
    expect(formatCountryName('United_arab_emirates')).toBe('United Arab Emirates');
    expect(formatCountryName('Democratic_republic_of_the_congo')).toBe(
      'Democratic Republic of the Congo',
    );
    expect(formatCountryName('Us_virgin_islands')).toBe('US Virgin Islands');
    expect(formatCountryName('Saint_vincent_and_the_grenadines')).toBe(
      'Saint Vincent and the Grenadines',
    );

    const splitParts = splitAntimeridianLine([
      [175, 40],
      [-175, 42],
    ]);
    expect(splitParts).toHaveLength(2);
    expect(splitParts[0]?.[0]).toEqual([175, 40]);
    expect(splitParts[0]?.[1]?.[0]).toBe(180);
    expect(splitParts[1]?.[0]?.[0]).toBe(-180);
    expect(splitParts[1]?.[1]).toEqual([-175, 42]);

    // Endpoint directly on -180 must not emit a zero-length [[-180, 70], [-180, 70]] artifact.
    const onMeridianParts = splitAntimeridianLine([
      [-180, 70],
      [176, 70],
    ]);
    expect(onMeridianParts).toEqual([
      [
        [180, 70],
        [176, 70],
      ],
    ]);

    const resampled = resamplePolyline(
      [
        [178, 35],
        [-178, 35],
      ],
      100,
    );
    expect(resampled.length).toBeGreaterThanOrEqual(3);
    expect(resampled[0]).toEqual([178, 35]);
    expect(resampled[resampled.length - 1]).toEqual([-178, 35]);
  });
});

describe('Seam 1 — canonical buildGraph pipeline, MultiLineString isolation, ports & projections', () => {
  const canonical = buildGraph({
    marnetGeoJson: rawMarnetGeoJson,
    portsGeoJson: rawPortsGeoJson,
    catalog: rawCatalog,
  });

  it('enforces all fail-fast build-receipt invariants and produces deterministic output', () => {
    const secondRun = buildGraph({
      marnetGeoJson: rawMarnetGeoJson,
      portsGeoJson: rawPortsGeoJson,
      catalog: rawCatalog,
    });

    expect(canonical.receipt).toEqual(secondRun.receipt);
    expect(canonical.waypoints.map((w) => w.id)).toEqual(secondRun.waypoints.map((w) => w.id));
    expect(canonical.edges.map((e) => e.id)).toEqual(secondRun.edges.map((e) => e.id));
    expect(canonical.ports.map((p) => p.code)).toEqual(secondRun.ports.map((p) => p.code));

    expect(canonical.receipt.inputs.linestrings).toBe(4108);
    expect(canonical.receipt.inputs.multilinestring_parts).toBe(2);
    expect(canonical.receipt.inputs.south_africa_bypass_features_patched).toEqual([706, 4107]);
    expect(canonical.receipt.inputs.raw_duplicate_locodes).toBe(38);
    expect(canonical.receipt.inputs.t_junction_vertices_preserved).toBeGreaterThan(1000);

    expect(canonical.receipt.invariants).toMatchObject({
      connected_components: 1,
      ports_on_non_main: 0,
      duplicate_port_ids: 0,
      uncleaned_country_names: 0,
      northwest_default_blocked: true,
      cut_audit_clean: true,
      unintended_local_bypasses: 0,
    });
    expect(canonical.receipt.invariants.max_port_snap_dist_km).toBeLessThanOrEqual(100);
    expect(canonical.receipt.graph.static_rel_types_count).toBe(14);
  });

  it('preserves MultiLineString #3627 part_idx isolation in synthetic waypoint IDs across Pacific and Atlantic', () => {
    const feat3627Syn = canonical.waypoints.filter(
      (w) => w.kind === 'synthetic' && w.sourceFeatIdx === 3627,
    );
    const part0 = feat3627Syn.filter((w) => w.sourcePartIdx === 0);
    const part1 = feat3627Syn.filter((w) => w.sourcePartIdx === 1);

    expect(part0.length).toBeGreaterThan(0);
    expect(part1.length).toBeGreaterThan(0);

    for (const wp of part0) {
      expect(wp.id).toContain('_f3627_p0_');
      expect(wp.lon).toBeLessThan(-70);
    }
    for (const wp of part1) {
      expect(wp.id).toContain('_f3627_p1_');
      expect(wp.lon).toBeGreaterThan(-70);
      expect(wp.lon).toBeLessThan(-25);
    }
  });

  it('filters ports to t==1.0 && snap<=100km, deduplicates UN/LOCODEs, cleans country names, and builds TRADES_WITH', () => {
    // Positive control: confirm inland cities and duplicate UN/LOCODEs actually exist in raw ports.geojson.
    const rawNames = new Set(rawPortsGeoJson.features.map((f) => String(f.properties?.name ?? '')));
    const rawCodes = new Set(rawPortsGeoJson.features.map((f) => String(f.properties?.port ?? '')));
    expect(rawCodes.has('SARYP')).toBe(true);
    expect(rawCodes.has('USDAL')).toBe(true);
    expect(rawCodes.has('USSLC')).toBe(true);
    expect(rawNames.has('Denver') || rawCodes.has('USDEN')).toBe(true);

    const portByCode = new Map(canonical.ports.map((p) => [p.code, p]));
    expect(portByCode.size).toBe(canonical.ports.length);
    expect(canonical.ports.length).toBeGreaterThanOrEqual(700);
    expect(canonical.ports.length).toBeLessThanOrEqual(803);

    // Inland cities must be excluded.
    for (const inlandCode of ['SARYP', 'USDAL', 'USATL', 'USSLC', 'BRMAO', 'CACAL', 'USDEN']) {
      expect(portByCode.has(inlandCode)).toBe(false);
    }

    // Concrete maritime terminal assertions & cleaned country display names.
    expect(portByCode.get('AEJEA')).toMatchObject({
      code: 'AEJEA',
      name: 'Jebel Ali',
      country: 'United Arab Emirates',
      isCuratedHub: true,
    });
    expect(portByCode.get('TWKHH')).toMatchObject({
      code: 'TWKHH',
      name: 'Kaohsiung',
      isCuratedHub: true,
    });
    expect(portByCode.get('NLRTM')).toMatchObject({
      code: 'NLRTM',
      name: 'Rotterdam',
      country: 'Netherlands',
      isCuratedHub: true,
    });

    // Country trade edges populated and mapped to clean Country nodes.
    const countryByCode = new Map(canonical.countries.map((c) => [c.code, c]));
    const nlrtm = portByCode.get('NLRTM');
    expect(nlrtm?.toCountries.length).toBeGreaterThan(20);
    for (const cCode of nlrtm?.toCountries ?? []) {
      expect(countryByCode.get(cCode)?.name.length).toBeGreaterThan(0);
    }

    // Deterministic ranking: contiguous 1..N and curated hubs ranked first.
    expect(canonical.ports.map((p) => p.rank)).toEqual(
      canonical.ports.map((_, idx) => idx + 1),
    );
    const curatedRanks = canonical.ports.filter((p) => p.isCuratedHub).map((p) => p.rank);
    expect(Math.max(...curatedRanks)).toBe(rawCatalog.curatedHubPorts.length);
  });

  it('cut-audit fails closed when south_africa bypass patching is disabled (negative control)', () => {
    expect(() =>
      buildGraph({
        marnetGeoJson: rawMarnetGeoJson,
        portsGeoJson: rawPortsGeoJson,
        catalog: rawCatalog,
        patchSouthAfricaBypass: false,
      }),
    ).toThrow(EtlInvariantError);
  });

  it('fails closed on malformed GeoJSON geometry inputs', () => {
    const badMarnet = {
      type: 'FeatureCollection',
      features: [
        ...rawMarnetGeoJson.features.slice(0, 24),
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] },
        },
      ],
    };
    expect(() =>
      buildGraph({
        marnetGeoJson: badMarnet,
        portsGeoJson: rawPortsGeoJson,
        catalog: rawCatalog,
        patchSouthAfricaBypass: false,
        skipCutAudit: true,
      }),
    ).toThrow(EtlInvariantError);
  });

  it('projects identical deterministic IDs to WASM payload and MapLibre GeoJSON matching built artifacts', () => {
    const wasmPayload = projectToWasmPayload(canonical, rawCatalog);
    const mapGeoJson = projectToMapLibreGeoJson(canonical);

    const wasmEdgeIds = Object.values(wasmPayload.edgesByRelType)
      .flat()
      .map((tuple) => tuple[0])
      .sort();
    const mapEdgeIds = mapGeoJson.features.map((f) => f.properties.id).sort();
    const canonicalEdgeIds = canonical.edges.map((e) => e.id).sort();

    expect(wasmEdgeIds).toEqual(canonicalEdgeIds);
    expect(mapEdgeIds).toEqual(canonicalEdgeIds);
    expect(Object.keys(wasmPayload.edgesByRelType).sort()).toEqual(
      [rawCatalog.openSeaRelType, ...rawCatalog.passages.map((p) => p.relType)].sort(),
    );

    // Verify committed build artifacts match deterministic output & SHA-256 checksum.
    const committedReceipt = JSON.parse(
      readFileSync(resolve(ROOT_DIR, 'data/build-receipt.json'), 'utf8'),
    ) as BuildReceipt;
    expect(committedReceipt).toEqual(canonical.receipt);

    const expectedSha = readFileSync(resolve(ROOT_DIR, 'data/chokepoint.rl.sha256'), 'utf8')
      .trim()
      .split(/\s+/)[0];
    const actualSha = createHash('sha256')
      .update(readFileSync(resolve(ROOT_DIR, 'data/chokepoint.rl')))
      .digest('hex');
    expect(actualSha).toBe(expectedSha);
  });
});

describe('Seam 1 — verifyParity comparator fail-closed behavior', () => {
  const receipt = JSON.parse(
    readFileSync(resolve(ROOT_DIR, 'data/build-receipt.json'), 'utf8'),
  ) as BuildReceipt;

  function makeMatchingSnapshot(runtime: string): ParitySnapshot {
    const edgesByRelType: Record<string, number> = {};
    for (const [relType, count] of Object.entries(receipt.graph.edges_by_rel_type)) {
      edgesByRelType[relType] =
        relType === 'SEA_OPEN' ? count + receipt.graph.port_link_edges : count;
    }

    const routes = Object.entries(receipt.golden_route_baselines).flatMap(([scenarioId, list]) =>
      list.map((r) => ({
        scenarioId,
        routeId: r.routeId,
        fromCode: r.from,
        toCode: r.to,
        hops: r.hops,
        totalKm: r.totalKm,
        isolated: r.isolated,
      })),
    );

    const isolations = Object.values(receipt.isolation_baselines).map((iso) => ({
      presetId: iso.presetId,
      isolatedCount: iso.isolatedPorts,
      isolatedCodes: Array.from({ length: iso.isolatedPorts }, (_, i) => `P${i}`),
    }));

    return {
      runtime,
      counts: {
        waypoints: receipt.graph.waypoints,
        ports: receipt.graph.ports,
        countries: receipt.graph.countries,
        tradesWith: receipt.graph.trades_with_edges,
        totalMaritimeAndPortEdges: receipt.graph.total_sea_and_passage_edges,
        edgesByRelType,
      },
      routes,
      isolations,
      hormuzTopCountries: [{ countryCode: 'AE', countryName: 'United Arab Emirates', exposedPorts: 11 }],
    };
  }

  it('passes with zero diffs when native and wasm snapshots match receipt, and catches divergences', () => {
    const nativeSnap = makeMatchingSnapshot('native-cli');
    const wasmSnap = makeMatchingSnapshot('relate-wasm');
    expect(compareParitySnapshots(nativeSnap, wasmSnap, receipt)).toEqual([]);

    // Drift in WASM route totalKm must fail.
    const kmDriftWasm: ParitySnapshot = {
      ...wasmSnap,
      routes: wasmSnap.routes.map((r, idx) =>
        idx === 0 ? { ...r, totalKm: (r.totalKm ?? 0) + 12.5 } : r,
      ),
    };
    const kmDiffs = compareParitySnapshots(nativeSnap, kmDriftWasm, receipt);
    expect(kmDiffs.some((d) => d.includes('totalKm mismatch'))).toBe(true);

    // Unexpected 0-row / null isolation count must fail closed.
    const zeroIsoWasm: ParitySnapshot = {
      ...wasmSnap,
      isolations: wasmSnap.isolations.map((iso) =>
        iso.presetId === 'hormuz' ? { ...iso, isolatedCount: 0, isolatedCodes: [] } : iso,
      ),
    };
    const isoDiffs = compareParitySnapshots(nativeSnap, zeroIsoWasm, receipt);
    expect(isoDiffs.some((d) => d.includes('hormuz'))).toBe(true);

    // Node count mismatch must fail closed.
    const countDriftNative: ParitySnapshot = {
      ...nativeSnap,
      counts: { ...nativeSnap.counts, ports: nativeSnap.counts.ports - 1 },
    };
    const countDiffs = compareParitySnapshots(countDriftNative, wasmSnap, receipt);
    expect(countDiffs.some((d) => d.includes('native count "ports" mismatch'))).toBe(true);

    // Simultaneous null or NaN totalKm on a reachable route must fail closed.
    const reachableIdx = nativeSnap.routes.findIndex((r) => !r.isolated);
    expect(reachableIdx).toBeGreaterThanOrEqual(0);
    const nullKmNative: ParitySnapshot = {
      ...nativeSnap,
      routes: nativeSnap.routes.map((r, idx) => (idx === reachableIdx ? { ...r, totalKm: null } : r)),
    };
    const nullKmWasm: ParitySnapshot = {
      ...wasmSnap,
      routes: wasmSnap.routes.map((r, idx) => (idx === reachableIdx ? { ...r, totalKm: null } : r)),
    };
    const nullKmDiffs = compareParitySnapshots(nullKmNative, nullKmWasm, receipt);
    expect(nullKmDiffs.length).toBeGreaterThan(0);
    expect(nullKmDiffs.some((d) => d.includes('totalKm'))).toBe(true);

    const nanKmNative: ParitySnapshot = {
      ...nativeSnap,
      routes: nativeSnap.routes.map((r, idx) => (idx === reachableIdx ? { ...r, totalKm: Number.NaN } : r)),
    };
    const nanKmWasm: ParitySnapshot = {
      ...wasmSnap,
      routes: wasmSnap.routes.map((r, idx) => (idx === reachableIdx ? { ...r, totalKm: Number.NaN } : r)),
    };
    const nanKmDiffs = compareParitySnapshots(nanKmNative, nanKmWasm, receipt);
    expect(nanKmDiffs.length).toBeGreaterThan(0);
    expect(nanKmDiffs.some((d) => d.includes('totalKm'))).toBe(true);
  });
});

describe('Seam 1 — loadWasmGraphPayloadIntoRelateDb envelope validation', () => {
  const minimalPayload = {
    schemaVersion: 1 as const,
    generatedFrom: 'test',
    catalogMeta: {
      openSeaRelType: 'SEA_OPEN',
      referenceHubCode: 'NLRTM',
      fallbackReferenceHubCode: 'SGSIN',
      staticRelTypes: ['SEA_OPEN'],
      defaultBlockedPassages: ['northwest'],
    },
    waypoints: [],
    countries: [],
    ports: [],
    edgesByRelType: { SEA_OPEN: [] },
    tradesWith: [],
  };

  it('rejects malformed non-envelope JSON and error envelopes while preserving batch label', () => {
    expect(() =>
      loadWasmGraphPayloadIntoRelateDb({ execute: () => '{}' }, minimalPayload),
    ).toThrow(/index_0/);

    expect(() =>
      loadWasmGraphPayloadIntoRelateDb({ execute: () => '[]' }, minimalPayload),
    ).toThrow(/index_0/);

    expect(() =>
      loadWasmGraphPayloadIntoRelateDb(
        { execute: () => JSON.stringify({ error: { message: 'syntax failed' } }) },
        minimalPayload,
      ),
    ).toThrow(/index_0.*syntax failed/);

    const ok = loadWasmGraphPayloadIntoRelateDb(
      { execute: () => JSON.stringify({ columns: [], rows: [] }) },
      minimalPayload,
    );
    expect(ok.batchesExecuted).toBeGreaterThan(0);
  });
});
