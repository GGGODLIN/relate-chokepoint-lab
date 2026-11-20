import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { getBundledCatalog } from '../src/contracts/catalog.ts';
import type { DragBBoxResult } from '../src/engine/bbox.ts';
import type {
  BootTelemetry,
  CustomBBoxApplyResult,
  CustomBBoxInput,
  CypherExecutionResult,
  PortRecord,
  RouteEvaluationResult,
  ScenarioEvaluationRequest,
  ScenarioEvaluationResult,
} from '../src/engine/chokepoint-engine.ts';
import type { QueryTelemetry } from '../src/engine/envelope.ts';
import { StaleRequestError, WorkerTimeoutError } from '../src/engine/worker-client.ts';
import { odKey, scenarioKey, type Evaluation, type Scenario } from '../src/ui/model.ts';
import {
  WorkbenchController,
  type WorkbenchClient,
  type WorkbenchState,
} from '../src/ui/workbench-controller.ts';

/*
 * State & concurrency patrol (version 2: scan + patrol). Hidden states found by reading
 * worker-client.ts, chokepoint-engine.ts and workbench-controller.ts, and where each is covered:
 *   - same-channel supersede (StaleRequestError)            -> fault "stale"
 *   - timeout/trap respawn re-boots a pristine graph          -> fault "timeout"
 *   - engine dirtyCustomBoxes: reseed only when dirty         -> FakeEngine.applyCustomBoxes
 *   - zero-match boxes are not applied                        -> box specs with lanes = 0
 *   - Live Cypher writes are invisible to the dirty flag      -> command "cypher-write"
 *   - controller mirrors (engineBoxesKey, epoch, loopQueued)  -> every random interleaving
 *   - box proposal racing Reset All / scenario edits          -> scheduleSequence interleavings
 * Not covered here: the fallback reference hub (needs > half the ports isolated), which
 * tests/workbench-engine.test.ts exercises against the real engine.
 */

const catalog = getBundledCatalog();
const GOLDEN = catalog.goldenRoutes;
const DEFAULT_BLOCKED = catalog.passages.filter((p) => p.defaultBlocked).map((p) => p.id);

const BASE_KM: Record<string, number> = {
  'TWKHH->NLRTM': 19882.1,
  'SGSIN->NLRTM': 16241.3,
  'AEJEA->ITGOA': 8314.8,
  'CNSHA->USLAX': 11502.5,
  'CNSHA->USNYC': 21524,
};
const USES: Record<string, readonly string[]> = {
  'TWKHH->NLRTM': ['suez', 'babalmandab', 'malacca'],
  'SGSIN->NLRTM': ['suez', 'babalmandab'],
  'AEJEA->ITGOA': ['suez', 'babalmandab'],
  'CNSHA->USLAX': [],
  'CNSHA->USNYC': ['panama'],
};
const CUTS: Record<string, readonly string[]> = { 'AEJEA->ITGOA': ['ormuz'] };
const DETOUR_KM: Record<string, number> = { suez: 4000, babalmandab: 2061, malacca: 900, panama: 3100 };
const ISOLATES: Record<string, number> = { ormuz: 20, gibraltar: 60, suez: 3, babalmandab: 6, bosporus: 8 };
const WRITE_KM = 1000;
const RUNS = Number(process.env.PATROL_RUNS ?? '250');

interface BoxSpec {
  readonly lanes: number;
  readonly detourKm: number;
  readonly isolates: number;
}

/* A box's matched lanes and impact are encoded in its rect so the oracle stays a pure function of the inputs. */
function encodeBox(spec: BoxSpec): DragBBoxResult {
  const rect = {
    swLon: spec.lanes,
    swLat: spec.detourKm / 100,
    neLon: spec.lanes + 1,
    neLat: spec.detourKm / 100 + spec.isolates + 1,
  };
  return {
    rects: [rect],
    sw: [rect.swLon, rect.swLat],
    ne: [rect.neLon, rect.neLat],
    lonSpanDeg: 1,
    latSpanDeg: rect.neLat - rect.swLat,
    crossesAntimeridian: false,
    exceedsMaxSpanWarning: false,
    warning: null,
  };
}

function decodeBox(box: CustomBBoxInput): BoxSpec {
  const rect = box.rects[0];
  if (rect === undefined) {
    throw new Error('box without rect');
  }
  return { lanes: rect.swLon, detourKm: rect.swLat * 100, isolates: rect.neLat - rect.swLat - 1 };
}

function routeKm(od: string, blocked: readonly string[], boxes: readonly BoxSpec[], mutationKm: number): number | null {
  if ((CUTS[od] ?? []).some((p) => blocked.includes(p))) {
    return null;
  }
  const base = BASE_KM[od];
  if (base === undefined) {
    throw new Error(`no base km for ${od}`);
  }
  const passages = (USES[od] ?? []).filter((p) => blocked.includes(p));
  const detour = passages.reduce((sum, p) => sum + (DETOUR_KM[p] ?? 500), 0);
  const boxKm = boxes.reduce((sum, b) => sum + b.detourKm, 0);
  return Math.round((base + detour + boxKm + mutationKm) * 10) / 10;
}

function isolatedCount(blocked: readonly string[], boxes: readonly BoxSpec[]): number {
  return blocked.reduce((sum, p) => sum + (ISOLATES[p] ?? 0), 0) + boxes.reduce((sum, b) => sum + b.isolates, 0);
}

interface Expected {
  readonly heroKm: number | null;
  readonly goldenKm: readonly (number | null)[];
  readonly isolated: number;
}

/** Independent oracle: what the screen must show for a scenario on a graph with `mutationKm` of Cypher damage. */
function oracle(scenario: Scenario, mutationKm: number): Expected {
  const boxes = scenario.boxes.map((box) => decodeBox(box));
  return {
    heroKm: routeKm(odKey(scenario.hero), scenario.blocked, boxes, mutationKm),
    goldenKm: GOLDEN.map((g) => routeKm(`${g.from}->${g.to}`, scenario.blocked, boxes, mutationKm)),
    isolated: isolatedCount(scenario.blocked, boxes),
  };
}

function displayed(evaluation: Evaluation): Expected {
  return {
    heroKm: evaluation.hero.isolated ? null : evaluation.hero.totalKm,
    goldenKm: evaluation.golden.map((g) => (g.current.isolated ? null : g.current.totalKm)),
    isolated: evaluation.isolation.isolatedCount,
  };
}

function sameNumbers(a: Expected, b: Expected): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type Fault = 'ok' | 'stale' | 'timeout';

/** The part of fc.Scheduler the fake needs; a pass-through implementation replays FIFO order. */
interface TaskScheduler {
  schedule<T>(task: Promise<T>, label?: string): Promise<T>;
}

const FIFO: TaskScheduler = { schedule: (task) => task };

const ZERO_TELEMETRY: QueryTelemetry = {
  elapsedMs: 0.5,
  executeMs: 0.4,
  planCache: 'miss',
  plan: null,
  notifications: [],
  stats: {},
};

interface FakeGraph {
  applied: { id: string; spec: BoxSpec }[];
  dirty: boolean;
  mutationKm: number;
}

/** Stands in for the Dedicated Worker boundary, reproducing the engine's stateful custom-box semantics. */
class FakeWorker implements WorkbenchClient {
  respawnCount = 0;
  inFlight = 0;
  maxInFlight = 0;
  graph: FakeGraph = { applied: [], dirty: false, mutationKm: 0 };
  readonly mutationHistory = new Set<number>([0]);
  private faults: readonly Fault[] = [];
  private callIndex = 0;
  private readonly scheduler: TaskScheduler;

  constructor(scheduler: TaskScheduler) {
    this.scheduler = scheduler;
  }

  /** Faults are consumed one per engine call from here on, then every call succeeds. */
  injectFaults(faults: readonly Fault[]): void {
    this.faults = faults;
    this.callIndex = 0;
  }

  private reseed(): void {
    this.graph = { applied: [], dirty: false, mutationKm: 0 };
    this.mutationHistory.add(0);
  }

  private call<T>(label: string, channel: string | null, compute: () => T): Promise<T> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const fault = this.faults[this.callIndex++] ?? 'ok';
    return this.scheduler.schedule(Promise.resolve(label), label).then(() => {
      this.inFlight--;
      if (fault === 'stale' && channel !== null) {
        throw new StaleRequestError(channel, this.callIndex, this.callIndex + 1);
      }
      if (fault === 'timeout') {
        // The real client terminates the worker, rejects, and re-boots a pristine graph.
        this.respawnCount++;
        this.reseed();
        throw new WorkerTimeoutError('queryRoute', 15_000, null);
      }
      return compute();
    });
  }

  private route(from: string, to: string, blocked: readonly string[]): RouteEvaluationResult {
    const km = routeKm(`${from}->${to}`, blocked, this.graph.applied.map((a) => a.spec), this.graph.mutationKm);
    return {
      fromCode: from,
      toCode: to,
      hops: km === null ? null : 100,
      totalKm: km,
      isolated: km === null,
      shortCircuited: false,
      coords: [],
      segments: [],
      nodeIds: [],
      edgeIds: [],
      passagesTraversed: [],
      cypher: 'MATCH route',
      params: { from, to },
      telemetry: ZERO_TELEMETRY,
    };
  }

  boot(): Promise<BootTelemetry> {
    return this.call('boot', null, () => {
      this.reseed();
      return {
        bootMs: 10,
        batchesExecuted: 1,
        chunkSize: 1,
        pointIndexesOnline: [],
        totalIndexesOnline: 0,
        counts: { waypoints: 1, ports: 1, countries: 1, maritimeEdges: 1, tradesWith: 1 },
      };
    });
  }

  getPorts(): Promise<readonly PortRecord[]> {
    return this.call('getPorts', null, () => []);
  }

  queryRoute(from: string, to: string, blocked: readonly string[]): Promise<RouteEvaluationResult> {
    return this.call(`route ${from}->${to}`, 'route', () => this.route(from, to, blocked));
  }

  evaluateScenario(request: ScenarioEvaluationRequest): Promise<ScenarioEvaluationResult> {
    return this.call('scenario', 'scenario', () => {
      const blocked = [...request.blockedPassageIds];
      const count = isolatedCount(blocked, this.graph.applied.map((a) => a.spec));
      return {
        blockedPassageIds: blocked,
        openRelTypes: [],
        customBoxResult: null,
        route: this.route(request.routeFrom ?? '', request.routeTo ?? '', blocked),
        isolation: {
          referenceHubCode: catalog.referenceHubCode,
          totalPorts: 758,
          reachablePorts: 758 - count,
          isolatedCount: count,
          isolatedPorts: Array.from({ length: count }, (_, i) => ({
            code: `P${i}`,
            name: `Port ${i}`,
            country: 'Testland',
            lon: 0,
            lat: 0,
            rank: i,
            tradeDegree: count - i,
          })),
          cypher: 'MATCH isolation',
          params: { refHub: catalog.referenceHubCode },
          telemetry: ZERO_TELEMETRY,
        },
        tradeExposure: {
          countries: count > 0 ? [{ countryCode: 'TL', countryName: 'Testland', exposedPorts: count }] : [],
          cypher: 'MATCH trade',
          params: {},
          telemetry: ZERO_TELEMETRY,
        },
        totalElapsedMs: 1,
      };
    });
  }

  applyCustomBoxes(boxes: readonly CustomBBoxInput[]): Promise<CustomBBoxApplyResult> {
    return this.call('applyCustomBoxes', 'customBoxes', () => {
      let reseeded = false;
      if (this.graph.dirty) {
        this.reseed();
        reseeded = true;
      } else if (boxes.length === 0) {
        this.graph.applied = [];
      }
      const matches = boxes.map((box) => {
        const spec = decodeBox(box);
        const ids = Array.from({ length: spec.lanes }, (_, i) => `${box.id}-e${i}`);
        return { boxId: box.id, matchedEdgeIds: ids, matchedEdgeCount: ids.length, truncated: false };
      });
      const applied = boxes.filter((box) => decodeBox(box).lanes > 0).map((box) => ({ id: box.id, spec: decodeBox(box) }));
      if (applied.length > 0) {
        this.graph.applied = applied;
        this.graph.dirty = true;
      }
      const total = matches.reduce((sum, m) => sum + m.matchedEdgeCount, 0);
      return {
        matchedEdgeCount: total,
        deletedEdgeCount: total,
        mutated: total > 0,
        reseeded,
        reseedMs: reseeded ? 1 : null,
        activeBoxCount: this.graph.applied.length,
        activeBoxIds: this.graph.applied.map((a) => a.id),
        truncated: false,
        boxMatches: matches,
        cypher: null,
        telemetry: null,
      };
    });
  }

  runCustomCypher(cypher: string, params: Readonly<Record<string, unknown>> | null): Promise<CypherExecutionResult> {
    return this.call('cypher', null, () => {
      if (cypher.includes('BROKEN')) {
        return { ok: false, cypher, params, columns: [], columnTypes: [], rows: [], error: 'syntax error', telemetry: ZERO_TELEMETRY };
      }
      if (cypher.includes('DELETE')) {
        this.graph.mutationKm += WRITE_KM;
        this.mutationHistory.add(this.graph.mutationKm);
        return {
          ok: true,
          cypher,
          params,
          columns: [],
          columnTypes: [],
          rows: [],
          error: null,
          telemetry: { ...ZERO_TELEMETRY, stats: { relationships_deleted: 2, nodes_created: 0 } },
        };
      }
      return {
        ok: true,
        cypher,
        params,
        columns: ['countryCode', 'countryName'],
        columnTypes: ['String', 'String'],
        rows: [{ countryCode: 'TL', countryName: 'Testland' }],
        error: null,
        telemetry: { ...ZERO_TELEMETRY, stats: { relationships_deleted: 0 } },
      };
    });
  }

  getStats(): { readonly respawnCount: number } {
    return { respawnCount: this.respawnCount };
  }
}

type Command =
  | { readonly kind: 'preset'; readonly index: number }
  | { readonly kind: 'toggle'; readonly passage: string }
  | { readonly kind: 'hero'; readonly index: number }
  | { readonly kind: 'box'; readonly spec: BoxSpec }
  | { readonly kind: 'removeBox'; readonly index: number }
  | { readonly kind: 'reset' }
  | { readonly kind: 'cypher'; readonly variant: 'read' | 'write' | 'error' }
  | { readonly kind: 'restore' }
  | { readonly kind: 'focusPort' };

const TOGGLEABLE = ['suez', 'babalmandab', 'ormuz', 'malacca', 'panama', 'gibraltar', 'bosporus', 'northwest'];

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant('preset' as const), index: fc.nat({ max: 2 }) }),
  fc.record({ kind: fc.constant('toggle' as const), passage: fc.constantFrom(...TOGGLEABLE) }),
  fc.record({ kind: fc.constant('hero' as const), index: fc.nat({ max: 4 }) }),
  fc.record({
    kind: fc.constant('box' as const),
    spec: fc.record({
      lanes: fc.constantFrom(0, 4),
      detourKm: fc.constantFrom(0, 700),
      isolates: fc.constantFrom(0, 2),
    }),
  }),
  fc.record({ kind: fc.constant('removeBox' as const), index: fc.nat({ max: 3 }) }),
  fc.constant({ kind: 'reset' as const }),
  fc.record({ kind: fc.constant('cypher' as const), variant: fc.constantFrom('read' as const, 'write' as const, 'error' as const) }),
  fc.constant({ kind: 'restore' as const }),
  fc.constant({ kind: 'focusPort' as const }),
);

const CYPHER_TEXT = {
  read: 'MATCH (c:Country) RETURN c.code AS countryCode, c.name AS countryName',
  write: 'MATCH ()-[r:PASSAGE_SUEZ]-() DELETE r',
  error: 'MATCH (p:Port BROKEN',
} as const;

function runCommand(controller: WorkbenchController, command: Command): Promise<void> {
  const state = controller.getSnapshot();
  switch (command.kind) {
    case 'preset': {
      const preset = catalog.presets[command.index];
      if (preset !== undefined) {
        controller.selectPreset(preset.id);
      }
      return Promise.resolve();
    }
    case 'toggle':
      controller.togglePassage(command.passage);
      return Promise.resolve();
    case 'hero': {
      const route = GOLDEN[command.index];
      if (route !== undefined) {
        controller.setHero({ from: route.from, to: route.to });
      }
      return Promise.resolve();
    }
    case 'box':
      return controller.proposeBox(encodeBox(command.spec));
    case 'removeBox': {
      const box = state.scenario.boxes[command.index % Math.max(1, state.scenario.boxes.length)];
      if (box !== undefined) {
        controller.removeBox(box.id);
      }
      return Promise.resolve();
    }
    case 'reset':
      controller.resetAll();
      return Promise.resolve();
    case 'cypher':
      return controller.runInspector(CYPHER_TEXT[command.variant], '', false);
    case 'restore':
      return controller.restoreGraph();
    case 'focusPort':
      return controller.focusPort('AEJEA');
  }
}

interface Violation {
  readonly invariant: string;
  readonly detail: unknown;
}

/** P2: whatever is on screen was computed for exactly one scenario on one graph version (never a mix). */
function checkNoMixing(state: WorkbenchState, worker: FakeWorker): Violation | null {
  const evaluation = state.evaluation;
  if (evaluation === null) {
    return null;
  }
  const shown = displayed(evaluation);
  for (const mutationKm of worker.mutationHistory) {
    if (sameNumbers(shown, oracle(evaluation.scenario, mutationKm))) {
      return null;
    }
  }
  return { invariant: 'P2 no mixed results', detail: { shown, scenario: scenarioKey(evaluation.scenario) } };
}

/** P8: a result only reaches the screen while it still answers the user's current choice. */
function checkFreshCommit(previous: Evaluation | null, state: WorkbenchState): Violation | null {
  const evaluation = state.evaluation;
  if (evaluation === null || evaluation === previous || evaluation.key === scenarioKey(state.scenario)) {
    return null;
  }
  return { invariant: 'P8 superseded results never reach the screen', detail: { shown: evaluation.key, wanted: scenarioKey(state.scenario) } };
}

/** P1, P3, P5, P6 at quiescence; `strict` additionally forbids evaluation errors (no faults injected). */
function checkQuiescent(state: WorkbenchState, worker: FakeWorker, strict: boolean): Violation | null {
  if (state.busy || state.pendingBox !== null) {
    return { invariant: 'quiescence', detail: { busy: state.busy, pendingBox: state.pendingBox?.id } };
  }
  if (state.toasts.some((t) => /superseded|StaleRequest/i.test(t.message))) {
    return { invariant: 'P5 stale responses stay silent', detail: state.toasts };
  }
  if (state.graphMutated !== worker.graph.mutationKm > 0) {
    return { invariant: 'P6 mutation banner matches the graph', detail: { flag: state.graphMutated, mutationKm: worker.graph.mutationKm } };
  }
  if (state.evaluationError !== null) {
    return strict ? { invariant: 'strict: no evaluation errors', detail: state.evaluationError } : null;
  }
  const evaluation = state.evaluation;
  if (evaluation === null || evaluation.key !== scenarioKey(state.scenario)) {
    return { invariant: 'P1 screen shows the latest scenario', detail: { shown: evaluation?.key, wanted: scenarioKey(state.scenario) } };
  }
  if (!sameNumbers(displayed(evaluation), oracle(state.scenario, worker.graph.mutationKm))) {
    return {
      invariant: 'P1 numbers equal the oracle for the latest scenario',
      detail: { shown: displayed(evaluation), expected: oracle(state.scenario, worker.graph.mutationKm) },
    };
  }
  const engineBoxes = worker.graph.applied.map((a) => a.id).sort();
  const wantedBoxes = state.scenario.boxes.map((b) => b.id).sort();
  if (JSON.stringify(engineBoxes) !== JSON.stringify(wantedBoxes)) {
    return { invariant: 'P3 chips equal the boxes applied in the engine', detail: { engineBoxes, wantedBoxes } };
  }
  return null;
}

async function bootController(scheduler: fc.Scheduler) {
  return bootWith(scheduler, (promise) => scheduler.waitFor(promise));
}

async function bootWith(scheduler: TaskScheduler, drive: (promise: Promise<void>) => Promise<void>) {
  const worker = new FakeWorker(scheduler);
  const controller = new WorkbenchController(worker, catalog);
  const violations: Violation[] = [];
  let shownEvaluation: Evaluation | null = null;
  controller.subscribe(() => {
    const state = controller.getSnapshot();
    const violation = checkNoMixing(state, worker) ?? checkFreshCommit(shownEvaluation, state);
    if (violation !== null) {
      violations.push(violation);
    }
    shownEvaluation = state.evaluation;
    if (worker.maxInFlight > 1) {
      violations.push({ invariant: 'P4 one engine call at a time', detail: worker.maxInFlight });
    }
  });
  await drive(controller.start(async () => ({ payloadUrl: 'fake://graph' })));
  await drive(controller.whenIdle());
  return { worker, controller, violations };
}

/**
 * Users click without waiting for the worker, so each command is fired and forgotten; awaiting it
 * inside scheduleSequence would deadlock because its promise needs other scheduled worker replies.
 */
function fire(controller: WorkbenchController, command: Command, violations: Violation[]): Promise<void> {
  runCommand(controller, command).catch((err: unknown) => {
    violations.push({ invariant: 'controller promises never reject', detail: String(err) });
  });
  return Promise.resolve();
}

async function runScenario(
  scheduler: fc.Scheduler,
  commands: readonly Command[],
  faults: readonly Fault[],
  strict: boolean,
): Promise<Violation[]> {
  const { worker, controller, violations } = await bootController(scheduler);
  worker.injectFaults(faults);
  const sequence = scheduler.scheduleSequence(
    commands.map((command) => ({ label: JSON.stringify(command), builder: () => fire(controller, command, violations) })),
  );
  await scheduler.waitFor(sequence.task);
  await scheduler.waitFor(controller.whenIdle());
  const quiescent = checkQuiescent(controller.getSnapshot(), worker, strict);
  if (quiescent !== null) {
    violations.push(quiescent);
  }
  controller.resetAll();
  await scheduler.waitFor(controller.whenIdle());
  const afterReset = controller.getSnapshot();
  const resetViolation = checkQuiescent(afterReset, worker, strict);
  if (resetViolation !== null) {
    violations.push({ invariant: 'P7 Reset All', detail: resetViolation });
  } else if (
    afterReset.evaluationError === null &&
    (JSON.stringify(afterReset.scenario.blocked) !== JSON.stringify(DEFAULT_BLOCKED) ||
      afterReset.scenario.boxes.length > 0 ||
      worker.graph.mutationKm !== 0)
  ) {
    violations.push({
      invariant: 'P7 Reset All returns to the default blockade on a canonical graph',
      detail: { blocked: afterReset.scenario.blocked, boxes: afterReset.scenario.boxes.length, mutationKm: worker.graph.mutationKm },
    });
  }
  return violations;
}

/** Throws with the violated invariants so fast-check reports them next to the shrunk counterexample. */
function noViolations(violations: readonly Violation[]): true {
  if (violations.length > 0) {
    throw new Error(JSON.stringify(violations).slice(0, 1200));
  }
  return true;
}

const faultArb = fc.array(fc.constantFrom<Fault>('ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'stale', 'timeout'), {
  maxLength: 30,
});

describe('workbench controller under random interleavings (fake worker boundary)', () => {
  it('replay: Reset All while a box proposal is in flight leaves no trial box in the engine', async () => {
    // Shrunk counterexample from the fault-free patrol: boot, draw an impactful box, Reset All
    // before the box check finishes. The trial box used to stay applied in the worker.
    const { worker, controller, violations } = await bootWith(FIFO, (promise) => promise);
    const proposal = controller.proposeBox(encodeBox({ lanes: 4, detourKm: 700, isolates: 0 }));
    controller.resetAll();
    await proposal;
    await controller.whenIdle();
    const state = controller.getSnapshot();
    expect(state.scenario.boxes).toEqual([]);
    expect(worker.graph.applied.map((a) => a.id)).toEqual([]);
    expect(checkQuiescent(state, worker, true)).toBeNull();
    expect(violations).toEqual([]);
  });

  it('replay: a Live Cypher write queued ahead of a box proposal never leaves stale numbers on screen', async () => {
    // Shrunk counterexample from the faulty patrol: with a box already applied, a DELETE queued before a
    // second box let the box check reseed the graph (wiping the write) without recomputing the screen.
    const { worker, controller, violations } = await bootWith(FIFO, (promise) => promise);
    await controller.proposeBox(encodeBox({ lanes: 4, detourKm: 700, isolates: 0 }));
    await controller.whenIdle();
    const write = controller.runInspector(CYPHER_TEXT.write, '', false);
    const proposal = controller.proposeBox(encodeBox({ lanes: 4, detourKm: 300, isolates: 0 }));
    await Promise.all([write, proposal]);
    await controller.whenIdle();
    const state = controller.getSnapshot();
    expect(checkQuiescent(state, worker, true)).toBeNull();
    expect(state.graphMutated).toBe(true);
    expect(state.evaluation?.hero.totalKm).toBe(19882.1 + 700 + WRITE_KM);
    expect(state.toasts.map((t) => t.message)).toContain('Restore the canonical graph before drawing boxes: Live Cypher changed it.');
    expect(violations).toEqual([]);
  });

  it('replay control: the same impactful box without Reset All is applied in both screen and engine', async () => {
    const { worker, controller } = await bootWith(FIFO, (promise) => promise);
    await controller.proposeBox(encodeBox({ lanes: 4, detourKm: 700, isolates: 0 }));
    await controller.whenIdle();
    const state = controller.getSnapshot();
    expect(state.scenario.boxes.map((b) => b.id)).toEqual(['box-1']);
    expect(worker.graph.applied.map((a) => a.id)).toEqual(['box-1']);
    expect(state.evaluation?.hero.totalKm).toBe(19882.1 + 700);
  });

  it('oracle calibration: each invariant check rejects a known-bad state', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async (scheduler) => {
        const { worker, controller } = await bootController(scheduler);
        const good = controller.getSnapshot();
        expect(checkQuiescent(good, worker, true)).toBeNull();
        expect(checkNoMixing(good, worker)).toBeNull();
        const evaluation = good.evaluation;
        if (evaluation === null) {
          throw new Error('boot produced no evaluation');
        }
        // P1: the screen still shows an older scenario.
        const stale: WorkbenchState = { ...good, scenario: { ...good.scenario, blocked: [...good.scenario.blocked, 'suez'].sort() } };
        expect(checkQuiescent(stale, worker, true)?.invariant).toBe('P1 screen shows the latest scenario');
        // P2: hero computed for one scenario, isolation for another.
        const mixed: WorkbenchState = {
          ...good,
          evaluation: { ...evaluation, isolation: { ...evaluation.isolation, isolatedCount: evaluation.isolation.isolatedCount + 20 } },
        };
        expect(checkNoMixing(mixed, worker)?.invariant).toBe('P2 no mixed results');
        // P8: a result for an older choice is committed after the user moved on.
        expect(checkFreshCommit(null, stale)?.invariant).toBe('P8 superseded results never reach the screen');
        expect(checkFreshCommit(evaluation, good)).toBeNull();
        // P3: the engine still holds a box the user removed.
        worker.graph.applied = [{ id: 'ghost', spec: { lanes: 1, detourKm: 0, isolates: 0 } }];
        expect(checkQuiescent(good, worker, true)?.invariant).toBe('P3 chips equal the boxes applied in the engine');
        worker.graph.applied = [];
        // P5: a stale-response toast leaked to the user.
        const noisy: WorkbenchState = { ...good, toasts: [{ id: 1, tone: 'error', message: 'Request #3 was superseded' }] };
        expect(checkQuiescent(noisy, worker, true)?.invariant).toBe('P5 stale responses stay silent');
        // P6: the graph was written to but no banner is shown.
        worker.graph.mutationKm = WRITE_KM;
        expect(checkQuiescent(good, worker, true)?.invariant).toBe('P6 mutation banner matches the graph');
        return true;
      }),
      { numRuns: 3 },
    );
  });

  it('fault-free: every interleaving ends on the latest scenario with clean chips and a working Reset All', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), fc.array(commandArb, { minLength: 1, maxLength: 12 }), async (scheduler, commands) => {
        return noViolations(await runScenario(scheduler, commands, [], true));
      }),
      { numRuns: RUNS },
    );
  }, 120_000);

  it('with injected stale responses and worker timeouts the screen never mixes results and recovers', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), fc.array(commandArb, { minLength: 1, maxLength: 12 }), faultArb, async (scheduler, commands, faults) => {
        return noViolations(await runScenario(scheduler, commands, faults, false));
      }),
      { numRuns: RUNS },
    );
  }, 120_000);

  it('reachability: the patrol really exercises boxes, rejections, writes and respawns', async () => {
    const seen = { acceptedBox: 0, rejectedBox: 0, mutated: 0, respawned: 0 };
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), fc.array(commandArb, { minLength: 4, maxLength: 12 }), faultArb, async (scheduler, commands, faults) => {
        const { worker, controller, violations } = await bootController(scheduler);
        worker.injectFaults(faults);
        const sequence = scheduler.scheduleSequence(commands.map((command) => () => fire(controller, command, violations)));
        await scheduler.waitFor(sequence.task);
        await scheduler.waitFor(controller.whenIdle());
        const state = controller.getSnapshot();
        seen.acceptedBox += state.scenario.boxes.length > 0 ? 1 : 0;
        seen.rejectedBox += state.toasts.some((t) => /nothing was blocked|0 detours/.test(t.message)) ? 1 : 0;
        seen.mutated += worker.mutationHistory.size > 1 ? 1 : 0;
        seen.respawned += worker.respawnCount > 0 ? 1 : 0;
        return true;
      }),
      { numRuns: Math.ceil(RUNS / 2) },
    );
    expect(seen, JSON.stringify(seen)).toEqual({
      acceptedBox: expect.any(Number),
      rejectedBox: expect.any(Number),
      mutated: expect.any(Number),
      respawned: expect.any(Number),
    });
    expect(Math.min(seen.acceptedBox, seen.rejectedBox, seen.mutated, seen.respawned), JSON.stringify(seen)).toBeGreaterThan(0);
  }, 120_000);
});

