import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROBE_BLOCKED_SUEZ_CYPHER,
  PROBE_INDEX_CYPHER,
  PROBE_OPEN_ROUTE_CYPHER,
  PROBE_SEED_CYPHER,
  parseRelateEnvelope,
  probeRelateWasm,
} from '../src/engine/probe.ts';

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
      ['--database', dbPath, '--mode', 'envelope', '--max-rows', '0', '-c', `${PROBE_SEED_CYPHER}; ${PROBE_INDEX_CYPHER}`],
      { encoding: 'utf8' },
    );
    const seedEnvelopes = seedOut
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => parseRelateEnvelope(line));
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
        PROBE_OPEN_ROUTE_CYPHER,
      ],
      { encoding: 'utf8' },
    ).trim();
    const openEnvelope = parseRelateEnvelope(openOut);
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
        PROBE_BLOCKED_SUEZ_CYPHER,
      ],
      { encoding: 'utf8' },
    ).trim();
    const blockedEnvelope = parseRelateEnvelope(blockedOut);
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
  const result = probeRelateWasm();
  assertEnvelopeOk(result.openRouteEnvelope, 'wasm openRoute');
  assertExpectedRoute(result.openRouteEnvelope.rows[0], 2, 15700, 'wasm openRoute');
  assertEnvelopeOk(result.blockedRouteEnvelope, 'wasm blockedRoute');
  assertExpectedRoute(result.blockedRouteEnvelope.rows[0], 3, 24000, 'wasm blockedRoute');

  return {
    version: result.wasmPackageVersion,
    pointIndex: result.indexEnvelope,
    openRoute: result.openRouteEnvelope,
    blockedRoute: result.blockedRouteEnvelope,
  };
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
        openRouteExecuteMs: native.openRoute.executeMs ?? null,
      },
      wasm: {
        version: wasm.version,
        pointIndexAdded: wasm.pointIndex.stats.indexes_added ?? null,
        openRouteRow: wasm.openRoute.rows[0],
        blockedRouteRow: wasm.blockedRoute.rows[0],
        openRouteError: wasm.openRoute.error,
        blockedRouteError: wasm.blockedRoute.error,
        openRouteExecuteMs: wasm.openRoute.executeMs ?? null,
      },
    },
    null,
    2,
  ),
);
