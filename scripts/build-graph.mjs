import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  buildGraph,
  projectToMapLibreGeoJson,
  projectToWasmPayload,
} from '../src/etl/build-graph.ts';
import {
  DEFAULT_UNWIND_CHUNK_SIZE,
  generateSeedBatches,
} from '../src/etl/relate-loader.ts';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const CATALOG_PATH = resolve(ROOT_DIR, 'contracts/chokepoint-catalog.json');
const MARNET_RAW_PATH = resolve(ROOT_DIR, 'data/raw/marnet_searoute.geojson');
const PORTS_RAW_PATH = resolve(ROOT_DIR, 'data/raw/ports.geojson');

const CANONICAL_PATH = resolve(ROOT_DIR, 'data/graph.canonical.json');
const RECEIPT_PATH = resolve(ROOT_DIR, 'data/build-receipt.json');
const GOLDEN_RL_PATH = resolve(ROOT_DIR, 'data/chokepoint.rl');
const GOLDEN_SHA256_PATH = resolve(ROOT_DIR, 'data/chokepoint.rl.sha256');
const WASM_JSON_PATH = resolve(ROOT_DIR, 'public/data/graph.wasm.json');
const MAPLIBRE_GEOJSON_PATH = resolve(ROOT_DIR, 'public/data/marnet.map.geojson');

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

function assertEnvelopeOk(rawOutput, label) {
  const lines = rawOutput
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`${label} produced empty envelope output`);
  }
  for (const [idx, line] of lines.entries()) {
    const env = JSON.parse(line);
    if (env.error !== null && env.error !== undefined) {
      throw new Error(`${label}[${idx}] failed: ${JSON.stringify(env.error)}`);
    }
  }
}

function buildNativeGoldenStore(wasmPayload) {
  const relateBin = resolveRelateBin();
  const workDir = mkdtempSync(join(tmpdir(), 'relate-chokepoint-build-'));
  const tempDbPath = join(workDir, 'chokepoint.rl');
  try {
    const batches = generateSeedBatches(wasmPayload, DEFAULT_UNWIND_CHUNK_SIZE);

    // Combine index DDL statements into a single call, then run each UNWIND batch via --fetch-params.
    const indexBatches = batches.filter((b) => b.rows === null);
    const dataBatches = batches.filter((b) => b.rows !== null);

    if (indexBatches.length > 0) {
      const ddlScript = indexBatches.map((b) => `${b.cypher};`).join('\n') + '\n';
      const out = execFileSync(
        relateBin,
        ['query', '--database', tempDbPath, '--mode', 'envelope', '--max-rows', '0'],
        { input: ddlScript, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      assertEnvelopeOk(out, 'native schema indexes');
    }

    for (const batch of dataBatches) {
      const paramPath = join(workDir, `${batch.label}.json`);
      writeFileSync(paramPath, JSON.stringify(batch.rows));
      const out = execFileSync(
        relateBin,
        [
          '--database',
          tempDbPath,
          '--mode',
          'envelope',
          '--max-rows',
          '0',
          '--fetch-params',
          `rows=${paramPath}`,
          '-c',
          batch.cypher,
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      assertEnvelopeOk(out, `native seed ${batch.label}`);
    }

    mkdirSync(dirname(GOLDEN_RL_PATH), { recursive: true });
    copyFileSync(tempDbPath, GOLDEN_RL_PATH);
    const digest = sha256File(GOLDEN_RL_PATH);
    writeFileSync(GOLDEN_SHA256_PATH, `${digest}  data/chokepoint.rl\n`, 'utf8');
    return { digest, batchesExecuted: batches.length, relateBin };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function main() {
  const t0 = performance.now();
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const marnetGeoJson = JSON.parse(readFileSync(MARNET_RAW_PATH, 'utf8'));
  const portsGeoJson = JSON.parse(readFileSync(PORTS_RAW_PATH, 'utf8'));

  const canonical = buildGraph({ marnetGeoJson, portsGeoJson, catalog });

  mkdirSync(dirname(CANONICAL_PATH), { recursive: true });
  mkdirSync(dirname(WASM_JSON_PATH), { recursive: true });

  // Intermediate SSOT (gitignored, deterministically regenerated on build:graph).
  writeFileSync(CANONICAL_PATH, JSON.stringify(canonical), 'utf8');
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(canonical.receipt, null, 2)}\n`, 'utf8');

  const wasmPayload = projectToWasmPayload(canonical, catalog);
  writeFileSync(WASM_JSON_PATH, JSON.stringify(wasmPayload), 'utf8');

  const mapGeoJson = projectToMapLibreGeoJson(canonical);
  writeFileSync(MAPLIBRE_GEOJSON_PATH, JSON.stringify(mapGeoJson), 'utf8');

  const nativeResult = buildNativeGoldenStore(wasmPayload);
  const elapsedMs = Math.round(performance.now() - t0);

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        elapsedMs,
        relateBin: nativeResult.relateBin,
        seedBatches: nativeResult.batchesExecuted,
        chokepointRlSha256: nativeResult.digest,
        sizesBytes: {
          'data/graph.canonical.json': statSync(CANONICAL_PATH).size,
          'data/build-receipt.json': statSync(RECEIPT_PATH).size,
          'data/chokepoint.rl': statSync(GOLDEN_RL_PATH).size,
          'public/data/graph.wasm.json': statSync(WASM_JSON_PATH).size,
          'public/data/marnet.map.geojson': statSync(MAPLIBRE_GEOJSON_PATH).size,
        },
        invariants: canonical.receipt.invariants,
        graph: canonical.receipt.graph,
        isolationBaselines: canonical.receipt.isolation_baselines,
      },
      null,
      2,
    ),
  );
}

main();
