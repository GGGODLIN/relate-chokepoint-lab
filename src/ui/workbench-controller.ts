import type { ChokepointCatalog } from '../contracts/catalog.ts';
import { getDefaultBlockedPassageIds } from '../contracts/catalog.ts';
import type { DragBBoxResult } from '../engine/bbox.ts';
import type {
  BootTelemetry,
  CustomBBoxApplyResult,
  CustomBBoxInput,
  CypherExecutionResult,
  IsolatedPortRecord,
  PortRecord,
  RouteEvaluationResult,
  ScenarioEvaluationRequest,
  ScenarioEvaluationResult,
  TradeExposureRecord,
} from '../engine/chokepoint-engine.ts';
import { DEFAULT_BBOX_EDGE_LIMIT, QueryBuilder } from '../engine/query-builder.ts';
import { StaleRequestError, type BootSource } from '../engine/worker-client.ts';
import {
  addBox,
  boxesKey,
  countGraphWrites,
  defaultScenario,
  hasDetourImpact,
  normalizeBlocked,
  odKey,
  parseParamsText,
  presetScenario,
  removeBox,
  resetBlockades,
  scenarioKey,
  summarizeRoute,
  togglePassage,
  unblockPassage,
  withHero,
  type BoxMatch,
  type DrawnBox,
  type Evaluation,
  type GoldenRouteResult,
  type IsolationSummary,
  type OdPair,
  type QueryRecord,
  type RouteSummary,
  type Scenario,
} from './model.ts';

/** The slice of ChokepointWorkerClient the workbench relies on (lets tests drive a fake engine). */
export interface WorkbenchClient {
  boot(source: BootSource, options?: { readonly timeoutMs?: number }): Promise<BootTelemetry>;
  getPorts(): Promise<readonly PortRecord[]>;
  queryRoute(
    fromCode: string,
    toCode: string,
    blockedPassageIds: readonly string[],
  ): Promise<RouteEvaluationResult>;
  evaluateScenario(request: ScenarioEvaluationRequest): Promise<ScenarioEvaluationResult>;
  applyCustomBoxes(boxes: readonly CustomBBoxInput[]): Promise<CustomBBoxApplyResult>;
  runCustomCypher(
    cypher: string,
    params: Readonly<Record<string, unknown>> | null,
    options?: { readonly profile?: boolean },
  ): Promise<CypherExecutionResult>;
  getStats(): { readonly respawnCount: number };
}

export type PayloadLoader = (
  onProgress: (loadedBytes: number, totalBytes: number | null) => void,
) => Promise<BootSource>;

export type BootPhase = 'downloading' | 'seeding' | 'baselines' | 'ready' | 'failed';

export interface BootStatus {
  readonly phase: BootPhase;
  readonly loadedBytes: number;
  readonly totalBytes: number | null;
  readonly telemetry: BootTelemetry | null;
  readonly error: string | null;
}

export type ToastTone = 'info' | 'warn' | 'error';

export interface Toast {
  readonly id: number;
  readonly tone: ToastTone;
  readonly message: string;
}

export interface InspectorState {
  readonly status: 'idle' | 'running' | 'done' | 'failed';
  readonly profile: boolean;
  readonly result: CypherExecutionResult | null;
  readonly transportError: string | null;
  readonly wroteGraph: boolean;
}

export interface TradePartner {
  readonly countryCode: string;
  readonly countryName: string;
}

export interface PortFocus {
  readonly code: string;
  readonly status: 'loading' | 'ready' | 'failed';
  readonly partners: readonly TradePartner[];
  readonly error: string | null;
}

export interface WorkbenchState {
  readonly boot: BootStatus;
  readonly ports: readonly PortRecord[];
  readonly scenario: Scenario;
  readonly evaluation: Evaluation | null;
  readonly busy: boolean;
  readonly evaluationError: string | null;
  readonly pendingBox: DrawnBox | null;
  readonly graphMutated: boolean;
  readonly restoring: boolean;
  readonly inspector: InspectorState;
  readonly portFocus: PortFocus | null;
  readonly portQuery: QueryRecord | null;
  readonly toasts: readonly Toast[];
}

export const BOOT_TIMEOUT_MS = 120_000;
const MAX_EVALUATION_RETRIES = 3;
const MAX_VISIBLE_TOASTS = 4;
const EMPTY_BOXES_KEY = boxesKey([]);

export const PORT_PARTNERS_CYPHER = [
  'MATCH (p:Port {code: $code})-[:TRADES_WITH]->(c:Country)',
  'RETURN c.code AS countryCode, c.name AS countryName',
  'ORDER BY countryName ASC',
].join('\n');

/** The user changed the scenario mid-pipeline; the partial result must never reach the screen. */
class SupersededError extends Error {
  constructor() {
    super('Evaluation superseded by a newer scenario');
    this.name = 'SupersededError';
  }
}

/** The worker respawned mid-pipeline, so earlier answers came from a different graph instance. */
class GraphChangedError extends Error {
  constructor() {
    super('Worker restarted during evaluation; recomputing on the re-seeded graph');
    this.name = 'GraphChangedError';
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toBoxInputs(boxes: readonly DrawnBox[]): CustomBBoxInput[] {
  return boxes.map((box) => ({ id: box.id, rects: box.rects }));
}

function toBoxMatches(result: CustomBBoxApplyResult): BoxMatch[] {
  return result.boxMatches
    .filter((match) => match.matchedEdgeCount > 0)
    .map((match) => ({
      boxId: match.boxId,
      matchedEdgeIds: match.matchedEdgeIds,
      truncated: match.truncated,
    }));
}

function readIsolatedRows(rows: readonly Record<string, unknown>[]): IsolatedPortRecord[] {
  const ports: IsolatedPortRecord[] = [];
  for (const row of rows) {
    const { code, name, country, lon, lat, rank, tradeDegree } = row;
    if (
      typeof code === 'string' &&
      typeof name === 'string' &&
      typeof country === 'string' &&
      typeof lon === 'number' &&
      typeof lat === 'number' &&
      typeof rank === 'number' &&
      typeof tradeDegree === 'number'
    ) {
      ports.push({ code, name, country, lon, lat, rank, tradeDegree });
    }
  }
  return ports;
}

function readExposureRows(rows: readonly Record<string, unknown>[]): TradeExposureRecord[] {
  const countries: TradeExposureRecord[] = [];
  for (const row of rows) {
    const { countryCode, countryName, exposedPorts } = row;
    if (
      typeof countryCode === 'string' &&
      typeof countryName === 'string' &&
      typeof exposedPorts === 'number'
    ) {
      countries.push({ countryCode, countryName, exposedPorts });
    }
  }
  return countries;
}

function readPartnerRows(rows: readonly Record<string, unknown>[]): TradePartner[] {
  const partners: TradePartner[] = [];
  for (const row of rows) {
    const { countryCode, countryName } = row;
    if (typeof countryCode === 'string' && typeof countryName === 'string') {
      partners.push({ countryCode, countryName });
    }
  }
  return partners;
}

function routeQueryRecord(id: string, label: string, route: RouteEvaluationResult): QueryRecord {
  return {
    id,
    label,
    cypher: route.cypher,
    params: route.params,
    telemetry: route.telemetry,
    rowCount: 1,
  };
}

function isStale(err: unknown): boolean {
  return err instanceof StaleRequestError;
}

export function createInitialState(catalog: ChokepointCatalog): WorkbenchState {
  return {
    boot: { phase: 'downloading', loadedBytes: 0, totalBytes: null, telemetry: null, error: null },
    ports: [],
    scenario: defaultScenario(catalog),
    evaluation: null,
    busy: false,
    evaluationError: null,
    pendingBox: null,
    graphMutated: false,
    restoring: false,
    inspector: { status: 'idle', profile: false, result: null, transportError: null, wroteGraph: false },
    portFocus: null,
    portQuery: null,
    toasts: [],
  };
}

/**
 * Owns every conversation with the Relate worker. All engine calls run one at a time
 * through `exclusive`, because the worker client cancels same-channel requests and the
 * custom-box graph is shared mutable state: interleaving would mix answers from
 * different graph versions on one screen.
 */
export class WorkbenchController {
  private readonly client: WorkbenchClient;
  private readonly catalog: ChokepointCatalog;
  private readonly defaultBlocked: string[];
  private readonly listeners = new Set<() => void>();
  private readonly baselines = new Map<string, RouteSummary>();
  private state: WorkbenchState;
  private chain: Promise<void> = Promise.resolve();
  private bootSource: BootSource | null = null;
  private engineBoxesKey = EMPTY_BOXES_KEY;
  private engineBoxMatches: BoxMatch[] = [];
  private engineMutated = false;
  private knownRespawns = 0;
  private graphEpoch = 0;
  private boxResetEpoch = 0;
  private loopQueued = false;
  private nextToastId = 1;
  private nextBoxNumber = 1;

  constructor(client: WorkbenchClient, catalog: ChokepointCatalog) {
    this.client = client;
    this.catalog = catalog;
    this.defaultBlocked = normalizeBlocked(getDefaultBlockedPassageIds(catalog));
    this.state = createInitialState(catalog);
  }

  readonly getSnapshot = (): WorkbenchState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Resolves once every queued engine call (and any evaluation they triggered) has finished. */
  async whenIdle(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.chain;
      await observed;
    } while (observed !== this.chain);
  }

  private setState(patch: Partial<WorkbenchState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private isReady(): boolean {
    return this.state.boot.phase === 'ready';
  }

  pushToast(tone: ToastTone, message: string): void {
    const toast: Toast = { id: this.nextToastId++, tone, message };
    this.setState({ toasts: [...this.state.toasts, toast].slice(-MAX_VISIBLE_TOASTS) });
  }

  dismissToast(id: number): void {
    this.setState({ toasts: this.state.toasts.filter((toast) => toast.id !== id) });
  }

  async start(loadPayload: PayloadLoader): Promise<void> {
    try {
      const source = await loadPayload((loadedBytes, totalBytes) => {
        this.setState({ boot: { ...this.state.boot, loadedBytes, totalBytes } });
      });
      this.bootSource = source;
      this.setState({ boot: { ...this.state.boot, phase: 'seeding' } });
      await this.exclusive(async () => {
        const telemetry = await this.client.boot(source, { timeoutMs: BOOT_TIMEOUT_MS });
        this.noteFreshGraph();
        const ports = await this.client.getPorts();
        this.setState({ ports, boot: { ...this.state.boot, phase: 'baselines', telemetry } });
        // Sequential on purpose: queryRoute shares one worker channel, so parallel calls cancel each other.
        for (const route of this.catalog.goldenRoutes) {
          // react-doctor-disable-next-line async-await-in-loop
          await this.ensureBaseline({ from: route.from, to: route.to });
        }
      });
      this.setState({ boot: { ...this.state.boot, phase: 'ready' } });
      this.requestEvaluation();
    } catch (err: unknown) {
      this.setState({ boot: { ...this.state.boot, phase: 'failed', error: describeError(err) } });
    }
  }

  selectPreset(presetId: string): void {
    this.boxResetEpoch++;
    this.updateScenario(presetScenario(this.catalog, presetId));
  }

  togglePassage(passageId: string): void {
    this.updateScenario(togglePassage(this.state.scenario, passageId));
  }

  unblockPassage(passageId: string): void {
    this.updateScenario(unblockPassage(this.state.scenario, passageId));
  }

  removeBox(boxId: string): void {
    this.updateScenario(removeBox(this.state.scenario, boxId));
  }

  setHero(hero: OdPair): void {
    this.updateScenario(withHero(this.state.scenario, hero));
  }

  resetAll(): void {
    this.boxResetEpoch++;
    const next = resetBlockades(this.catalog, this.state.scenario);
    if (this.engineMutated || this.state.graphMutated) {
      this.setState({ scenario: next, busy: true });
      void this.restoreGraph();
      return;
    }
    this.updateScenario(next);
  }

  retryEvaluation(): void {
    this.setState({ evaluationError: null });
    this.graphEpoch++;
    this.requestEvaluation();
  }

  private updateScenario(next: Scenario): void {
    this.setState({ scenario: next });
    this.requestEvaluation();
  }

  private requestEvaluation(): void {
    if (!this.isReady()) {
      return;
    }
    if (!this.state.busy) {
      this.setState({ busy: true });
    }
    if (this.loopQueued) {
      return;
    }
    this.loopQueued = true;
    void this.exclusive(() => this.evaluationLoop());
  }

  /**
   * Current means: computed for the latest scenario, on the present graph version, and the
   * engine holds exactly the user's boxes. The last clause matters when a box proposal is
   * abandoned mid-flight (e.g. by Reset All) with its trial box still applied in the worker.
   */
  private isEvaluationCurrent(): boolean {
    const evaluation = this.state.evaluation;
    return (
      evaluation !== null &&
      evaluation.key === scenarioKey(this.state.scenario) &&
      evaluation.epoch === this.graphEpoch &&
      this.engineBoxesKey === boxesKey(this.state.scenario.boxes)
    );
  }

  private stalePortFocusPatch(
    evaluation: Evaluation,
  ): Partial<Pick<WorkbenchState, 'portFocus' | 'portQuery'>> {
    const focus = this.state.portFocus;
    if (focus === null) {
      return {};
    }
    const stillIsolated = evaluation.isolation.ports.some((port) => port.code === focus.code);
    return stillIsolated ? {} : { portFocus: null, portQuery: null };
  }

  /** Coalesces bursts of clicks: always evaluates the newest scenario, discards superseded work. */
  private async evaluationLoop(): Promise<void> {
    this.loopQueued = false;
    let failures = 0;
    while (!this.isEvaluationCurrent()) {
      const target = this.state.scenario;
      const key = scenarioKey(target);
      try {
        // Each pass must finish before the loop re-reads the newest scenario; that is the coalescing.
        // react-doctor-disable-next-line async-await-in-loop
        const evaluation = await this.computeEvaluation(target, () => scenarioKey(this.state.scenario) === key);
        if (scenarioKey(this.state.scenario) === key) {
          this.setState({ evaluation, evaluationError: null, ...this.stalePortFocusPatch(evaluation) });
        }
      } catch (err: unknown) {
        if (err instanceof SupersededError || isStale(err)) {
          continue;
        }
        failures++;
        const respawned = this.syncRespawn();
        if ((err instanceof GraphChangedError || respawned) && failures < MAX_EVALUATION_RETRIES) {
          continue;
        }
        const message = describeError(err);
        this.setState({ evaluationError: message });
        this.pushToast('error', `Evaluation failed: ${message}`);
        break;
      }
    }
    this.setState({ busy: false });
  }

  /** Detects a worker respawn (timeout or WASM trap): the client re-boots a pristine graph. */
  private syncRespawn(): boolean {
    const respawns = this.client.getStats().respawnCount;
    if (respawns === this.knownRespawns) {
      return false;
    }
    this.knownRespawns = respawns;
    this.engineBoxesKey = EMPTY_BOXES_KEY;
    this.engineBoxMatches = [];
    this.engineMutated = false;
    this.graphEpoch++;
    if (this.state.graphMutated) {
      this.setState({ graphMutated: false });
    }
    return true;
  }

  private noteFreshGraph(): void {
    this.knownRespawns = this.client.getStats().respawnCount;
    this.engineBoxesKey = EMPTY_BOXES_KEY;
    this.engineBoxMatches = [];
    this.engineMutated = false;
    this.graphEpoch++;
  }

  private noteApplied(result: CustomBBoxApplyResult, key: string): void {
    this.engineBoxesKey = key;
    this.engineBoxMatches = toBoxMatches(result);
    if (result.reseeded && this.engineMutated) {
      // The reseed silently discarded Live Cypher writes, so anything measured before it is stale.
      this.engineMutated = false;
      this.graphEpoch++;
      if (this.state.graphMutated) {
        this.setState({ graphMutated: false });
      }
    }
  }

  /** Baselines are only trustworthy on the canonical graph: default blockade, no boxes, no Cypher writes. */
  private async ensureBaseline(od: OdPair): Promise<RouteSummary | null> {
    const key = odKey(od);
    const cached = this.baselines.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (this.engineMutated) {
      return null;
    }
    if (this.engineBoxesKey !== EMPTY_BOXES_KEY) {
      const result = await this.client.applyCustomBoxes([]);
      this.noteApplied(result, EMPTY_BOXES_KEY);
    }
    const route = await this.client.queryRoute(od.from, od.to, this.defaultBlocked);
    const summary = summarizeRoute(route);
    this.baselines.set(key, summary);
    return summary;
  }

  private async reconcileBoxes(boxes: readonly DrawnBox[]): Promise<void> {
    const key = boxesKey(boxes);
    if (this.engineBoxesKey === key) {
      return;
    }
    const result = await this.client.applyCustomBoxes(toBoxInputs(boxes));
    this.noteApplied(result, key);
  }

  private async isolationWithFallback(
    target: Scenario,
    result: ScenarioEvaluationResult,
  ): Promise<{ isolation: IsolationSummary; trade: TradeExposureRecord[]; queries: QueryRecord[] }> {
    const primary = result.isolation;
    if (primary === null) {
      throw new Error('Engine returned no isolation result');
    }
    const queries: QueryRecord[] = [
      {
        id: 'isolation',
        label: `Isolation · 1-to-ALL BFS from ${primary.referenceHubCode}`,
        cypher: primary.cypher,
        params: primary.params,
        telemetry: primary.telemetry,
        rowCount: primary.isolatedCount,
      },
    ];
    if (result.tradeExposure !== null) {
      queries.push({
        id: 'trade',
        label: 'Trade exposure · countries of isolated ports',
        cypher: result.tradeExposure.cypher,
        params: result.tradeExposure.params,
        telemetry: result.tradeExposure.telemetry,
        rowCount: result.tradeExposure.countries.length,
      });
    }
    const primarySummary: IsolationSummary = {
      referenceHubCode: primary.referenceHubCode,
      fallbackUsed: false,
      totalPorts: primary.totalPorts,
      isolatedCount: primary.isolatedCount,
      ports: primary.isolatedPorts,
    };
    const primaryTrade = [...(result.tradeExposure?.countries ?? [])];
    // A box around the reference hub would flip the answer to "almost every port is isolated";
    // measuring from the catalog's fallback hub recovers the real minority component.
    if (primary.isolatedCount * 2 <= primary.totalPorts) {
      return { isolation: primarySummary, trade: primaryTrade, queries };
    }
    const fallbackHub = this.catalog.fallbackReferenceHubCode;
    const isoCypher = QueryBuilder.buildIsolationQuery(this.catalog, target.blocked);
    const isoParams = { refHub: fallbackHub };
    const iso = await this.client.runCustomCypher(isoCypher, isoParams);
    const fallbackPorts = iso.ok ? readIsolatedRows(iso.rows) : [];
    if (!iso.ok || fallbackPorts.length >= primary.isolatedCount) {
      return { isolation: primarySummary, trade: primaryTrade, queries };
    }
    const tradeCypher = QueryBuilder.buildTradeExposureForPortsQuery();
    const tradeParams = { isolatedCodes: fallbackPorts.map((port) => port.code) };
    const trade =
      fallbackPorts.length === 0 ? null : await this.client.runCustomCypher(tradeCypher, tradeParams);
    const fallbackQueries: QueryRecord[] = [
      {
        id: 'isolation',
        label: `Isolation · 1-to-ALL BFS from ${fallbackHub} (fallback hub)`,
        cypher: isoCypher,
        params: isoParams,
        telemetry: iso.telemetry,
        rowCount: fallbackPorts.length,
      },
    ];
    if (trade !== null) {
      fallbackQueries.push({
        id: 'trade',
        label: 'Trade exposure · countries of isolated ports',
        cypher: tradeCypher,
        params: tradeParams,
        telemetry: trade.telemetry,
        rowCount: trade.rows.length,
      });
    }
    return {
      isolation: {
        referenceHubCode: fallbackHub,
        fallbackUsed: true,
        totalPorts: primary.totalPorts,
        isolatedCount: fallbackPorts.length,
        ports: fallbackPorts,
      },
      trade: trade !== null && trade.ok ? readExposureRows(trade.rows) : [],
      queries: fallbackQueries,
    };
  }

  private async computeEvaluation(target: Scenario, isCurrent: () => boolean): Promise<Evaluation> {
    const startedAt = performance.now();
    this.syncRespawn();
    const checkpoint = () => {
      if (!isCurrent()) {
        throw new SupersededError();
      }
    };

    const heroBaseline = await this.ensureBaseline(target.hero);
    checkpoint();
    await this.reconcileBoxes(target.boxes);
    checkpoint();
    // Reconciling may reseed the graph; the measurements below belong to the version from here on.
    const epoch = this.graphEpoch;

    const result = await this.client.evaluateScenario({
      blockedPassageIds: target.blocked,
      routeFrom: target.hero.from,
      routeTo: target.hero.to,
    });
    checkpoint();
    if (result.route === null) {
      throw new Error('Engine returned no hero route');
    }
    const hero = summarizeRoute(result.route);
    const { isolation, trade, queries } = await this.isolationWithFallback(target, result);
    checkpoint();

    const heroKey = odKey(target.hero);
    const golden: GoldenRouteResult[] = [];
    const goldenQueries: QueryRecord[] = [];
    // Sequential on purpose: queryRoute shares one worker channel, so parallel calls cancel each other.
    for (const route of this.catalog.goldenRoutes) {
      const od = { from: route.from, to: route.to };
      const baseline = this.baselines.get(odKey(od)) ?? null;
      if (odKey(od) === heroKey) {
        golden.push({ route, current: hero, baseline: heroBaseline });
        continue;
      }
      // react-doctor-disable-next-line async-await-in-loop
      const current = await this.client.queryRoute(route.from, route.to, target.blocked);
      checkpoint();
      golden.push({ route, current: summarizeRoute(current), baseline });
      goldenQueries.push(routeQueryRecord(`golden-${route.id}`, `Golden route · ${route.label}`, current));
    }

    if (this.syncRespawn() || this.graphEpoch !== epoch) {
      throw new GraphChangedError();
    }

    const boxQueries: QueryRecord[] = [];
    const lastBox = target.boxes[target.boxes.length - 1];
    if (lastBox !== undefined) {
      boxQueries.push({
        id: 'box-match',
        label: `Custom box · lanes inside ${lastBox.id}`,
        cypher: QueryBuilder.buildBBoxEdgesQuery(),
        params: { boxes: lastBox.rects, limit: DEFAULT_BBOX_EDGE_LIMIT },
        telemetry: null,
        rowCount: this.engineBoxMatches.find((m) => m.boxId === lastBox.id)?.matchedEdgeIds.length ?? null,
      });
    }

    return {
      key: scenarioKey(target),
      epoch,
      scenario: target,
      hero,
      heroBaseline,
      golden,
      isolation,
      tradeExposure: trade,
      boxMatches: this.engineBoxMatches,
      queries: [
        routeQueryRecord('hero-route', `Hero route · ${target.hero.from} → ${target.hero.to}`, result.route),
        ...queries,
        ...boxQueries,
        ...goldenQueries,
      ],
      elapsedMs: performance.now() - startedAt,
    };
  }

  /**
   * Draw Box: a box only reaches the map once it has proven impact. A box with zero
   * lanes, or lanes whose loss forces no detour, is reported in a toast and rolled back.
   */
  proposeBox(drag: DragBBoxResult): Promise<void> {
    if (!this.isReady() || drag.rects.length === 0) {
      return Promise.resolve();
    }
    if (this.engineMutated || this.state.graphMutated) {
      this.pushToast('warn', 'Restore the canonical graph before drawing boxes: Live Cypher changed it.');
      return Promise.resolve();
    }
    const box: DrawnBox = {
      id: `box-${this.nextBoxNumber++}`,
      rects: drag.rects,
      lonSpanDeg: drag.lonSpanDeg,
      crossesAntimeridian: drag.crossesAntimeridian,
    };
    if (drag.exceedsMaxSpanWarning) {
      this.pushToast('warn', drag.warning ?? `Box spans ${drag.lonSpanDeg.toFixed(0)}° of longitude.`);
    }
    const boxEpochAtStart = this.boxResetEpoch;
    this.setState({ pendingBox: box });
    return this.exclusive(async () => {
      try {
        await this.evaluationLoop();
        if (this.boxResetEpoch !== boxEpochAtStart) {
          this.requestEvaluation();
          return;
        }
        if (this.engineMutated) {
          // A Live Cypher write queued ahead of this box landed first; impact must be judged on the canonical graph.
          this.pushToast('warn', 'Restore the canonical graph before drawing boxes: Live Cypher changed it.');
          return;
        }
        const base = this.state.scenario;
        const before = this.state.evaluation;
        if (before === null || !this.isEvaluationCurrent()) {
          this.pushToast('error', 'Box not applied: the current scenario could not be evaluated.');
          return;
        }
        const candidate = addBox(base, box);
        this.syncRespawn();
        const applied = await this.client.applyCustomBoxes(toBoxInputs(candidate.boxes));
        this.noteApplied(applied, boxesKey(candidate.boxes));
        const match = applied.boxMatches.find((m) => m.boxId === box.id);
        if (match === undefined || match.matchedEdgeCount === 0) {
          // Zero-match boxes are skipped by the engine, so its graph already equals the base scenario.
          this.engineBoxesKey = boxesKey(base.boxes);
          if (this.boxResetEpoch !== boxEpochAtStart) {
            this.requestEvaluation();
            return;
          }
          this.pushToast('info', 'No sea-lane segments inside that box, so nothing was blocked. Map unchanged.');
          return;
        }
        if (this.boxResetEpoch !== boxEpochAtStart) {
          this.requestEvaluation();
          return;
        }
        const after = await this.computeEvaluation(candidate, () => true);
        if (this.boxResetEpoch !== boxEpochAtStart) {
          this.requestEvaluation();
          return;
        }
        if (!hasDetourImpact(before, after)) {
          const reverted = await this.client.applyCustomBoxes(toBoxInputs(base.boxes));
          this.noteApplied(reverted, boxesKey(base.boxes));
          this.pushToast(
            'info',
            `Box cuts ${match.matchedEdgeCount} lane segments but forces 0 detours on the hero or golden routes and isolates no extra ports. Not applied.`,
          );
          return;
        }
        if (match.truncated) {
          this.pushToast('warn', `Box hit the ${DEFAULT_BBOX_EDGE_LIMIT}-segment cap; only the first ${DEFAULT_BBOX_EDGE_LIMIT} lanes were severed.`);
        }
        if (this.boxResetEpoch !== boxEpochAtStart) {
          this.requestEvaluation();
          return;
        }
        const latest = this.state.scenario;
        if (scenarioKey(latest) === scenarioKey(base)) {
          this.setState({ scenario: candidate, evaluation: after, ...this.stalePortFocusPatch(after) });
        } else {
          this.setState({ scenario: addBox(latest, box) });
          this.requestEvaluation();
        }
      } catch (err: unknown) {
        if (!(err instanceof SupersededError || isStale(err))) {
          this.pushToast('error', `Box check failed: ${describeError(err)}`);
        }
        this.syncRespawn();
        this.graphEpoch++;
        this.requestEvaluation();
      } finally {
        this.setState({ pendingBox: null });
      }
    });
  }

  runInspector(cypher: string, paramsText: string, profile: boolean): Promise<void> {
    const parsed = parseParamsText(paramsText);
    if (!parsed.ok) {
      this.setState({
        inspector: { status: 'failed', profile, result: null, transportError: parsed.error, wroteGraph: false },
      });
      return Promise.resolve();
    }
    this.setState({ inspector: { ...this.state.inspector, status: 'running', profile } });
    return this.exclusive(async () => {
      this.syncRespawn();
      try {
        const result = await this.client.runCustomCypher(cypher, parsed.params, { profile });
        const writes = result.ok ? countGraphWrites(result.telemetry.stats) : 0;
        if (writes > 0) {
          this.engineMutated = true;
          this.graphEpoch++;
        }
        this.setState({
          inspector: { status: result.ok ? 'done' : 'failed', profile, result, transportError: null, wroteGraph: writes > 0 },
          graphMutated: this.engineMutated,
        });
        if (writes > 0) {
          this.requestEvaluation();
        }
      } catch (err: unknown) {
        if (isStale(err)) {
          this.setState({ inspector: { ...this.state.inspector, status: 'idle' } });
          return;
        }
        this.setState({
          inspector: { status: 'failed', profile, result: null, transportError: describeError(err), wroteGraph: false },
        });
        if (this.syncRespawn()) {
          this.requestEvaluation();
        }
      }
    });
  }

  restoreGraph(): Promise<void> {
    const source = this.bootSource;
    if (source === null) {
      return Promise.resolve();
    }
    this.setState({ restoring: true });
    return this.exclusive(async () => {
      try {
        await this.client.boot(source, { timeoutMs: BOOT_TIMEOUT_MS });
        this.noteFreshGraph();
        this.setState({ graphMutated: false, restoring: false });
        this.pushToast('info', 'Canonical graph re-seeded into this tab’s :memory: database.');
      } catch (err: unknown) {
        this.syncRespawn();
        this.setState({ restoring: false });
        this.pushToast('error', `Restore failed: ${describeError(err)}`);
      }
      this.requestEvaluation();
    });
  }

  focusPort(code: string): Promise<void> {
    this.setState({ portFocus: { code, status: 'loading', partners: [], error: null } });
    return this.exclusive(async () => {
      if (this.state.portFocus?.code !== code) {
        return;
      }
      const params = { code };
      try {
        const result = await this.client.runCustomCypher(PORT_PARTNERS_CYPHER, params);
        if (this.state.portFocus?.code !== code) {
          return;
        }
        const portQuery: QueryRecord = {
          id: 'port-partners',
          label: `Trade partners · ${code}`,
          cypher: PORT_PARTNERS_CYPHER,
          params,
          telemetry: result.telemetry,
          rowCount: result.rows.length,
        };
        this.setState({
          portQuery,
          portFocus: result.ok
            ? { code, status: 'ready', partners: readPartnerRows(result.rows), error: null }
            : { code, status: 'failed', partners: [], error: result.error ?? 'Query failed' },
        });
      } catch (err: unknown) {
        if (this.state.portFocus?.code === code && !isStale(err)) {
          this.setState({ portFocus: { code, status: 'failed', partners: [], error: describeError(err) } });
        }
        if (this.syncRespawn()) {
          this.requestEvaluation();
        }
      }
    });
  }

  clearPortFocus(): void {
    this.setState({ portFocus: null });
  }
}
