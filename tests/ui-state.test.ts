import { describe, expect, it } from 'vitest';
import { getBundledCatalog } from '../src/contracts/catalog.ts';
import type { PortRecord } from '../src/engine/chokepoint-engine.ts';
import {
  boxCollection,
  goldenRouteCollection,
  heroRouteCollection,
  routeBounds,
  severedEdgeIds,
} from '../src/ui/map-data.ts';
import {
  activePresetId,
  addBox,
  buildCliReadOnlyCommand,
  compareRoutes,
  countGraphWrites,
  defaultScenario,
  formatSignedKm,
  formatSignedPct,
  hasDetourImpact,
  parseParamsText,
  presetScenario,
  removeBox,
  resetBlockades,
  scenarioKey,
  searchPorts,
  sortIsolatedPorts,
  togglePassage,
  unblockPassage,
  withHero,
  type DrawnBox,
  type Evaluation,
  type RouteSummary,
} from '../src/ui/model.ts';
import { BFS_APPROXIMATION_NOTE, LOADING_MESSAGE, PRESET_CARDS } from '../src/ui/presets.ts';

const catalog = getBundledCatalog();

function route(from: string, to: string, totalKm: number | null, hops: number | null, segments: RouteSummary['segments'] = []): RouteSummary {
  return { from, to, totalKm, hops, isolated: totalKm === null, segments, passages: [] };
}

const BASELINE = route('TWKHH', 'NLRTM', 19882.1, 126, [[[120.3, 22.6], [32.5, 30.0], [4.4, 51.9]]]);
const DETOUR = route('TWKHH', 'NLRTM', 25943.2, 133, [[[120.3, 22.6], [18.4, -34.4], [4.4, 51.9]]]);

const BOX: DrawnBox = {
  id: 'box-1',
  rects: [{ swLon: 42, swLat: 11, neLon: 45, neLat: 14 }],
  lonSpanDeg: 3,
  crossesAntimeridian: false,
};

function evaluationWith(overrides: Partial<Evaluation>): Evaluation {
  const scenario = defaultScenario(catalog);
  return {
    key: scenarioKey(scenario),
    epoch: 1,
    scenario,
    hero: BASELINE,
    heroBaseline: BASELINE,
    golden: [{ route: catalog.goldenRoutes[0]!, current: BASELINE, baseline: BASELINE }],
    isolation: { referenceHubCode: 'NLRTM', fallbackUsed: false, totalPorts: 758, isolatedCount: 0, ports: [] },
    tradeExposure: [],
    boxMatches: [],
    queries: [],
    elapsedMs: 1,
    ...overrides,
  };
}

describe('scenario state transitions', () => {
  it('starts from the catalog default blockade (Northwest Passage closed) with Kaohsiung → Rotterdam as hero', () => {
    expect(defaultScenario(catalog)).toEqual({ blocked: ['northwest'], boxes: [], hero: { from: 'TWKHH', to: 'NLRTM' } });
  });

  it('presets add their passages on top of the default blockade, clear boxes and pick their hero route', () => {
    const withBox = addBox(defaultScenario(catalog), BOX);
    expect(withBox.boxes).toHaveLength(1);
    expect(presetScenario(catalog, 'suez-babalmandab')).toEqual({
      blocked: ['babalmandab', 'northwest', 'suez'],
      boxes: [],
      hero: { from: 'TWKHH', to: 'NLRTM' },
    });
    expect(presetScenario(catalog, 'hormuz').hero).toEqual({ from: 'AEJEA', to: 'ITGOA' });
    expect(presetScenario(catalog, 'gibraltar-suez').blocked).toEqual(['gibraltar', 'northwest', 'suez']);
  });

  it('recognises the active preset only while the blockade matches it exactly', () => {
    const suez = presetScenario(catalog, 'suez-babalmandab');
    expect(activePresetId(catalog, suez)).toBe('suez-babalmandab');
    expect(activePresetId(catalog, togglePassage(suez, 'malacca'))).toBeNull();
    expect(activePresetId(catalog, addBox(suez, BOX))).toBeNull();
    expect(activePresetId(catalog, defaultScenario(catalog))).toBeNull();
  });

  it('toggles and chip removal open or close one passage at a time, Northwest Passage included', () => {
    const start = defaultScenario(catalog);
    const closed = togglePassage(start, 'suez');
    expect(closed.blocked).toEqual(['northwest', 'suez']);
    expect(togglePassage(closed, 'suez').blocked).toEqual(['northwest']);
    expect(unblockPassage(closed, 'northwest').blocked).toEqual(['suez']);
  });

  it('Reset All returns to the default blockade, drops every box and keeps the chosen hero', () => {
    const messy = withHero(addBox(togglePassage(presetScenario(catalog, 'hormuz'), 'panama'), BOX), { from: 'CNSHA', to: 'USLAX' });
    expect(resetBlockades(catalog, messy)).toEqual({ blocked: ['northwest'], boxes: [], hero: { from: 'CNSHA', to: 'USLAX' } });
    expect(removeBox(addBox(defaultScenario(catalog), BOX), 'box-1').boxes).toEqual([]);
  });

  it('scenario keys differ whenever the blockade, the boxes or the hero differ', () => {
    const base = defaultScenario(catalog);
    const keys = new Set([
      scenarioKey(base),
      scenarioKey(togglePassage(base, 'suez')),
      scenarioKey(addBox(base, BOX)),
      scenarioKey(withHero(base, { from: 'SGSIN', to: 'NLRTM' })),
    ]);
    expect(keys.size).toBe(4);
    expect(scenarioKey(defaultScenario(catalog))).toBe(scenarioKey(base));
  });
});

describe('route deltas and formatting', () => {
  it('reports the Cape detour as +6,061.1 km, +30.5% and +7 hops', () => {
    const delta = compareRoutes(BASELINE, DETOUR);
    expect(delta).toEqual({ status: 'rerouted', deltaKm: 6061.1, deltaPct: 30.5, deltaHops: 7 });
    expect(formatSignedKm(6061.1)).toBe('+6,061.1 km');
    expect(formatSignedPct(30.5)).toBe('+30.5%');
    expect(formatSignedKm(-307.7)).toBe('−307.7 km');
  });

  it('distinguishes unchanged, isolated and baseline-less routes', () => {
    expect(compareRoutes(BASELINE, BASELINE).status).toBe('unchanged');
    expect(compareRoutes(BASELINE, route('TWKHH', 'NLRTM', null, null))).toEqual({ status: 'isolated', deltaKm: null, deltaPct: null, deltaHops: null });
    expect(compareRoutes(null, DETOUR).status).toBe('unknown');
  });

  it('a box has detour impact only when a tracked route lengthens or is cut, or more ports are isolated', () => {
    const before = evaluationWith({});
    expect(hasDetourImpact(before, evaluationWith({}))).toBe(false);
    expect(hasDetourImpact(before, evaluationWith({ hero: DETOUR }))).toBe(true);
    expect(hasDetourImpact(before, evaluationWith({ hero: route('TWKHH', 'NLRTM', null, null) }))).toBe(true);
    expect(hasDetourImpact(before, evaluationWith({ isolation: { ...before.isolation, isolatedCount: 2 } }))).toBe(true);
    const shorter = route('TWKHH', 'NLRTM', 19574.4, 127);
    expect(hasDetourImpact(before, evaluationWith({ hero: shorter }))).toBe(false);
  });
});

describe('lists, search and write detection', () => {
  const ports: PortRecord[] = [
    { code: 'NLRTM', name: 'Rotterdam', country: 'Netherlands', lon: 4.4, lat: 51.9, snapWpId: 'a', snapDistKm: 0, wpDistKm: 0, tradeDegree: 79, rank: 1, isCuratedHub: true },
    { code: 'VCKTN', name: 'Kingstown', country: 'Saint Vincent and the Grenadines', lon: -61.2, lat: 13.2, snapWpId: 'b', snapDistKm: 0, wpDistKm: 0, tradeDegree: 3, rank: 600, isCuratedHub: false },
    { code: 'AEJEA', name: 'Jebel Ali', country: 'United Arab Emirates', lon: 55, lat: 25, snapWpId: 'c', snapDistKm: 0, wpDistKm: 0, tradeDegree: 50, rank: 9, isCuratedHub: true },
    { code: 'AEAUH', name: 'Abu Dhabi', country: 'United Arab Emirates', lon: 54.4, lat: 24.5, snapWpId: 'd', snapDistKm: 0, wpDistKm: 0, tradeDegree: 20, rank: 40, isCuratedHub: false },
  ];

  it('finds ports by code, by name and by country name', () => {
    expect(searchPorts(ports, 'nlrtm').map((p) => p.code)).toEqual(['NLRTM']);
    expect(searchPorts(ports, 'king').map((p) => p.code)).toEqual(['VCKTN']);
    expect(searchPorts(ports, 'saint vincent').map((p) => p.code)).toEqual(['VCKTN']);
    expect(searchPorts(ports, 'emirates').map((p) => p.code)).toEqual(['AEJEA', 'AEAUH']);
    expect(searchPorts(ports, '   ')).toEqual([]);
  });

  it('orders isolated ports by trade links, busiest hub first', () => {
    const sorted = sortIsolatedPorts([
      { code: 'B', name: 'B', country: 'X', lon: 0, lat: 0, rank: 5, tradeDegree: 3 },
      { code: 'A', name: 'A', country: 'X', lon: 0, lat: 0, rank: 9, tradeDegree: 34 },
      { code: 'C', name: 'C', country: 'X', lon: 0, lat: 0, rank: 2, tradeDegree: 3 },
    ]);
    expect(sorted.map((p) => p.code)).toEqual(['A', 'C', 'B']);
  });

  it('counts only real graph writes in the envelope stats', () => {
    const readStats = { nodes_created: 0, relationships_deleted: 0, properties_set: 0 };
    expect(countGraphWrites(readStats)).toBe(0);
    expect(countGraphWrites({ ...readStats, relationships_deleted: 5 })).toBe(5);
    expect(countGraphWrites({ ...readStats, nodes_created: 1, labels_added: 1 })).toBe(2);
  });

  it('accepts empty or object params and rejects arrays or broken JSON with a readable error', () => {
    expect(parseParamsText('  ')).toEqual({ ok: true, params: null });
    expect(parseParamsText('{"from": "TWKHH"}')).toEqual({ ok: true, params: { from: 'TWKHH' } });
    expect(parseParamsText('[1]')).toEqual({ ok: false, error: 'Params must be a JSON object such as {"from": "TWKHH"}' });
    const broken = parseParamsText('{from:');
    expect(broken.ok).toBe(false);
  });

  it('builds a read-only CLI replay with JSON-encoded params and a shell-safe query', () => {
    const command = buildCliReadOnlyCommand("MATCH (p:Port) WHERE p.name = 'X' RETURN p", { from: 'TWKHH', codes: ['A', 'B'] });
    expect(command).toBe(
      [
        'relate query',
        '--database data/chokepoint.rl',
        '--read-only',
        `--param 'from="TWKHH"'`,
        `--param 'codes=["A","B"]'`,
        `-c 'MATCH (p:Port) WHERE p.name = '\\''X'\\'' RETURN p'`,
      ].join(' \\\n  '),
    );
  });
});

describe('map layers', () => {
  it('Tier 3 draws the dashed baseline plus the solid detour for a rerouted hero, only one line otherwise', () => {
    const rerouted = heroRouteCollection(evaluationWith({ hero: DETOUR }));
    expect(rerouted.features.map((f) => f.properties?.role)).toEqual(['baseline', 'detour']);
    const unchanged = heroRouteCollection(evaluationWith({}));
    expect(unchanged.features.map((f) => f.properties?.role)).toEqual(['current']);
    expect(heroRouteCollection(null).features).toEqual([]);
  });

  it('Tier 2 overlays the golden routes except the one already drawn as hero', () => {
    const evaluation = evaluationWith({
      golden: catalog.goldenRoutes.slice(0, 2).map((g, i) => ({
        route: g,
        current: route(g.from, g.to, 100 + i, 10, [[[0, 0], [1, 1]]]),
        baseline: route(g.from, g.to, 100, 10),
      })),
    });
    const golden = goldenRouteCollection(evaluation);
    expect(golden.features.map((f) => f.properties)).toEqual([{ id: 'sgsin-nlrtm', status: 'rerouted' }]);
  });

  it('splits antimeridian boxes into two polygons and fits Pacific routes without spanning the globe', () => {
    const pacificBox: DrawnBox = {
      id: 'box-2',
      rects: [
        { swLon: 175, swLat: 25, neLon: 180, neLat: 62 },
        { swLon: -180, swLat: 25, neLon: -175, neLat: 62 },
      ],
      lonSpanDeg: 10,
      crossesAntimeridian: true,
    };
    expect(boxCollection([pacificBox], null).features).toHaveLength(2);
    expect(boxCollection([], BOX).features[0]?.properties).toEqual({ id: 'box-1', state: 'pending' });
    const bounds = routeBounds([[[121.5, 31.2], [180, 45]], [[-180, 45], [-118.2, 33.7]]]);
    expect(bounds).toEqual([[121.5, 31.2], [241.8, 45]]);
    expect(routeBounds([[[4.4, 51.9], [120.3, 22.6]]])).toEqual([[4.4, 22.6], [120.3, 51.9]]);
  });

  it('collects severed lane ids once even when boxes overlap', () => {
    const evaluation = evaluationWith({
      boxMatches: [
        { boxId: 'a', matchedEdgeIds: ['e_1', 'e_2'], truncated: false },
        { boxId: 'b', matchedEdgeIds: ['e_2', 'e_3'], truncated: false },
      ],
    });
    expect(severedEdgeIds(evaluation)).toEqual(['e_1', 'e_2', 'e_3']);
  });
});

describe('copy that must match the brief', () => {
  it('uses the engine-verified counts and never the retired 52 / 25 / 450 estimates', () => {
    expect(PRESET_CARDS.map((c) => [c.title, c.isolatedCount, c.detail])).toEqual([
      ['Suez + Bab el-Mandeb', 9, '+6,061 km Cape detour'],
      ['Strait of Hormuz', 20, 'Persian Gulf cut-off'],
      ['Gibraltar + Suez', 103, 'Mediterranean lock-in'],
    ]);
    const copy = JSON.stringify(PRESET_CARDS);
    expect(/\b(52|25|450)\b/.test(copy)).toBe(false);
    // Positive control for the matcher above.
    expect(/\b(52|25|450)\b/.test('Strait of Hormuz 52 isolated')).toBe(true);
    expect(PRESET_CARDS.map((c) => c.title)).toEqual(catalog.presets.map((p) => p.name));
  });

  it('states the loading phase and the BFS approximation exactly as specified', () => {
    expect(LOADING_MESSAGE).toBe('Loading Relate WASM v1.1.0 in Dedicated Worker (:memory:)...');
    expect(BFS_APPROXIMATION_NOTE).toBe('~250 km topological equidistant BFS approximation (100% pure Relate v1.1.0)');
  });
});
