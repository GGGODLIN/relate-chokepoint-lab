import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBundledCatalog } from '../src/contracts/catalog.ts';
import { normalizeDragBBox, type BBoxRect, type DragBBoxResult } from '../src/engine/bbox.ts';
import { ChokepointEngine } from '../src/engine/chokepoint-engine.ts';
import { QueryBuilder } from '../src/engine/query-builder.ts';
import { initRelateWasmNode } from '../src/engine/probe.ts';
import type { WasmGraphPayload } from '../src/etl/build-graph.ts';
import { compareRoutes, formatInt, formatSignedKm, formatSignedPct, sortIsolatedPorts } from '../src/ui/model.ts';
import { PRESET_CARDS } from '../src/ui/presets.ts';
import { WorkbenchController, type WorkbenchClient } from '../src/ui/workbench-controller.ts';

/*
 * The workbench controller driven against the real Relate v1.1.0 engine in-process (the same
 * ChokepointEngine the Dedicated Worker hosts). Expected numbers come from the brief and ticket
 * (9 / 20 / 103 isolated, +6,061.1 km / +30.5%) and from the native CLI, never from this code.
 */

const ROOT_DIR = resolve(import.meta.dirname, '..');
const payload = JSON.parse(
  readFileSync(resolve(ROOT_DIR, 'public/data/graph.wasm.json'), 'utf8'),
) as WasmGraphPayload;
const catalog = getBundledCatalog();
const TIMEOUT = 120_000;

function inProcessClient(engine: ChokepointEngine): WorkbenchClient {
  return {
    boot: async () => engine.boot(payload),
    getPorts: async () => engine.getPorts(),
    queryRoute: async (from, to, blocked) => engine.queryRoute(from, to, blocked),
    evaluateScenario: async (request) => engine.evaluateScenario(request),
    applyCustomBoxes: async (boxes) => engine.applyCustomBoxes(boxes),
    runCustomCypher: async (cypher, params, options) => engine.runCustomCypher(cypher, params, options),
    getStats: () => ({ respawnCount: 0 }),
  };
}

function dragFor(rects: readonly BBoxRect[]): DragBBoxResult {
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error('dragFor needs at least one rect');
  }
  return {
    rects,
    sw: [first.swLon, first.swLat],
    ne: [last.neLon, last.neLat],
    lonSpanDeg: rects.reduce((sum, r) => sum + (r.neLon - r.swLon), 0),
    latSpanDeg: first.neLat - first.swLat,
    crossesAntimeridian: rects.length > 1,
    exceedsMaxSpanWarning: false,
    warning: null,
  };
}

const SAHARA: BBoxRect = { swLon: 10, swLat: 18, neLon: 14, neLat: 22 };
const BAB_EL_MANDEB: BBoxRect = { swLon: 42, swLat: 11, neLon: 45, neLat: 14 };
const SOUTH_PACIFIC: BBoxRect = { swLon: -140, swLat: -40, neLon: -130, neLat: -30 };
const ROTTERDAM: BBoxRect = { swLon: 3.6, swLat: 51.7, neLon: 4.6, neLat: 52.1 };

describe('workbench controller on the real Relate engine', () => {
  let engine: ChokepointEngine;
  let controller: WorkbenchController;

  beforeAll(async () => {
    initRelateWasmNode();
    engine = new ChokepointEngine();
    controller = new WorkbenchController(inProcessClient(engine), catalog);
    await controller.start(async () => ({ payload }));
    await controller.whenIdle();
  }, TIMEOUT);

  afterAll(() => {
    engine.dispose();
  });

  async function settle(): Promise<void> {
    await controller.whenIdle();
  }

  /** Reset All keeps the user's hero route by design, so tests pin Kaohsiung -> Rotterdam explicitly. */
  async function resetAll(): Promise<void> {
    controller.setHero({ from: 'TWKHH', to: 'NLRTM' });
    controller.resetAll();
    await settle();
  }

  it('boots to the default blockade with the canonical baseline on screen', () => {
    const state = controller.getSnapshot();
    expect(state.boot.phase).toBe('ready');
    expect(state.ports).toHaveLength(758);
    expect(state.scenario.blocked).toEqual(['northwest']);
    expect(state.evaluation?.hero).toMatchObject({ from: 'TWKHH', to: 'NLRTM', totalKm: 19882.1, hops: 126 });
    expect(state.evaluation?.isolation.isolatedCount).toBe(0);
  });

  it('preset buttons show exactly the counts the engine computes (9 / 20 / 103)', async () => {
    const observed: Record<string, number | undefined> = {};
    for (const card of PRESET_CARDS) {
      controller.selectPreset(card.presetId);
      // Sequential on purpose: each preset must settle before the next is measured.
      await settle();
      observed[card.presetId] = controller.getSnapshot().evaluation?.isolation.isolatedCount;
    }
    expect(observed).toEqual({ 'suez-babalmandab': 9, hormuz: 20, 'gibraltar-suez': 103 });
    expect(PRESET_CARDS.map((card) => card.isolatedCount)).toEqual([9, 20, 103]);
  }, TIMEOUT);

  it('Suez + Bab el-Mandeb reroutes Kaohsiung → Rotterdam by +6,061.1 km (+30.5%, 126 → 133 hops)', async () => {
    controller.selectPreset('suez-babalmandab');
    await settle();
    const evaluation = controller.getSnapshot().evaluation;
    if (evaluation === null) {
      throw new Error('no evaluation');
    }
    const delta = compareRoutes(evaluation.heroBaseline, evaluation.hero);
    expect(delta).toEqual({ status: 'rerouted', deltaKm: 6061.1, deltaPct: 30.5, deltaHops: 7 });
    expect(formatSignedKm(delta.deltaKm ?? 0)).toBe('+6,061.1 km');
    expect(formatSignedPct(delta.deltaPct ?? 0)).toBe('+30.5%');
    const suezCard = PRESET_CARDS.find((card) => card.presetId === 'suez-babalmandab');
    expect(suezCard?.detail.startsWith(`+${formatInt(Math.round(delta.deltaKm ?? 0))} km`)).toBe(true);
    const isolated = sortIsolatedPorts(evaluation.isolation.ports);
    expect(isolated).toHaveLength(9);
    expect(isolated.map((p) => p.code)).toContain('SAJED');
    for (let i = 1; i < isolated.length; i += 1) {
      expect(isolated[i - 1]!.tradeDegree).toBeGreaterThanOrEqual(isolated[i]!.tradeDegree);
    }
  }, TIMEOUT);

  it('Strait of Hormuz cuts Jebel Ali off and ranks the UAE first in the trade cascade', async () => {
    controller.selectPreset('hormuz');
    await settle();
    const evaluation = controller.getSnapshot().evaluation;
    expect(evaluation?.hero).toMatchObject({ from: 'AEJEA', to: 'ITGOA', isolated: true });
    expect(evaluation?.tradeExposure[0]).toEqual({ countryCode: 'AE', countryName: 'United Arab Emirates', exposedPorts: 11 });
  }, TIMEOUT);

  it('a box over open desert matches no lanes: toast only, nothing applied', async () => {
    await resetAll();
    await controller.proposeBox(dragFor([SAHARA]));
    await settle();
    const state = controller.getSnapshot();
    expect(state.scenario.boxes).toEqual([]);
    expect(state.toasts.at(-1)?.message).toMatch(/No sea-lane segments inside that box/);
    expect(state.evaluation?.hero.totalKm).toBe(19882.1);
  }, TIMEOUT);

  it('a box that cuts lanes without forcing a detour is rejected and its lanes are restored', async () => {
    await resetAll();
    await controller.proposeBox(dragFor([SOUTH_PACIFIC]));
    await settle();
    const state = controller.getSnapshot();
    expect(state.scenario.boxes).toEqual([]);
    expect(state.toasts.at(-1)?.message).toMatch(/forces 0 detours/);
    // Positive control: the 46 lanes inside the rejected box are back in the live graph.
    const lanes = engine.runCustomCypher(QueryBuilder.buildBBoxEdgesQuery(), { boxes: [SOUTH_PACIFIC], limit: 500 });
    expect(lanes.ok).toBe(true);
    expect(lanes.rows).toHaveLength(46);
    expect(typeof lanes.rows[0]?.edgeId).toBe('string');
  }, TIMEOUT);

  it('a box over Bab el-Mandeb is applied, reroutes the hero, and removing its chip restores the baseline', async () => {
    await resetAll();
    await controller.proposeBox(dragFor([BAB_EL_MANDEB]));
    await settle();
    let state = controller.getSnapshot();
    expect(state.scenario.boxes).toHaveLength(1);
    expect(state.evaluation?.hero.totalKm).toBe(25943.2);
    expect(state.evaluation?.boxMatches[0]?.matchedEdgeIds).toHaveLength(12);
    const box = state.scenario.boxes[0];
    if (box === undefined) {
      throw new Error('box missing');
    }
    controller.removeBox(box.id);
    await settle();
    state = controller.getSnapshot();
    expect(state.scenario.boxes).toEqual([]);
    expect(state.evaluation?.hero.totalKm).toBe(19882.1);
    expect(engine.getMetadata().activeBoxIds).toEqual([]);
  }, TIMEOUT);

  it('an antimeridian-crossing drag becomes two rects and reroutes Shanghai → Los Angeles', async () => {
    await resetAll();
    // Unwrapped MapLibre-style unprojector: screen x 0..100 maps to longitude 175..185 (crossing 180).
    const drag = normalizeDragBBox({ x: 100, y: 0 }, { x: 0, y: 100 }, ([x, y]) => ({ lng: 175 + x / 10, lat: 62 - y * 0.37 }));
    expect(drag.crossesAntimeridian).toBe(true);
    expect(drag.rects).toHaveLength(2);
    await controller.proposeBox(drag);
    await settle();
    const state = controller.getSnapshot();
    expect(state.scenario.boxes).toHaveLength(1);
    const uslax = state.evaluation?.golden.find((g) => g.route.id === 'cnsha-uslax');
    expect(uslax?.baseline?.totalKm).toBe(11502.5);
    expect(uslax?.current.totalKm).toBeGreaterThan(11502.5);
  }, TIMEOUT);

  it('a box that cuts off Rotterdam switches isolation to the fallback hub instead of reporting 757 ports', async () => {
    await resetAll();
    await controller.proposeBox(dragFor([ROTTERDAM]));
    await settle();
    const evaluation = controller.getSnapshot().evaluation;
    expect(evaluation?.isolation.fallbackUsed).toBe(true);
    expect(evaluation?.isolation.referenceHubCode).toBe('SGSIN');
    expect(evaluation?.isolation.isolatedCount).toBeLessThan(100);
    expect(evaluation?.isolation.ports.map((p) => p.code)).toContain('NLRTM');
    expect(evaluation?.hero.isolated).toBe(true);
  }, TIMEOUT);

  it('Live Cypher: env.error is reported and the next query still runs', async () => {
    await resetAll();
    await controller.runInspector('MATCH (p:Port RETURN p', '', false);
    let state = controller.getSnapshot();
    expect(state.inspector.status).toBe('failed');
    expect(state.inspector.result?.error).toMatch(/syntax error/);
    await controller.runInspector(
      'MATCH (p:Port {code: $code})-[:TRADES_WITH]->(c:Country) RETURN count(c) AS partners',
      '{"code": "TWKHH"}',
      true,
    );
    state = controller.getSnapshot();
    expect(state.inspector.status).toBe('done');
    // 45 partners is what the native CLI returns for the same query on data/chokepoint.rl.
    expect(state.inspector.result?.rows[0]).toEqual({ partners: 45 });
    expect(state.inspector.result?.cypher.startsWith('PROFILE')).toBe(true);
    expect(state.graphMutated).toBe(false);
  }, TIMEOUT);

  it('Live Cypher writes are flagged, change the numbers, and Reset All re-seeds the canonical graph', async () => {
    await resetAll();
    await controller.runInspector('MATCH ()-[r:PASSAGE_SUEZ]-() DELETE r', '', false);
    await settle();
    let state = controller.getSnapshot();
    expect(state.graphMutated).toBe(true);
    expect(state.inspector.wroteGraph).toBe(true);
    // No passage is blocked, yet Suez edges are gone: the hero now takes the Cape route.
    expect(state.evaluation?.hero.totalKm).toBe(25943.2);
    controller.resetAll();
    await settle();
    state = controller.getSnapshot();
    expect(state.graphMutated).toBe(false);
    expect(state.evaluation?.hero.totalKm).toBe(19882.1);
  }, TIMEOUT);

  it('clicking a port lists its trading countries from TRADES_WITH', async () => {
    await controller.focusPort('TWKHH');
    const focus = controller.getSnapshot().portFocus;
    expect(focus?.status).toBe('ready');
    expect(focus?.partners).toHaveLength(45);
    expect(focus?.partners[0]).toEqual({ countryCode: expect.stringMatching(/^[A-Z]{2}$/), countryName: expect.any(String) });
    expect(controller.getSnapshot().portQuery?.cypher).toMatch(/TRADES_WITH/);
  }, TIMEOUT);
});
