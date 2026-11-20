import { isWasmTrap } from '@relate/relate-wasm/trap.js';
import type { WasmGraphPayload } from '../etl/build-graph.ts';
import type {
  BootTelemetry,
  CustomBBoxApplyResult,
  CustomBBoxInput,
  CypherExecutionResult,
  EngineMetadata,
  PortRecord,
  RouteEvaluationResult,
  ScenarioEvaluationRequest,
  ScenarioEvaluationResult,
} from './chokepoint-engine.ts';
import type { QueryTelemetry } from './envelope.ts';
import type { WorkerRequest, WorkerResponse } from './worker-protocol.ts';

export interface WorkerMessageEventLike<T = unknown> {
  readonly data: T;
}

export interface WorkerErrorEventLike {
  readonly message?: string;
  readonly error?: unknown;
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(
    type: 'message',
    listener: (event: WorkerMessageEventLike<WorkerResponse>) => void,
  ): void;
  addEventListener(
    type: 'error',
    listener: (event: WorkerErrorEventLike) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: WorkerMessageEventLike<WorkerResponse>) => void,
  ): void;
  removeEventListener(
    type: 'error',
    listener: (event: WorkerErrorEventLike) => void,
  ): void;
}

export type WorkerFactory = () => WorkerLike;

export interface BootSource {
  readonly payload?: WasmGraphPayload;
  readonly payloadUrl?: string;
  readonly chunkSize?: number;
}

export interface ChokepointWorkerClientOptions {
  readonly workerFactory?: WorkerFactory;
  readonly timeoutMs?: number;
  readonly autoRespawn?: boolean;
}

export interface CallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class StaleRequestError extends Error {
  readonly channel: string;
  readonly supersededId: number;
  readonly newerId: number;

  constructor(channel: string, supersededId: number, newerId: number) {
    super(
      `Request #${supersededId} on channel "${channel}" was superseded by newer request #${newerId}`,
    );
    this.name = 'StaleRequestError';
    this.channel = channel;
    this.supersededId = supersededId;
    this.newerId = newerId;
  }
}

export class WorkerDisposedError extends Error {
  constructor(message = 'ChokepointWorkerClient has been disposed') {
    super(message);
    this.name = 'WorkerDisposedError';
  }
}

export class WorkerTimeoutError extends Error {
  readonly requestType: WorkerRequest['type'];
  readonly timeoutMs: number;
  readonly cypher: string | null;

  constructor(
    requestType: WorkerRequest['type'],
    timeoutMs: number,
    cypher: string | null,
  ) {
    super(`Worker request "${requestType}" timed out after ${timeoutMs} ms`);
    this.name = 'WorkerTimeoutError';
    this.requestType = requestType;
    this.timeoutMs = timeoutMs;
    this.cypher = cypher;
  }
}

export class WasmTrapError extends Error {
  readonly cypher: string | null;
  readonly telemetry: QueryTelemetry | null;

  constructor(
    message: string,
    cypher: string | null,
    telemetry: QueryTelemetry | null = null,
  ) {
    super(`Relate WASM trap detected: ${message}`);
    this.name = 'WasmTrapError';
    this.cypher = cypher;
    this.telemetry = telemetry;
  }
}

export class WorkerRemoteError extends Error {
  readonly cypher: string | null;
  readonly telemetry: QueryTelemetry | null;

  constructor(
    message: string,
    cypher: string | null,
    telemetry: QueryTelemetry | null = null,
  ) {
    super(message);
    this.name = 'WorkerRemoteError';
    this.cypher = cypher;
    this.telemetry = telemetry;
  }
}

interface PendingRequest {
  readonly id: number;
  readonly requestType: WorkerRequest['type'];
  readonly channel: string | null;
  readonly cypher: string | null;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly abortCleanup: (() => void) | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function createDefaultBrowserWorker(): WorkerLike {
  return new Worker(new URL('./chokepoint.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

export class ChokepointWorkerClient {
  private readonly workerFactory: WorkerFactory;
  private readonly timeoutMs: number;
  private readonly autoRespawn: boolean;

  private worker: WorkerLike | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly latestByChannel = new Map<string, number>();
  private readonly latestDispatchTokenByChannel = new Map<string, number>();
  private nextDispatchToken = 1;

  private lastBootSource: BootSource | null = null;
  private lastBootTimeoutMs: number;
  private respawnPromise: Promise<void> | null = null;
  private disposed = false;

  private respawnCount = 0;
  private discardedStaleCount = 0;

  private readonly boundOnMessage: (event: WorkerMessageEventLike<WorkerResponse>) => void;
  private readonly boundOnError: (event: WorkerErrorEventLike) => void;

  constructor(options: ChokepointWorkerClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? createDefaultBrowserWorker;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.lastBootTimeoutMs = this.timeoutMs;
    this.autoRespawn = options.autoRespawn ?? true;

    this.boundOnMessage = (event) => {
      this.handleWorkerMessage(event.data);
    };
    this.boundOnError = (event) => {
      this.handleWorkerErrorEvent(event);
    };
  }

  getStats(): {
    readonly disposed: boolean;
    readonly hasLiveWorker: boolean;
    readonly pendingCount: number;
    readonly respawnCount: number;
    readonly discardedStaleCount: number;
  } {
    return {
      disposed: this.disposed,
      hasLiveWorker: this.worker !== null,
      pendingCount: this.pending.size,
      respawnCount: this.respawnCount,
      discardedStaleCount: this.discardedStaleCount,
    };
  }

  private spawnWorker(): WorkerLike {
    if (this.disposed) {
      throw new WorkerDisposedError();
    }
    if (this.worker !== null) {
      return this.worker;
    }
    const nextWorker = this.workerFactory();
    nextWorker.addEventListener('message', this.boundOnMessage);
    nextWorker.addEventListener('error', this.boundOnError);
    this.worker = nextWorker;
    return nextWorker;
  }

  private terminateCurrentWorker(): void {
    const current = this.worker;
    if (current === null) {
      return;
    }
    this.worker = null;
    current.removeEventListener('message', this.boundOnMessage);
    current.removeEventListener('error', this.boundOnError);
    current.terminate();
  }

  private terminateWorkerForRecovery(): void {
    if (this.worker === null) {
      return;
    }
    this.terminateCurrentWorker();
    this.respawnCount++;
  }

  private clearPendingEntry(entry: PendingRequest): void {
    clearTimeout(entry.timer);
    if (entry.abortCleanup !== null) {
      entry.abortCleanup();
    }
    this.pending.delete(entry.id);
    if (entry.channel !== null && this.latestByChannel.get(entry.channel) === entry.id) {
      this.latestByChannel.delete(entry.channel);
    }
  }

  private rejectAllPending(createError: (entry: PendingRequest) => Error): void {
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      this.clearPendingEntry(entry);
      entry.reject(createError(entry));
    }
  }

  private triggerAutoRespawn(): Promise<void> {
    if (this.disposed || !this.autoRespawn) {
      return Promise.resolve();
    }
    if (this.respawnPromise !== null) {
      return this.respawnPromise;
    }

    const source = this.lastBootSource;
    const bootTimeoutMs = this.lastBootTimeoutMs;
    const promise = (async () => {
      if (this.disposed) {
        throw new WorkerDisposedError();
      }
      const spawned = this.spawnWorker();
      if (source !== null) {
        try {
          await this.sendRawRequest<BootTelemetry>(
            (id) => ({
              type: 'boot',
              id,
              payload: source.payload,
              payloadUrl: source.payloadUrl,
              chunkSize: source.chunkSize,
            }),
            {
              channel: null,
              cypher: null,
              timeoutMs: bootTimeoutMs,
            },
          );
        } catch (err) {
          if (this.worker === spawned) {
            this.terminateCurrentWorker();
          }
          throw err;
        }
      }
      if (this.disposed) {
        this.terminateCurrentWorker();
        throw new WorkerDisposedError();
      }
    })();

    this.respawnPromise = promise;
    // Prevent unhandled rejection if background respawn fails before next caller awaits it.
    void promise.then(
      () => {
        if (this.respawnPromise === promise) {
          this.respawnPromise = null;
        }
      },
      () => {
        if (this.respawnPromise === promise) {
          this.respawnPromise = null;
        }
      },
    );
    return promise;
  }

  private handleWasmTrapFailure(
    triggeringId: number | null,
    message: string,
    cypher: string | null,
    telemetry: QueryTelemetry | null,
  ): void {
    this.terminateWorkerForRecovery();

    const trapError = new WasmTrapError(message, cypher, telemetry);

    if (triggeringId !== null) {
      const triggering = this.pending.get(triggeringId);
      if (triggering !== undefined) {
        this.clearPendingEntry(triggering);
        triggering.reject(trapError);
      }
    }

    this.rejectAllPending(
      (entry) =>
        new WasmTrapError(
          `Worker terminated after WASM trap while "${entry.requestType}" was in flight: ${message}`,
          entry.cypher ?? cypher,
          telemetry,
        ),
    );

    if (!this.disposed && this.autoRespawn) {
      this.triggerAutoRespawn();
    }
  }

  private handleWorkerMessage(msg: WorkerResponse): void {
    if (this.disposed) {
      return;
    }

    const entry = this.pending.get(msg.id);
    if (entry === undefined) {
      // Response belongs to a superseded, cancelled, or timed-out request.
      this.discardedStaleCount++;
      if (msg.type === 'error' && (msg.wasmTrap || isWasmTrap(new Error(msg.message)))) {
        this.handleWasmTrapFailure(null, msg.message, msg.cypher ?? null, msg.telemetry);
      }
      return;
    }

    if (msg.type === 'result') {
      this.clearPendingEntry(entry);
      entry.resolve(msg.data);
      return;
    }

    const detectedTrap = msg.wasmTrap || isWasmTrap(new Error(msg.message));
    if (detectedTrap) {
      this.handleWasmTrapFailure(
        msg.id,
        msg.message,
        msg.cypher ?? entry.cypher,
        msg.telemetry,
      );
      return;
    }

    this.clearPendingEntry(entry);
    entry.reject(
      new WorkerRemoteError(msg.message, msg.cypher ?? entry.cypher, msg.telemetry),
    );
  }

  private handleWorkerErrorEvent(event: WorkerErrorEventLike): void {
    if (this.disposed) {
      return;
    }
    const rawErr = event.error ?? new Error(event.message ?? 'Unhandled Worker error');
    const message =
      event.message ?? (rawErr instanceof Error ? rawErr.message : String(rawErr));
    if (isWasmTrap(rawErr) || isWasmTrap(new Error(message))) {
      this.handleWasmTrapFailure(null, message, null, null);
      return;
    }
    this.terminateWorkerForRecovery();
    this.rejectAllPending(
      (entry) => new WorkerRemoteError(`Worker crashed: ${message}`, entry.cypher, null),
    );
  }

  private sendRawRequest<T>(
    buildMessage: (id: number) => WorkerRequest,
    opts: {
      readonly channel: string | null;
      readonly cypher: string | null;
      readonly timeoutMs: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new WorkerDisposedError());
    }
    if (opts.signal?.aborted) {
      return Promise.reject(new Error('Request aborted before dispatch'));
    }

    const id = this.nextRequestId++;
    const message = buildMessage(id);

    if (opts.channel !== null) {
      const prevId = this.latestByChannel.get(opts.channel);
      if (prevId !== undefined) {
        const prevEntry = this.pending.get(prevId);
        if (prevEntry !== undefined) {
          this.clearPendingEntry(prevEntry);
          prevEntry.reject(new StaleRequestError(opts.channel, prevId, id));
        }
      }
      this.latestByChannel.set(opts.channel, id);
    }

    const worker = this.spawnWorker();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const timedOutEntry = this.pending.get(id);
        if (timedOutEntry === undefined) {
          return;
        }
        this.terminateWorkerForRecovery();
        this.clearPendingEntry(timedOutEntry);
        timedOutEntry.reject(
          new WorkerTimeoutError(
            timedOutEntry.requestType,
            opts.timeoutMs,
            timedOutEntry.cypher,
          ),
        );
        this.rejectAllPending(
          (other) =>
            new WorkerTimeoutError(other.requestType, opts.timeoutMs, other.cypher),
        );
        if (!this.disposed && this.autoRespawn && this.lastBootSource !== null) {
          this.triggerAutoRespawn();
        }
      }, opts.timeoutMs);

      let abortCleanup: (() => void) | null = null;
      if (opts.signal !== undefined) {
        const onAbort = () => {
          const active = this.pending.get(id);
          if (active !== undefined) {
            this.clearPendingEntry(active);
            active.reject(new Error(`Request #${id} aborted`));
          }
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        abortCleanup = () => {
          opts.signal?.removeEventListener('abort', onAbort);
        };
      }

      const entry: PendingRequest = {
        id,
        requestType: message.type,
        channel: opts.channel,
        cypher: opts.cypher,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        abortCleanup,
      };
      this.pending.set(id, entry);

      try {
        worker.postMessage(message);
      } catch (err) {
        this.clearPendingEntry(entry);
        reject(err);
      }
    });
  }

  private async ensureWorkerReadyBeforeCall(): Promise<void> {
    if (this.disposed) {
      throw new WorkerDisposedError();
    }
    if (this.respawnPromise !== null) {
      await this.respawnPromise;
      if (this.disposed) {
        throw new WorkerDisposedError();
      }
      return;
    }
    if (this.worker === null && this.lastBootSource !== null && this.autoRespawn) {
      await this.triggerAutoRespawn();
      if (this.disposed) {
        throw new WorkerDisposedError();
      }
    }
  }

  private dispatchWhenReady<T>(
    buildMessage: (id: number) => WorkerRequest,
    opts: {
      readonly channel: string | null;
      readonly cypher: string | null;
      readonly timeoutMs: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new WorkerDisposedError());
    }

    const dispatchToken = this.nextDispatchToken++;
    if (opts.channel !== null) {
      this.latestDispatchTokenByChannel.set(opts.channel, dispatchToken);
    }

    const needsAsyncReady =
      this.respawnPromise !== null ||
      (this.worker === null && this.lastBootSource !== null && this.autoRespawn);

    if (!needsAsyncReady) {
      return this.sendRawRequest<T>(buildMessage, opts);
    }

    return this.ensureWorkerReadyBeforeCall().then(() => {
      if (this.disposed) {
        throw new WorkerDisposedError();
      }
      if (
        opts.channel !== null &&
        this.latestDispatchTokenByChannel.get(opts.channel) !== dispatchToken
      ) {
        throw new StaleRequestError(
          opts.channel,
          dispatchToken,
          this.latestDispatchTokenByChannel.get(opts.channel) ?? dispatchToken,
        );
      }
      return this.sendRawRequest<T>(buildMessage, opts);
    });
  }

  boot(source: BootSource, options: CallOptions = {}): Promise<BootTelemetry> {
    if (this.disposed) {
      return Promise.reject(new WorkerDisposedError());
    }
    const bootTimeoutMs = options.timeoutMs ?? this.timeoutMs;
    this.lastBootSource = source;
    this.lastBootTimeoutMs = bootTimeoutMs;
    return this.sendRawRequest<BootTelemetry>(
      (id) => ({
        type: 'boot',
        id,
        payload: source.payload,
        payloadUrl: source.payloadUrl,
        chunkSize: source.chunkSize,
      }),
      {
        channel: null,
        cypher: null,
        timeoutMs: bootTimeoutMs,
        signal: options.signal,
      },
    );
  }

  queryRoute(
    fromCode: string,
    toCode: string,
    blockedPassageIds: readonly string[],
    options: CallOptions & { readonly profile?: boolean } = {},
  ): Promise<RouteEvaluationResult> {
    return this.dispatchWhenReady<RouteEvaluationResult>(
      (id) => ({
        type: 'queryRoute',
        id,
        fromCode,
        toCode,
        blockedPassageIds,
        profile: options.profile,
      }),
      {
        channel: 'route',
        cypher: null,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        signal: options.signal,
      },
    );
  }

  evaluateScenario(
    request: ScenarioEvaluationRequest,
    options: CallOptions = {},
  ): Promise<ScenarioEvaluationResult> {
    return this.dispatchWhenReady<ScenarioEvaluationResult>(
      (id) => ({
        type: 'evaluateScenario',
        id,
        request,
      }),
      {
        channel: 'scenario',
        cypher: null,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        signal: options.signal,
      },
    );
  }

  applyCustomBoxes(
    boxes: readonly CustomBBoxInput[],
    options: CallOptions & { readonly limit?: number } = {},
  ): Promise<CustomBBoxApplyResult> {
    return this.dispatchWhenReady<CustomBBoxApplyResult>(
      (id) => ({
        type: 'applyCustomBoxes',
        id,
        boxes,
        limit: options.limit,
      }),
      {
        channel: 'customBoxes',
        cypher: null,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        signal: options.signal,
      },
    );
  }

  runCustomCypher(
    cypher: string,
    params: Readonly<Record<string, unknown>> | null = null,
    options: CallOptions & { readonly profile?: boolean } = {},
  ): Promise<CypherExecutionResult> {
    return this.dispatchWhenReady<CypherExecutionResult>(
      (id) => ({
        type: 'runCustomCypher',
        id,
        cypher,
        params,
        profile: options.profile,
      }),
      {
        channel: null,
        cypher,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        signal: options.signal,
      },
    );
  }

  getMetadata(options: CallOptions = {}): Promise<EngineMetadata> {
    return this.dispatchWhenReady<EngineMetadata>(
      (id) => ({ type: 'getMetadata', id }),
      {
        channel: null,
        cypher: null,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        signal: options.signal,
      },
    );
  }

  getPorts(options: CallOptions = {}): Promise<readonly PortRecord[]> {
    return this.dispatchWhenReady<readonly PortRecord[]>(
      (id) => ({ type: 'getPorts', id }),
      {
        channel: null,
        cypher: null,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        signal: options.signal,
      },
    );
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.respawnPromise = null;
    this.rejectAllPending(() => new WorkerDisposedError());
    this.latestByChannel.clear();
    this.latestDispatchTokenByChannel.clear();
    this.terminateCurrentWorker();
  }
}
