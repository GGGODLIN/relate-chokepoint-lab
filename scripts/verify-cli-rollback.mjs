import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseRelateEnvelope } from '../src/engine/probe.ts';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const GOLDEN_RL_PATH = resolve(ROOT_DIR, 'data/chokepoint.rl');
const GOLDEN_SHA256_PATH = resolve(ROOT_DIR, 'data/chokepoint.rl.sha256');
const ROLLBACK_CYPHER_PATH = resolve(ROOT_DIR, 'scripts/cypher/whatif-rollback.cypher');

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

function stripCypherComments(script) {
  return (
    script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
      .trim() + '\n'
  );
}

function main() {
  const relateBin = resolveRelateBin();
  const expectedChecksum = readFileSync(GOLDEN_SHA256_PATH, 'utf8').trim().split(/\s+/)[0];
  const shaBefore = sha256File(GOLDEN_RL_PATH);
  if (!expectedChecksum || shaBefore !== expectedChecksum) {
    throw new Error(
      `Golden data/chokepoint.rl SHA-256 mismatch before rollback test: expected ${expectedChecksum}, got ${shaBefore}`,
    );
  }

  const rawScript = readFileSync(ROLLBACK_CYPHER_PATH, 'utf8');
  const scriptInput = stripCypherComments(rawScript);

  const workDir = mkdtempSync(join(tmpdir(), 'relate-chokepoint-rollback-'));
  const clonePath = join(workDir, 'chokepoint-whatif.rl');
  let rawOutput = '';

  try {
    // Isolate mutations in a fresh clone because Relate runs final_checkpoint() on normal exit.
    execFileSync(relateBin, ['clone', GOLDEN_RL_PATH, clonePath], {
      encoding: 'utf8',
    });

    rawOutput = execFileSync(
      relateBin,
      ['query', '--database', clonePath, '--mode', 'envelope', '--max-rows', '0'],
      {
        input: scriptInput,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const shaAfter = sha256File(GOLDEN_RL_PATH);
  if (shaBefore !== shaAfter) {
    throw new Error(
      `Golden data/chokepoint.rl SHA-256 changed after clone rollback test: ${shaBefore} -> ${shaAfter}`,
    );
  }

  const envelopes = rawOutput
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => parseRelateEnvelope(line));

  for (const [idx, env] of envelopes.entries()) {
    if (env.error !== null) {
      throw new Error(`Rollback script statement[${idx}] failed: ${env.error}`);
    }
  }

  const rowsByStage = new Map();
  for (const env of envelopes) {
    for (const row of env.rows) {
      if (typeof row.stage === 'string') {
        rowsByStage.set(row.stage, row);
      }
    }
  }

  const stage1Route = rowsByStage.get('1_baseline');
  const stage1Edges = rowsByStage.get('1_baseline_edges');
  const stage2Edges = rowsByStage.get('2_blocked_edges');
  const stage2Route = rowsByStage.get('2_blocked_in_tx');
  const stage3Edges = rowsByStage.get('3_after_rollback_edges');
  const stage3Route = rowsByStage.get('3_after_rollback');

  if (!stage1Route || !stage1Edges || !stage2Edges || !stage2Route || !stage3Edges || !stage3Route) {
    throw new Error(
      `Missing expected rollback stages; observed stages: ${JSON.stringify([...rowsByStage.keys()])}`,
    );
  }

  if (typeof stage1Edges.corridorEdges !== 'number' || stage1Edges.corridorEdges <= 0) {
    throw new Error(`Expected baseline corridorEdges > 0, got ${JSON.stringify(stage1Edges)}`);
  }
  if (stage2Edges.corridorEdges !== 0) {
    throw new Error(
      `Expected blocked-in-tx corridorEdges === 0, got ${JSON.stringify(stage2Edges)}`,
    );
  }
  if (stage3Edges.corridorEdges !== stage1Edges.corridorEdges) {
    throw new Error(
      `Post-rollback corridorEdges mismatch: baseline=${stage1Edges.corridorEdges}, after=${stage3Edges.corridorEdges}`,
    );
  }

  if (
    typeof stage1Route.hops !== 'number' ||
    typeof stage2Route.hops !== 'number' ||
    typeof stage1Route.totalKm !== 'number' ||
    typeof stage2Route.totalKm !== 'number'
  ) {
    throw new Error('Missing numeric hops/totalKm on stage 1 or stage 2 route');
  }

  if (stage2Route.hops <= stage1Route.hops || stage2Route.totalKm <= stage1Route.totalKm) {
    throw new Error(
      `Expected stage 2 blockade detour > baseline: stage1=${JSON.stringify(stage1Route)}, stage2=${JSON.stringify(stage2Route)}`,
    );
  }

  if (
    stage3Route.hops !== stage1Route.hops ||
    stage3Route.totalKm !== stage1Route.totalKm ||
    stage3Route.fromCode !== stage1Route.fromCode ||
    stage3Route.toCode !== stage1Route.toCode
  ) {
    throw new Error(
      `Post-rollback route does not match baseline: baseline=${JSON.stringify(stage1Route)}, after=${JSON.stringify(stage3Route)}`,
    );
  }

  const detourDeltaKm = Math.round((stage2Route.totalKm - stage1Route.totalKm) * 10) / 10;
  console.log(
    JSON.stringify(
      {
        status: 'ok',
        relateBin,
        cloneCleanedUp: !existsSync(workDir),
        goldenSha256Before: shaBefore,
        goldenSha256After: shaAfter,
        goldenUnchanged: shaBefore === shaAfter,
        stages: {
          baseline: {
            ...stage1Route,
            corridorEdges: stage1Edges.corridorEdges,
          },
          blockedInTx: {
            ...stage2Route,
            corridorEdges: stage2Edges.corridorEdges,
            detourDeltaKm,
          },
          afterRollback: {
            ...stage3Route,
            corridorEdges: stage3Edges.corridorEdges,
          },
        },
      },
      null,
      2,
    ),
  );
}

main();
