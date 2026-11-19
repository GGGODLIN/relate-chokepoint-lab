import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CatalogValidationError,
  getBundledCatalog,
  getDefaultBlockedPassageIds,
  getOpenRelTypes,
  validateCatalog,
  type ChokepointCatalog,
} from '../src/contracts/catalog.js';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const rawCatalog = JSON.parse(
  readFileSync(resolve(ROOT_DIR, 'contracts/chokepoint-catalog.json'), 'utf8'),
) as ChokepointCatalog;
const rawMarnetGeoJson = JSON.parse(
  readFileSync(resolve(ROOT_DIR, 'data/raw/marnet_searoute.geojson'), 'utf8'),
) as { type: string; features: Array<{ type: string; properties?: Record<string, unknown> | null }> };
const rawPortsGeoJson = JSON.parse(
  readFileSync(resolve(ROOT_DIR, 'data/raw/ports.geojson'), 'utf8'),
) as { type: string; features: Array<{ type: string; properties?: Record<string, unknown> | null }> };

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('chokepoint-catalog contract against pinned real GeoJSON inputs', () => {
  it('achieves exact 1-to-1 bijection across all 13 raw marnet passage tags and verifies ports', () => {
    const result = validateCatalog(rawCatalog, {
      marnetGeoJson: rawMarnetGeoJson,
      portsGeoJson: rawPortsGeoJson,
    });

    expect(result.passageIds).toEqual([
      'babalmandab',
      'bering',
      'bosporus',
      'chili',
      'dardanelles',
      'gibraltar',
      'malacca',
      'northwest',
      'ormuz',
      'panama',
      'south_africa',
      'suez',
      'sunda',
    ]);
    expect(result.staticRelTypes).toHaveLength(14);
    expect(result.staticRelTypes[0]).toBe('SEA_OPEN');
    expect(result.defaultBlockedPassageIds).toEqual(['northwest']);
    expect(result.marnetPassageCounts).toEqual({
      babalmandab: 1,
      bering: 3,
      bosporus: 1,
      chili: 3,
      dardanelles: 1,
      gibraltar: 1,
      malacca: 1,
      northwest: 4,
      ormuz: 1,
      panama: 1,
      south_africa: 5,
      suez: 1,
      sunda: 1,
    });
  });

  it('maps formal display names, 3 headline presets, and 5 golden O-D routes', () => {
    const catalog = getBundledCatalog();

    const byId = Object.fromEntries(catalog.passages.map((p) => [p.id, p]));
    expect(byId.ormuz).toMatchObject({
      name: 'Strait of Hormuz',
      relType: 'PASSAGE_ORMUZ',
      defaultBlocked: false,
    });
    expect(byId.babalmandab).toMatchObject({
      name: 'Bab el-Mandeb',
      relType: 'PASSAGE_BABALMANDAB',
      defaultBlocked: false,
    });
    expect(byId.northwest).toMatchObject({
      name: 'Northwest Passage',
      relType: 'PASSAGE_NORTHWEST',
      defaultBlocked: true,
    });
    expect(byId.south_africa).toMatchObject({
      name: 'Cape of Good Hope',
      relType: 'PASSAGE_SOUTH_AFRICA',
      defaultBlocked: false,
    });

    expect(getDefaultBlockedPassageIds(catalog)).toEqual(['northwest']);

    expect(catalog.presets.map((p) => ({ name: p.name, blocked: p.blockedPassages }))).toEqual([
      { name: 'Suez + Bab el-Mandeb', blocked: ['suez', 'babalmandab'] },
      { name: 'Strait of Hormuz', blocked: ['ormuz'] },
      { name: 'Gibraltar + Suez', blocked: ['gibraltar', 'suez'] },
    ]);

    expect(catalog.goldenRoutes.map((r) => `${r.from}->${r.to}`)).toEqual([
      'TWKHH->NLRTM',
      'SGSIN->NLRTM',
      'AEJEA->ITGOA',
      'CNSHA->USLAX',
      'CNSHA->USNYC',
    ]);
  });

  it('computes open static relationship types and rejects unknown blocked passage IDs', () => {
    const catalog = getBundledCatalog();

    const openWithDefaultBlocked = getOpenRelTypes(catalog, ['northwest', 'suez', 'babalmandab']);
    expect(openWithDefaultBlocked).toHaveLength(11);
    expect(openWithDefaultBlocked).toContain('SEA_OPEN');
    expect(openWithDefaultBlocked).toContain('PASSAGE_SOUTH_AFRICA');
    expect(openWithDefaultBlocked).not.toContain('PASSAGE_NORTHWEST');
    expect(openWithDefaultBlocked).not.toContain('PASSAGE_SUEZ');
    expect(openWithDefaultBlocked).not.toContain('PASSAGE_BABALMANDAB');

    expect(() => getOpenRelTypes(catalog, ['atlantis'])).toThrow(CatalogValidationError);
  });

  it('fails closed when marnet GeoJSON introduces an unknown passage tag', () => {
    const baseline = validateCatalog(rawCatalog, { marnetGeoJson: rawMarnetGeoJson });
    expect(baseline.passageIds).toHaveLength(13);

    const mutatedMarnet = {
      type: 'FeatureCollection',
      features: [
        ...rawMarnetGeoJson.features,
        { type: 'Feature', properties: { passage: 'kiel_canal' } },
      ],
    };

    expect(() => validateCatalog(rawCatalog, { marnetGeoJson: mutatedMarnet })).toThrowError(
      /kiel_canal/,
    );
  });

  it('fails closed when a catalog passage ID is missing from marnet GeoJSON', () => {
    const baseline = validateCatalog(rawCatalog, { marnetGeoJson: rawMarnetGeoJson });
    expect(baseline.marnetPassageCounts?.sunda).toBe(1);

    const withoutSunda = {
      type: 'FeatureCollection',
      features: rawMarnetGeoJson.features.filter((f) => f.properties?.passage !== 'sunda'),
    };

    expect(() => validateCatalog(rawCatalog, { marnetGeoJson: withoutSunda })).toThrowError(
      /sunda/,
    );
  });

  it('fails closed on duplicate passage IDs, unknown preset passage, or northwest unblocked', () => {
    // Positive control on cloned catalog
    expect(validateCatalog(cloneJson(rawCatalog)).passageIds).toHaveLength(13);

    const withDuplicate = cloneJson(rawCatalog);
    (withDuplicate.passages as unknown[]).push(cloneJson(withDuplicate.passages[0]));
    expect(() => validateCatalog(withDuplicate)).toThrowError(/duplicate passage id/);

    const withUnknownPresetPassage = cloneJson(rawCatalog);
    const firstPreset = withUnknownPresetPassage.presets[0];
    if (firstPreset) {
      Object.assign(firstPreset, { blockedPassages: ['suez', 'nonexistent_strait'] });
    }
    expect(() => validateCatalog(withUnknownPresetPassage)).toThrowError(/nonexistent_strait/);

    const withUnblockedNorthwest = cloneJson(rawCatalog);
    const nw = withUnblockedNorthwest.passages.find((p) => p.id === 'northwest');
    if (nw) {
      Object.assign(nw, { defaultBlocked: false });
    }
    expect(() => validateCatalog(withUnblockedNorthwest)).toThrowError(/northwest/);
  });

  it('fails closed on malformed GeoJSON and inland/missing golden route ports', () => {
    // Positive control
    expect(validateCatalog(rawCatalog, { portsGeoJson: rawPortsGeoJson }).passageIds).toHaveLength(
      13,
    );

    expect(() =>
      validateCatalog(rawCatalog, { marnetGeoJson: { type: 'FeatureCollection', features: [] } }),
    ).toThrow(CatalogValidationError);

    expect(() =>
      validateCatalog(rawCatalog, {
        marnetGeoJson: {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', properties: { passage: 42 } }],
        },
      }),
    ).toThrow(CatalogValidationError);

    const portsWithoutTwkhh = {
      type: 'FeatureCollection',
      features: rawPortsGeoJson.features.filter((f) => f.properties?.port !== 'TWKHH'),
    };
    expect(() => validateCatalog(rawCatalog, { portsGeoJson: portsWithoutTwkhh })).toThrowError(
      /TWKHH/,
    );
  });
});
