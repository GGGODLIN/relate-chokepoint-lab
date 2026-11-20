import initRelateWasm from '@relate/relate-wasm';
import { isWasmTrap } from '@relate/relate-wasm/trap.js';
import type { WasmGraphPayload } from '../etl/build-graph.ts';
import { ChokepointEngine, RelateQueryError } from './chokepoint-engine.ts';
import type { WorkerRequest, WorkerResponse } from './worker-protocol.ts';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

let wasmReadyPromise: Promise<unknown> | null = null;
let engine: ChokepointEngine | null = null;

async function ensureWasmReady(): Promise<void> {
  if (wasmReadyPromise === null) {
    wasmReadyPromise = initRelateWasm();
  }
  await wasmReadyPromise;
}

function getOrCreateEngine(): ChokepointEngine {
  if (engine === null) {
    engine = new ChokepointEngine();
  }
  return engine;
}

async function resolvePayload(
  payload: WasmGraphPayload | undefined,
  payloadUrl: string | undefined,
): Promise<WasmGraphPayload> {
  if (payload !== undefined) {
    return payload;
  }
  if (payloadUrl === undefined) {
    throw new Error('boot request must supply either payload or payloadUrl');
  }
  const response = await fetch(payloadUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch canonical WASM graph from "${payloadUrl}": HTTP ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as WasmGraphPayload;
}

async function handleRequest(msg: WorkerRequest): Promise<unknown> {
  await ensureWasmReady();

  switch (msg.type) {
    case 'boot': {
      const payload = await resolvePayload(msg.payload, msg.payloadUrl);
      return getOrCreateEngine().boot(payload, msg.chunkSize);
    }
    case 'queryRoute': {
      return getOrCreateEngine().queryRoute(
        msg.fromCode,
        msg.toCode,
        msg.blockedPassageIds,
        { profile: msg.profile },
      );
    }
    case 'evaluateScenario': {
      return getOrCreateEngine().evaluateScenario(msg.request);
    }
    case 'applyCustomBoxes': {
      return getOrCreateEngine().applyCustomBoxes(msg.boxes, { limit: msg.limit });
    }
    case 'runCustomCypher': {
      return getOrCreateEngine().runCustomCypher(msg.cypher, msg.params ?? null, {
        profile: msg.profile,
      });
    }
    case 'getPorts': {
      return getOrCreateEngine().getPorts();
    }
  }
}

workerScope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  void handleRequest(msg).then(
    (data) => {
      const reply: WorkerResponse = { type: 'result', id: msg.id, data };
      workerScope.postMessage(reply);
    },
    (err: unknown) => {
      const wasmTrap = isWasmTrap(err);
      if (wasmTrap && engine !== null) {
        // Poisoned WASM instance must never be reused; drop handle before main thread terminates worker.
        engine = null;
      }

      const message = err instanceof Error ? err.message : String(err);
      const cypher =
        err instanceof RelateQueryError
          ? err.cypher
          : msg.type === 'runCustomCypher'
            ? msg.cypher
            : null;
      const telemetry = err instanceof RelateQueryError ? err.telemetry : null;

      const reply: WorkerResponse = {
        type: 'error',
        id: msg.id,
        message,
        wasmTrap,
        cypher,
        telemetry,
      };
      workerScope.postMessage(reply);
    },
  );
});
