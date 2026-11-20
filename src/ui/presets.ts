export interface PresetCard {
  readonly presetId: string;
  readonly title: string;
  readonly isolatedCount: number;
  readonly detail: string;
}

/**
 * Button copy is static so it renders before the worker boots. Every number here is
 * re-derived from the real Relate engine in tests/workbench-engine.test.ts; the older
 * 52 / 25 / 450 estimates were wrong and must never come back.
 */
export const PRESET_CARDS: readonly PresetCard[] = [
  {
    presetId: 'suez-babalmandab',
    title: 'Suez + Bab el-Mandeb',
    isolatedCount: 9,
    detail: '+6,061 km Cape detour',
  },
  {
    presetId: 'hormuz',
    title: 'Strait of Hormuz',
    isolatedCount: 20,
    detail: 'Persian Gulf cut-off',
  },
  {
    presetId: 'gibraltar-suez',
    title: 'Gibraltar + Suez',
    isolatedCount: 103,
    detail: 'Mediterranean lock-in',
  },
];

export const RELATE_VERSION = '1.1.0';
export const BFS_APPROXIMATION_NOTE =
  '~250 km topological equidistant BFS approximation (100% pure Relate v1.1.0)';
export const LOADING_MESSAGE = `Loading Relate WASM v${RELATE_VERSION} in Dedicated Worker (:memory:)...`;
