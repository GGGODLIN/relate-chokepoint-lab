import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { initSync, RelateDb } from '@relate/relate-wasm';
import { parseRelateEnvelope } from '../src/engine/probe.ts';
import {
  collectRuntimeParitySnapshot,
  compareParitySnapshots,
} from '../src/etl/parity.ts';
import {
  DEFAULT_UNWIND_CHUNK_SIZE,
  loadWasmGraphPayloadIntoRelateDb,
} from '../src/etl/relate-loader.ts';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const CATALOG_PATH = resolve(ROOT_DIR, 'contracts/chokepoint-catalog.json');
const RECEIPT_PATH = resolve(ROOT_DIR, 'data/build-receipt.json');
const GOLDEN_RL_PATH = resolve(ROOT_DIR, 'data/chokepoint.rl');
const GOLDEN_SHA256_PATH = resolve(ROOT_DIR, 'data/chokepoint.rl.sha256');
const WASM_JSON_PATH = resolve(ROOT_DIR, 'public/data/graph.wasm.json');

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

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function verifyGoldenChecksum() {
  const expectedLine = readFileSync(GOLDEN_SHA256_PATH, 'utf8').trim();
  const expectedHash = expectedLine.split(/\s+/)[0];
  const actualHash = sha256File(GOLDEN_RL_PATH);
  if (!expectedHash || actualHash !== expectedHash) {
    throw new Error(
      `Golden data/chokepoint.rl SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`,
    );
  }
  return actualHash;
}

function createNativeRunner(relateBin, dbPath) {
  return (cypher, params) => {
    const args = [
      '--database',
      dbPath,
      '--read-only',
      '--mode',
      'envelope',
      '--max-rows',
      '0',
    ];
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        args.push('--param', `${key}=${JSON.stringify(value)}`);
      }
    }
    args.push('-c', cypher);
    const raw = execFileSync(relateBin, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
    const env = parseRelateEnvelope(raw);
    if (env.error !== null) {
      throw new Error(`Native CLI query failed: ${env.error}\nCypher:\n${cypher}`);
    }
    return env.rows;
  };
}

function createWasmRunner(db) {
  return (cypher, params) => {
    const paramsJson = params !== null ? JSON.stringify(params) : null;
    const raw = db.execute(cypher, paramsJson);
    const env = parseRelateEnvelope(raw);
    if (env.error !== null) {
      throw new Error(`WASM query failed: ${env.error}\nCypher:\n${cypher}`);
    }
    return env.rows;
  };
}

function main() {
  const checksumBefore = verifyGoldenChecksum();
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const receipt = JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'));
  const wasmPayload = JSON.parse(readFileSync(WASM_JSON_PATH, 'utf8'));
  const relateBin = resolveRelateBin();

  const tNativeStart = performance.now();
  const nativeSnap = collectRuntimeParitySnapshot(
    'native-cli',
    catalog,
    createNativeRunner(relateBin, GOLDEN_RL_PATH),
  );
  const nativeQueryMs = Math.round(performance.now() - tNativeStart);

  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('@relate/relate-wasm/relate_bg.wasm');
  initSync({ module: readFileSync(wasmPath) });

  const db = new RelateDb();
  let wasmBootStats;
  let wasmSnap;
  let wasmQueryMs;
  try {
    wasmBootStats = loadWasmGraphPayloadIntoRelateDb(db, wasmPayload, DEFAULT_UNWIND_CHUNK_SIZE);
    const tWasmStart = performance.now();
    wasmSnap = collectRuntimeParitySnapshot('relate-wasm', catalog, createWasmRunner(db));
    wasmQueryMs = Math.round(performance.now() - tWasmStart);
  } finally {
    db.free();
  }

  const checksumAfter = sha256File(GOLDEN_RL_PATH);
  const diffs = compareParitySnapshots(nativeSnap, wasmSnap, receipt);
  if (checksumBefore !== checksumAfter) {
    diffs.push(
      `golden data/chokepoint.rl mutated during --read-only parity check: ${checksumBefore} -> ${checksumAfter}`,
    );
  }

  const report = {
    status: diffs.length === 0 ? 'ok' : 'mismatch',
    goldenSha256: checksumAfter,
    goldenUnchanged: checksumBefore === checksumAfter,
    timingsMs: {
      nativeQueriesTotal: nativeQueryMs,
      wasmBoot: wasmBootStats.elapsedMs,
      wasmQueriesTotal: wasmQueryMs,
    },
    counts: nativeSnap.counts,
    isolations: nativeSnap.isolations.map((i) => ({
      presetId: i.presetId,
      isolatedCount: i.isolatedCount,
      topSample: i.isolatedCodes.slice(0, 5),
    })),
    goldenRoutesOpen: nativeSnap.routes.filter((r) => r.scenarioId === 'open'),
    goldenRoutesSuezBlocked: nativeSnap.routes.filter((r) => r.scenarioId === 'suez-babalmandab'),
    hormuzTopCountries: nativeSnap.hormuzTopCountries.slice(0, 5),
    diffCount: diffs.length,
    diffs,
  };

  console.log(JSON.stringify(report, null, 2));
  if (diffs.length > 0) {
    process.exitCode = 1;
  }
}

main();
