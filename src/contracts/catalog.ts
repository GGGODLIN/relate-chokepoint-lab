import rawCatalogJson from '../../contracts/chokepoint-catalog.json' with { type: 'json' };

export interface PassageEntry {
  readonly id: string;
  readonly name: string;
  readonly relType: string;
  readonly region: string;
  readonly defaultBlocked: boolean;
  readonly focusLon: number;
  readonly focusLat: number;
}

export interface ScenarioPreset {
  readonly id: string;
  readonly name: string;
  readonly blockedPassages: readonly string[];
  readonly heroRouteId: string;
  readonly description: string;
}

export interface CuratedHubPort {
  readonly code: string;
  readonly name: string;
  readonly region: string;
}

export interface GoldenRoute {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface ChokepointCatalog {
  readonly schemaVersion: number;
  readonly openSeaRelType: string;
  readonly referenceHubCode: string;
  readonly fallbackReferenceHubCode: string;
  readonly passages: readonly PassageEntry[];
  readonly presets: readonly ScenarioPreset[];
  readonly curatedHubPorts: readonly CuratedHubPort[];
  readonly goldenRoutes: readonly GoldenRoute[];
}

export interface GeoJsonFeature {
  readonly type: string;
  readonly properties?: Record<string, unknown> | null;
  readonly geometry?: {
    readonly type?: string;
    readonly coordinates?: unknown;
  } | null;
}

export interface GeoJsonFeatureCollection {
  readonly type: string;
  readonly features: readonly GeoJsonFeature[];
}

export interface CatalogValidationOptions {
  readonly marnetGeoJson?: unknown;
  readonly portsGeoJson?: unknown;
}

export interface CatalogValidationResult {
  readonly catalog: ChokepointCatalog;
  readonly passageIds: readonly string[];
  readonly defaultBlockedPassageIds: readonly string[];
  readonly staticRelTypes: readonly string[];
  readonly marnetPassageCounts: Readonly<Record<string, number>> | null;
}

export class CatalogValidationError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`Catalog validation failed (${violations.length}): ${violations.join('; ')}`);
    this.name = 'CatalogValidationError';
    this.violations = violations;
  }
}

const PASSAGE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const REL_TYPE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const PORT_CODE_PATTERN = /^[A-Z0-9]{5}$/;

export function toPassageRelType(passageId: string): string {
  return `PASSAGE_${passageId.toUpperCase()}`;
}

export function getDefaultBlockedPassageIds(catalog: ChokepointCatalog): string[] {
  return catalog.passages
    .filter((entry) => entry.defaultBlocked)
    .map((entry) => entry.id);
}

export function getOpenRelTypes(
  catalog: ChokepointCatalog,
  blockedPassageIds: Iterable<string>,
): string[] {
  const knownIds = new Set(catalog.passages.map((p) => p.id));
  const blocked = new Set<string>();
  for (const id of blockedPassageIds) {
    if (!knownIds.has(id)) {
      throw new CatalogValidationError([`unknown blocked passage id: "${id}"`]);
    }
    blocked.add(id);
  }
  const relTypes = [catalog.openSeaRelType];
  for (const entry of catalog.passages) {
    if (!blocked.has(entry.id)) {
      relTypes.push(entry.relType);
    }
  }
  return relTypes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function extractMarnetPassageCounts(
  rawGeoJson: unknown,
  violations: string[],
): Record<string, number> | null {
  if (!isRecord(rawGeoJson) || rawGeoJson.type !== 'FeatureCollection' || !Array.isArray(rawGeoJson.features)) {
    violations.push('marnetGeoJson must be a GeoJSON FeatureCollection with a features array');
    return null;
  }
  if (rawGeoJson.features.length === 0) {
    violations.push('marnetGeoJson.features must not be empty');
    return null;
  }

  const counts: Record<string, number> = {};
  for (let i = 0; i < rawGeoJson.features.length; i++) {
    const feat: unknown = rawGeoJson.features[i];
    if (!isRecord(feat) || feat.type !== 'Feature') {
      violations.push(`marnetGeoJson.features[${i}] must be a GeoJSON Feature`);
      continue;
    }
    const props: unknown = feat.properties;
    if (props === undefined || props === null) {
      continue;
    }
    if (!isRecord(props)) {
      violations.push(`marnetGeoJson.features[${i}].properties must be an object or null`);
      continue;
    }
    const rawPassage: unknown = props.passage;
    if (rawPassage === undefined || rawPassage === null) {
      continue;
    }
    if (!isNonEmptyString(rawPassage)) {
      violations.push(`marnetGeoJson.features[${i}].properties.passage must be a non-empty string or null`);
      continue;
    }
    counts[rawPassage] = (counts[rawPassage] ?? 0) + 1;
  }

  return counts;
}

function extractValidSeaPortCodes(
  rawPortsGeoJson: unknown,
  violations: string[],
): Set<string> | null {
  if (!isRecord(rawPortsGeoJson) || rawPortsGeoJson.type !== 'FeatureCollection' || !Array.isArray(rawPortsGeoJson.features)) {
    violations.push('portsGeoJson must be a GeoJSON FeatureCollection with a features array');
    return null;
  }
  if (rawPortsGeoJson.features.length === 0) {
    violations.push('portsGeoJson.features must not be empty');
    return null;
  }

  const codes = new Set<string>();
  for (let i = 0; i < rawPortsGeoJson.features.length; i++) {
    const feat: unknown = rawPortsGeoJson.features[i];
    if (!isRecord(feat) || feat.type !== 'Feature') {
      violations.push(`portsGeoJson.features[${i}] must be a GeoJSON Feature`);
      continue;
    }
    const props: unknown = feat.properties;
    if (!isRecord(props)) {
      violations.push(`portsGeoJson.features[${i}].properties must be an object`);
      continue;
    }
    if (props.t === 1 && isNonEmptyString(props.port)) {
      codes.add(props.port);
    }
  }
  return codes;
}

export function validateCatalog(
  rawCatalog: unknown,
  options: CatalogValidationOptions = {},
): CatalogValidationResult {
  const violations: string[] = [];

  if (!isRecord(rawCatalog)) {
    throw new CatalogValidationError(['catalog must be a JSON object']);
  }

  if (rawCatalog.schemaVersion !== 1) {
    violations.push(`schemaVersion must be 1 (got ${JSON.stringify(rawCatalog.schemaVersion)})`);
  }

  if (!isNonEmptyString(rawCatalog.openSeaRelType) || !REL_TYPE_PATTERN.test(rawCatalog.openSeaRelType)) {
    violations.push('openSeaRelType must be an uppercase Cypher relationship type');
  }

  if (!isNonEmptyString(rawCatalog.referenceHubCode) || !PORT_CODE_PATTERN.test(rawCatalog.referenceHubCode)) {
    violations.push('referenceHubCode must be a 5-character UN/LOCODE');
  }

  if (!isNonEmptyString(rawCatalog.fallbackReferenceHubCode) || !PORT_CODE_PATTERN.test(rawCatalog.fallbackReferenceHubCode)) {
    violations.push('fallbackReferenceHubCode must be a 5-character UN/LOCODE');
  }

  const passageIds = new Set<string>();
  const passageRelTypes = new Set<string>();
  const defaultBlockedPassageIds: string[] = [];

  if (!Array.isArray(rawCatalog.passages) || rawCatalog.passages.length === 0) {
    violations.push('passages must be a non-empty array');
  } else {
    for (let i = 0; i < rawCatalog.passages.length; i++) {
      const entry = rawCatalog.passages[i];
      if (!isRecord(entry)) {
        violations.push(`passages[${i}] must be an object`);
        continue;
      }

      if (!isNonEmptyString(entry.id) || !PASSAGE_ID_PATTERN.test(entry.id)) {
        violations.push(`passages[${i}].id must match ${PASSAGE_ID_PATTERN.source}`);
      } else if (passageIds.has(entry.id)) {
        violations.push(`duplicate passage id: "${entry.id}"`);
      } else {
        passageIds.add(entry.id);
      }

      if (!isNonEmptyString(entry.name)) {
        violations.push(`passages[${i}].name must be a non-empty string`);
      }

      if (!isNonEmptyString(entry.region)) {
        violations.push(`passages[${i}].region must be a non-empty string`);
      }

      if (typeof entry.defaultBlocked !== 'boolean') {
        violations.push(`passages[${i}].defaultBlocked must be a boolean`);
      } else if (entry.defaultBlocked && isNonEmptyString(entry.id)) {
        defaultBlockedPassageIds.push(entry.id);
      }

      if (isNonEmptyString(entry.id)) {
        const expectedRelType = toPassageRelType(entry.id);
        if (entry.relType !== expectedRelType) {
          violations.push(
            `passages[${i}].relType must be "${expectedRelType}" (got ${JSON.stringify(entry.relType)})`,
          );
        } else if (passageRelTypes.has(entry.relType)) {
          violations.push(`duplicate passage relType: "${entry.relType}"`);
        } else {
          passageRelTypes.add(entry.relType);
        }
      }

      if (typeof entry.focusLon !== 'number' || !Number.isFinite(entry.focusLon) || entry.focusLon < -180 || entry.focusLon > 180) {
        violations.push(`passages[${i}].focusLon must be a finite longitude in [-180, 180]`);
      }

      if (typeof entry.focusLat !== 'number' || !Number.isFinite(entry.focusLat) || entry.focusLat < -90 || entry.focusLat > 90) {
        violations.push(`passages[${i}].focusLat must be a finite latitude in [-90, 90]`);
      }
    }
  }

  if (isNonEmptyString(rawCatalog.openSeaRelType) && passageRelTypes.has(rawCatalog.openSeaRelType)) {
    violations.push(`openSeaRelType "${rawCatalog.openSeaRelType}" collides with a passage relType`);
  }

  // Policy guard: northwest must stay default-blocked so commercial routes do not hijack via the Arctic.
  if (!defaultBlockedPassageIds.includes('northwest')) {
    violations.push('policy violation: passage "northwest" must have defaultBlocked === true');
  }

  const hubPortCodes = new Set<string>();
  if (!Array.isArray(rawCatalog.curatedHubPorts) || rawCatalog.curatedHubPorts.length === 0) {
    violations.push('curatedHubPorts must be a non-empty array');
  } else {
    for (let i = 0; i < rawCatalog.curatedHubPorts.length; i++) {
      const hub = rawCatalog.curatedHubPorts[i];
      if (!isRecord(hub)) {
        violations.push(`curatedHubPorts[${i}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(hub.code) || !PORT_CODE_PATTERN.test(hub.code)) {
        violations.push(`curatedHubPorts[${i}].code must be a 5-character UN/LOCODE`);
      } else if (hubPortCodes.has(hub.code)) {
        violations.push(`duplicate curatedHubPorts code: "${hub.code}"`);
      } else {
        hubPortCodes.add(hub.code);
      }
      if (!isNonEmptyString(hub.name)) {
        violations.push(`curatedHubPorts[${i}].name must be a non-empty string`);
      }
      if (!isNonEmptyString(hub.region)) {
        violations.push(`curatedHubPorts[${i}].region must be a non-empty string`);
      }
    }
  }

  if (isNonEmptyString(rawCatalog.referenceHubCode) && !hubPortCodes.has(rawCatalog.referenceHubCode)) {
    violations.push(`referenceHubCode "${rawCatalog.referenceHubCode}" must appear in curatedHubPorts`);
  }
  if (
    isNonEmptyString(rawCatalog.fallbackReferenceHubCode) &&
    !hubPortCodes.has(rawCatalog.fallbackReferenceHubCode)
  ) {
    violations.push(
      `fallbackReferenceHubCode "${rawCatalog.fallbackReferenceHubCode}" must appear in curatedHubPorts`,
    );
  }

  const goldenRouteIds = new Set<string>();
  const goldenPortCodes = new Set<string>();
  if (!Array.isArray(rawCatalog.goldenRoutes) || rawCatalog.goldenRoutes.length === 0) {
    violations.push('goldenRoutes must be a non-empty array');
  } else {
    for (let i = 0; i < rawCatalog.goldenRoutes.length; i++) {
      const route = rawCatalog.goldenRoutes[i];
      if (!isRecord(route)) {
        violations.push(`goldenRoutes[${i}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(route.id)) {
        violations.push(`goldenRoutes[${i}].id must be a non-empty string`);
      } else if (goldenRouteIds.has(route.id)) {
        violations.push(`duplicate goldenRoutes id: "${route.id}"`);
      } else {
        goldenRouteIds.add(route.id);
      }
      if (!isNonEmptyString(route.from) || !PORT_CODE_PATTERN.test(route.from)) {
        violations.push(`goldenRoutes[${i}].from must be a 5-character UN/LOCODE`);
      } else {
        goldenPortCodes.add(route.from);
      }
      if (!isNonEmptyString(route.to) || !PORT_CODE_PATTERN.test(route.to)) {
        violations.push(`goldenRoutes[${i}].to must be a 5-character UN/LOCODE`);
      } else {
        goldenPortCodes.add(route.to);
      }
      if (isNonEmptyString(route.from) && route.from === route.to) {
        violations.push(`goldenRoutes[${i}] origin and destination must differ`);
      }
      if (!isNonEmptyString(route.label)) {
        violations.push(`goldenRoutes[${i}].label must be a non-empty string`);
      }
    }
  }

  const presetIds = new Set<string>();
  if (!Array.isArray(rawCatalog.presets) || rawCatalog.presets.length === 0) {
    violations.push('presets must be a non-empty array');
  } else {
    for (let i = 0; i < rawCatalog.presets.length; i++) {
      const preset = rawCatalog.presets[i];
      if (!isRecord(preset)) {
        violations.push(`presets[${i}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(preset.id)) {
        violations.push(`presets[${i}].id must be a non-empty string`);
      } else if (presetIds.has(preset.id)) {
        violations.push(`duplicate preset id: "${preset.id}"`);
      } else {
        presetIds.add(preset.id);
      }
      if (!isNonEmptyString(preset.name)) {
        violations.push(`presets[${i}].name must be a non-empty string`);
      }
      if (!isNonEmptyString(preset.description)) {
        violations.push(`presets[${i}].description must be a non-empty string`);
      }
      if (!isNonEmptyString(preset.heroRouteId) || !goldenRouteIds.has(preset.heroRouteId)) {
        violations.push(`presets[${i}].heroRouteId must reference a defined goldenRoutes id`);
      }
      if (!Array.isArray(preset.blockedPassages) || preset.blockedPassages.length === 0) {
        violations.push(`presets[${i}].blockedPassages must be a non-empty array`);
      } else {
        const seenInPreset = new Set<string>();
        for (const blockedId of preset.blockedPassages) {
          if (!isNonEmptyString(blockedId) || !passageIds.has(blockedId)) {
            violations.push(`presets[${i}].blockedPassages contains unknown passage id: ${JSON.stringify(blockedId)}`);
          } else if (seenInPreset.has(blockedId)) {
            violations.push(`presets[${i}].blockedPassages contains duplicate passage id: "${blockedId}"`);
          } else {
            seenInPreset.add(blockedId);
          }
        }
      }
    }
  }

  let marnetPassageCounts: Record<string, number> | null = null;
  if (options.marnetGeoJson !== undefined) {
    marnetPassageCounts = extractMarnetPassageCounts(options.marnetGeoJson, violations);
    if (marnetPassageCounts !== null) {
      const rawPassageIds = new Set(Object.keys(marnetPassageCounts));
      for (const rawId of rawPassageIds) {
        if (!passageIds.has(rawId)) {
          violations.push(`marnetGeoJson passage tag "${rawId}" is missing from catalog.passages`);
        }
      }
      for (const catalogId of passageIds) {
        if (!rawPassageIds.has(catalogId)) {
          violations.push(`catalog passage id "${catalogId}" does not appear in marnetGeoJson`);
        }
      }
    }
  }

  if (options.portsGeoJson !== undefined) {
    const validSeaPorts = extractValidSeaPortCodes(options.portsGeoJson, violations);
    if (validSeaPorts !== null) {
      for (const code of hubPortCodes) {
        if (!validSeaPorts.has(code)) {
          violations.push(`curated hub port "${code}" is missing or not a sea port (t == 1.0) in portsGeoJson`);
        }
      }
      for (const code of goldenPortCodes) {
        if (!validSeaPorts.has(code)) {
          violations.push(`golden route port "${code}" is missing or not a sea port (t == 1.0) in portsGeoJson`);
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new CatalogValidationError(violations);
  }

  const catalog = rawCatalog as unknown as ChokepointCatalog;
  return {
    catalog,
    passageIds: [...passageIds],
    defaultBlockedPassageIds,
    staticRelTypes: [catalog.openSeaRelType, ...passageRelTypes],
    marnetPassageCounts,
  };
}

export function getBundledCatalog(): ChokepointCatalog {
  return validateCatalog(rawCatalogJson).catalog;
}
