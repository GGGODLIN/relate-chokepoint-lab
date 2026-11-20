import {
  getDefaultBlockedPassageIds,
  type ChokepointCatalog,
  type GoldenRoute,
} from '../contracts/catalog.ts';
import type { BBoxRect } from '../engine/bbox.ts';
import type {
  IsolatedPortRecord,
  PortRecord,
  RouteEvaluationResult,
  TradeExposureRecord,
} from '../engine/chokepoint-engine.ts';
import type { QueryTelemetry, RelateEnvelopeStats } from '../engine/envelope.ts';

export interface OdPair {
  readonly from: string;
  readonly to: string;
}

export interface DrawnBox {
  readonly id: string;
  readonly rects: readonly BBoxRect[];
  readonly lonSpanDeg: number;
  readonly crossesAntimeridian: boolean;
}

/** The what-if inputs the user asked for; every number on screen must be derived from exactly one of these. */
export interface Scenario {
  readonly blocked: readonly string[];
  readonly boxes: readonly DrawnBox[];
  readonly hero: OdPair;
}

export type LonLatTuple = readonly [number, number];

export interface RouteSummary {
  readonly from: string;
  readonly to: string;
  readonly hops: number | null;
  readonly totalKm: number | null;
  readonly isolated: boolean;
  readonly segments: readonly (readonly LonLatTuple[])[];
  readonly passages: readonly string[];
}

export type RouteStatus = 'unchanged' | 'rerouted' | 'isolated' | 'unknown';

export interface RouteDelta {
  readonly status: RouteStatus;
  readonly deltaKm: number | null;
  readonly deltaPct: number | null;
  readonly deltaHops: number | null;
}

export interface QueryRecord {
  readonly id: string;
  readonly label: string;
  readonly cypher: string;
  readonly params: Readonly<Record<string, unknown>> | null;
  readonly telemetry: QueryTelemetry | null;
  readonly rowCount: number | null;
}

export interface BoxMatch {
  readonly boxId: string;
  readonly matchedEdgeIds: readonly string[];
  readonly truncated: boolean;
}

export interface GoldenRouteResult {
  readonly route: GoldenRoute;
  readonly current: RouteSummary;
  readonly baseline: RouteSummary | null;
}

export interface IsolationSummary {
  readonly referenceHubCode: string;
  readonly fallbackUsed: boolean;
  readonly totalPorts: number;
  readonly isolatedCount: number;
  readonly ports: readonly IsolatedPortRecord[];
}

export interface Evaluation {
  readonly key: string;
  readonly epoch: number;
  readonly scenario: Scenario;
  readonly hero: RouteSummary;
  readonly heroBaseline: RouteSummary | null;
  readonly golden: readonly GoldenRouteResult[];
  readonly isolation: IsolationSummary;
  readonly tradeExposure: readonly TradeExposureRecord[];
  readonly boxMatches: readonly BoxMatch[];
  readonly queries: readonly QueryRecord[];
  readonly elapsedMs: number;
}

const WRITE_STAT_KEYS = [
  'nodes_created',
  'nodes_deleted',
  'relationships_created',
  'relationships_deleted',
  'properties_set',
  'labels_added',
  'labels_removed',
  'indexes_added',
  'indexes_removed',
  'constraints_added',
  'constraints_removed',
] as const;

export function normalizeBlocked(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

export function odKey(od: OdPair): string {
  return `${od.from}->${od.to}`;
}

export function boxesKey(boxes: readonly DrawnBox[]): string {
  return JSON.stringify(boxes.map((box) => [box.id, box.rects]));
}

export function scenarioKey(scenario: Scenario): string {
  return JSON.stringify([scenario.blocked, boxesKey(scenario.boxes), odKey(scenario.hero)]);
}

function firstGoldenRoute(catalog: ChokepointCatalog): GoldenRoute {
  const first = catalog.goldenRoutes[0];
  if (first === undefined) {
    throw new Error('Catalog defines no golden routes');
  }
  return first;
}

export function defaultScenario(catalog: ChokepointCatalog): Scenario {
  const hero = firstGoldenRoute(catalog);
  return {
    blocked: normalizeBlocked(getDefaultBlockedPassageIds(catalog)),
    boxes: [],
    hero: { from: hero.from, to: hero.to },
  };
}

export function presetScenario(catalog: ChokepointCatalog, presetId: string): Scenario {
  const preset = catalog.presets.find((p) => p.id === presetId);
  if (preset === undefined) {
    throw new Error(`Unknown scenario preset "${presetId}"`);
  }
  const hero =
    catalog.goldenRoutes.find((route) => route.id === preset.heroRouteId) ??
    firstGoldenRoute(catalog);
  // Presets always start from the default blockade (Northwest Passage closed) so the
  // headline isolated counts match the build receipt that was computed the same way.
  return {
    blocked: normalizeBlocked([
      ...getDefaultBlockedPassageIds(catalog),
      ...preset.blockedPassages,
    ]),
    boxes: [],
    hero: { from: hero.from, to: hero.to },
  };
}

export function activePresetId(catalog: ChokepointCatalog, scenario: Scenario): string | null {
  if (scenario.boxes.length > 0) {
    return null;
  }
  const current = scenario.blocked.join('|');
  for (const preset of catalog.presets) {
    const expected = presetScenario(catalog, preset.id).blocked.join('|');
    if (expected === current) {
      return preset.id;
    }
  }
  return null;
}

export function togglePassage(scenario: Scenario, passageId: string): Scenario {
  const blocked = scenario.blocked.includes(passageId)
    ? scenario.blocked.filter((id) => id !== passageId)
    : normalizeBlocked([...scenario.blocked, passageId]);
  return { ...scenario, blocked };
}

export function unblockPassage(scenario: Scenario, passageId: string): Scenario {
  return { ...scenario, blocked: scenario.blocked.filter((id) => id !== passageId) };
}

export function addBox(scenario: Scenario, box: DrawnBox): Scenario {
  return { ...scenario, boxes: [...scenario.boxes, box] };
}

export function removeBox(scenario: Scenario, boxId: string): Scenario {
  return { ...scenario, boxes: scenario.boxes.filter((box) => box.id !== boxId) };
}

export function resetBlockades(catalog: ChokepointCatalog, scenario: Scenario): Scenario {
  return {
    blocked: normalizeBlocked(getDefaultBlockedPassageIds(catalog)),
    boxes: [],
    hero: scenario.hero,
  };
}

export function withHero(scenario: Scenario, hero: OdPair): Scenario {
  return { ...scenario, hero: { from: hero.from, to: hero.to } };
}

export function summarizeRoute(result: RouteEvaluationResult): RouteSummary {
  return {
    from: result.fromCode,
    to: result.toCode,
    hops: result.hops,
    totalKm: result.totalKm,
    isolated: result.isolated,
    segments: result.segments,
    passages: result.passagesTraversed,
  };
}

function roundTenth(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function compareRoutes(baseline: RouteSummary | null, current: RouteSummary): RouteDelta {
  if (current.isolated) {
    return { status: 'isolated', deltaKm: null, deltaPct: null, deltaHops: null };
  }
  if (baseline === null || baseline.totalKm === null || current.totalKm === null) {
    return { status: 'unknown', deltaKm: null, deltaPct: null, deltaHops: null };
  }
  const deltaKm = roundTenth(current.totalKm - baseline.totalKm);
  const deltaPct = baseline.totalKm > 0 ? roundTenth((deltaKm / baseline.totalKm) * 100) : null;
  const deltaHops =
    baseline.hops !== null && current.hops !== null ? current.hops - baseline.hops : null;
  return {
    status: deltaKm === 0 ? 'unchanged' : 'rerouted',
    deltaKm,
    deltaPct,
    deltaHops,
  };
}

/** True when the candidate evaluation lengthens or cuts any tracked route, or isolates more ports. */
export function hasDetourImpact(before: Evaluation, after: Evaluation): boolean {
  if (after.isolation.isolatedCount > before.isolation.isolatedCount) {
    return true;
  }
  const pairs: [RouteSummary, RouteSummary][] = [[before.hero, after.hero]];
  const previousById = new Map(before.golden.map((g) => [g.route.id, g]));
  for (const next of after.golden) {
    const prev = previousById.get(next.route.id);
    if (prev !== undefined) {
      pairs.push([prev.current, next.current]);
    }
  }
  return pairs.some(([prev, next]) => {
    if (next.isolated && !prev.isolated) {
      return true;
    }
    if (prev.totalKm === null || next.totalKm === null) {
      return false;
    }
    return roundTenth(next.totalKm - prev.totalKm) > 0;
  });
}

const KM_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const INT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatKm(km: number): string {
  return `${KM_FORMAT.format(km)} km`;
}

export function formatInt(value: number): string {
  return INT_FORMAT.format(value);
}

function signOf(value: number): string {
  return value > 0 ? '+' : value < 0 ? '−' : '±';
}

export function formatSignedKm(deltaKm: number): string {
  return `${signOf(deltaKm)}${KM_FORMAT.format(Math.abs(deltaKm))} km`;
}

export function formatSignedPct(deltaPct: number): string {
  return `${signOf(deltaPct)}${KM_FORMAT.format(Math.abs(deltaPct))}%`;
}

export function formatSignedInt(delta: number): string {
  return `${signOf(delta)}${INT_FORMAT.format(Math.abs(delta))}`;
}

export function formatMs(ms: number | null): string {
  if (ms === null) {
    return '—';
  }
  return `${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms`;
}

export function countGraphWrites(stats: RelateEnvelopeStats): number {
  let total = 0;
  for (const key of WRITE_STAT_KEYS) {
    const value = stats[key];
    if (typeof value === 'number' && value > 0) {
      total += value;
    }
  }
  return total;
}

export function sortIsolatedPorts(ports: readonly IsolatedPortRecord[]): IsolatedPortRecord[] {
  return [...ports].sort(
    (a, b) => b.tradeDegree - a.tradeDegree || a.rank - b.rank || a.code.localeCompare(b.code),
  );
}

export function sortTradeExposure(rows: readonly TradeExposureRecord[]): TradeExposureRecord[] {
  return [...rows].sort(
    (a, b) => b.exposedPorts - a.exposedPorts || a.countryName.localeCompare(b.countryName),
  );
}

function portMatchScore(port: PortRecord, needle: string): number | null {
  const code = port.code.toLowerCase();
  const name = port.name.toLowerCase();
  const country = port.country.toLowerCase();
  if (code === needle) return 0;
  if (code.startsWith(needle)) return 1;
  if (name.startsWith(needle)) return 2;
  if (name.includes(needle)) return 3;
  if (country.startsWith(needle)) return 4;
  if (country.includes(needle)) return 5;
  return null;
}

export function searchPorts(
  ports: readonly PortRecord[],
  query: string,
  limit = 8,
): PortRecord[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const scored: { port: PortRecord; score: number }[] = [];
  for (const port of ports) {
    const score = portMatchScore(port, needle);
    if (score !== null) {
      scored.push({ port, score });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.port.rank - b.port.rank);
  return scored.slice(0, limit).map((entry) => entry.port);
}

export type ParamsParseResult =
  | { readonly ok: true; readonly params: Readonly<Record<string, unknown>> | null }
  | { readonly ok: false; readonly error: string };

export function parseParamsText(text: string): ParamsParseResult {
  if (text.trim().length === 0) {
    return { ok: true, params: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: unknown) {
    return { ok: false, error: `Params are not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Params must be a JSON object such as {"from": "TWKHH"}' };
  }
  return { ok: true, params: parsed as Record<string, unknown> };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const GOLDEN_RL_PATH = 'data/chokepoint.rl';

/** Read-only replay of a browser query against the golden `.rl` with the native CLI. */
export function buildCliReadOnlyCommand(
  cypher: string,
  params: Readonly<Record<string, unknown>> | null,
): string {
  const parts = ['relate query', `--database ${GOLDEN_RL_PATH}`, '--read-only'];
  for (const [name, value] of Object.entries(params ?? {})) {
    // --param parses V as JSON, so encoding every value keeps strings, numbers and lists exact.
    parts.push(`--param ${shellQuote(`${name}=${JSON.stringify(value)}`)}`);
  }
  parts.push(`-c ${shellQuote(cypher)}`);
  return parts.join(' \\\n  ');
}
