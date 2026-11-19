import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initSync, RelateDb } from '@relate/relate-wasm';

const SEED_CYPHER = `
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

const INDEX_CYPHER =
  'CREATE POINT INDEX probe_port_loc_idx IF NOT EXISTS FOR (p:Port) ON (p.loc)';

const OPEN_ROUTE_CYPHER = `
MATCH (a:Port {code: $from}), (b:Port {code: $to})
MATCH p = shortestPath((a)-[:SEA_OPEN|PASSAGE_SUEZ|PASSAGE_SOUTH_AFRICA*]-(b))
RETURN a.code AS fromCode,
       b.code AS toCode,
       length(p) AS hops,
       reduce(km = 0.0, r IN relationships(p) | km + r.km) AS totalKm
`.trim();

const BLOCKED_SUEZ_CYPHER = `
MATCH (a:Port {code: $from}), (b:Port {code: $to})
MATCH p = shortestPath((a)-[:SEA_OPEN|PASSAGE_SOUTH_AFRICA*]-(b))
RETURN a.code AS fromCode,
       b.code AS toCode,
       length(p) AS hops,
       reduce(km = 0.0, r IN relationships(p) | km + r.km) AS totalKm
`.trim();

function resolveRelateBin() {
  if (process.env.RELATE_BIN) {
    return process.env.RELATE_BIN;
  }
  const localBin = join(homedir(), '.local', 'bin', 'relate');
  if (existsSync(localBin)) {
    return localBin;
  }
  return 'relate';
}

function parseSemver(versionOutput) {
  const match = /v(\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  if (!match) {
    throw new Error(`Unable to parse Relate version from output: ${JSON.stringify(versionOutput)}`);
  }
  return {
    raw: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isAtLeast(ver, major, minor, patch) {
  if (ver.major !== major) return ver.major > major;
  if (ver.minor !== minor) return ver.minor > minor;
  return ver.patch >= patch;
}

function assertEnvelopeOk(envelope, label) {
  const err = envelope.error ?? null;
  if (err !== null) {
    throw new Error(`${label} returned error: ${JSON.stringify(err)}`);
  }
  if (!Array.isArray(envelope.columns) || !Array.isArray(envelope.rows)) {
    throw new Error(`${label} missing columns/rows arrays`);
  }
}

function assertExpectedRoute(row, expectedHops, expectedKm, label) {
  if (
    !row ||
    row.fromCode !== 'TWKHH' ||
    row.toCode !== 'NLRTM' ||
    row.hops !== expectedHops ||
    row.totalKm !== expectedKm
  ) {
    throw new Error(
      `${label} row mismatch: expected {TWKHH->NLRTM, hops:${expectedHops}, totalKm:${expectedKm}}, got ${JSON.stringify(row)}`,
    );
  }
}

function runNativeProbe() {
  const relateBin = resolveRelateBin();
  const versionText = execFileSync(relateBin, ['--version'], { encoding: 'utf8' }).trim();
  const parsedVersion = parseSemver(versionText);
  if (!isAtLeast(parsedVersion, 1, 1, 0)) {
    throw new Error(`Expected relate CLI >= v1.1.0, found ${parsedVersion.raw}`);
  }

  const workDir = mkdtempSync(join(tmpdir(), 'relate-chokepoint-probe-'));
  const dbPath = join(workDir, 'probe.rl');
  try {
    const seedOut = execFileSync(
      relateBin,
      ['--database', dbPath, '--mode', 'envelope', '--max-rows', '0', '-c', `${SEED_CYPHER}; ${INDEX_CYPHER}`],
      { encoding: 'utf8' },
    );
    const seedEnvelopes = seedOut
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    for (const [idx, env] of seedEnvelopes.entries()) {
      assertEnvelopeOk(env, `native seed[${idx}]`);
    }

    const openOut = execFileSync(
      relateBin,
      [
        '--database',
        dbPath,
        '--read-only',
        '--mode',
        'envelope',
        '--max-rows',
        '0',
        '--param',
        'from=TWKHH',
        '--param',
        'to=NLRTM',
        '-c',
        OPEN_ROUTE_CYPHER,
      ],
      { encoding: 'utf8' },
    ).trim();
    const openEnvelope = JSON.parse(openOut);
    assertEnvelopeOk(openEnvelope, 'native openRoute');
    assertExpectedRoute(openEnvelope.rows[0], 2, 15700, 'native openRoute');

    const blockedOut = execFileSync(
      relateBin,
      [
        '--database',
        dbPath,
        '--read-only',
        '--mode',
        'envelope',
        '--max-rows',
        '0',
        '--param',
        'from=TWKHH',
        '--param',
        'to=NLRTM',
        '-c',
        BLOCKED_SUEZ_CYPHER,
      ],
      { encoding: 'utf8' },
    ).trim();
    const blockedEnvelope = JSON.parse(blockedOut);
    assertEnvelopeOk(blockedEnvelope, 'native blockedRoute');
    assertExpectedRoute(blockedEnvelope.rows[0], 3, 24000, 'native blockedRoute');

    return {
      bin: relateBin,
      version: parsedVersion.raw,
      openRoute: openEnvelope,
      blockedRoute: blockedEnvelope,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function runWasmProbe() {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('@relate/relate-wasm/relate_bg.wasm');
  const pkg = JSON.parse(readFileSync(join(dirname(wasmPath), 'package.json'), 'utf8'));
  initSync({ module: readFileSync(wasmPath) });

  const db = new RelateDb();
  try {
    const seedEnvelope = JSON.parse(db.execute(SEED_CYPHER, null));
    assertEnvelopeOk(seedEnvelope, 'wasm seed');

    const indexEnvelope = JSON.parse(db.execute(INDEX_CYPHER, null));
    assertEnvelopeOk(indexEnvelope, 'wasm pointIndex');

    const paramsJson = JSON.stringify({ from: 'TWKHH', to: 'NLRTM' });
    const openEnvelope = JSON.parse(db.execute(OPEN_ROUTE_CYPHER, paramsJson));
    assertEnvelopeOk(openEnvelope, 'wasm openRoute');
    assertExpectedRoute(openEnvelope.rows[0], 2, 15700, 'wasm openRoute');

    const blockedEnvelope = JSON.parse(db.execute(BLOCKED_SUEZ_CYPHER, paramsJson));
    assertEnvelopeOk(blockedEnvelope, 'wasm blockedRoute');
    assertExpectedRoute(blockedEnvelope.rows[0], 3, 24000, 'wasm blockedRoute');

    return {
      version: pkg.version,
      pointIndex: indexEnvelope,
      openRoute: openEnvelope,
      blockedRoute: blockedEnvelope,
    };
  } finally {
    db.free();
  }
}

const native = runNativeProbe();
const wasm = runWasmProbe();

console.log(
  JSON.stringify(
    {
      status: 'ok',
      native: {
        bin: native.bin,
        version: native.version,
        openRouteRow: native.openRoute.rows[0],
        blockedRouteRow: native.blockedRoute.rows[0],
        openRouteExecuteMs: native.openRoute.timings?.execute_ms ?? null,
      },
      wasm: {
        version: wasm.version,
        pointIndexAdded: wasm.pointIndex.stats?.indexes_added ?? null,
        openRouteRow: wasm.openRoute.rows[0],
        blockedRouteRow: wasm.blockedRoute.rows[0],
        openRouteError: wasm.openRoute.error,
        blockedRouteError: wasm.blockedRoute.error,
        openRouteExecuteMs: wasm.openRoute.execute_ms ?? null,
      },
    },
    null,
    2,
  ),
);
