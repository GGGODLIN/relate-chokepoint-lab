import { getOpenRelTypes, type ChokepointCatalog } from '../contracts/catalog.ts';
import { buildStaticRelTypeDisjunction } from '../etl/relate-loader.ts';

export const DEFAULT_BBOX_EDGE_LIMIT = 500;

export interface RouteQueryOptions {
  readonly shortCircuitSameWaypoint?: boolean;
  readonly profile?: boolean;
}

export interface ProfileQueryOptions {
  readonly profile?: boolean;
}

export function wrapWithProfile(cypher: string): string {
  const trimmed = cypher.trim();
  if (trimmed.length === 0) {
    throw new Error('Cannot wrap empty Cypher query with PROFILE');
  }
  if (/^PROFILE\b/i.test(trimmed)) {
    return trimmed;
  }
  if (/^EXPLAIN\b/i.test(trimmed)) {
    return trimmed.replace(/^EXPLAIN\b/i, 'PROFILE');
  }
  return `PROFILE ${trimmed}`;
}

export function buildSameWaypointRouteQuery(options: ProfileQueryOptions = {}): string {
  const query = [
    'MATCH (a:Port {code: $from}), (b:Port {code: $to})',
    'RETURN a.code AS fromCode,',
    '       b.code AS toCode,',
    '       true AS shortCircuited,',
    '       0 AS hops,',
    '       0.0 AS totalKm,',
    '       CASE WHEN a = b THEN [[a.lon, a.lat]] ELSE [[a.lon, a.lat], [b.lon, b.lat]] END AS coords,',
    '       CASE WHEN a = b THEN [a.code] ELSE [a.code, b.code] END AS nodeIds,',
    '       [] AS edgeIds,',
    '       [] AS relTypes',
  ].join('\n');
  return options.profile ? wrapWithProfile(query) : query;
}

export function buildRouteQuery(
  catalog: ChokepointCatalog,
  blockedPassageIds: Iterable<string>,
  options: RouteQueryOptions = {},
): string {
  if (options.shortCircuitSameWaypoint) {
    return buildSameWaypointRouteQuery({ profile: options.profile });
  }

  const openRelTypes = getOpenRelTypes(catalog, blockedPassageIds);
  const relPattern = buildStaticRelTypeDisjunction(openRelTypes);

  // WHERE a <> b guards ShortestPathCommonEndNodes on the node endpoints without adding any edge predicate.
  const query = [
    'MATCH (a:Port {code: $from}), (b:Port {code: $to})',
    `OPTIONAL MATCH p = shortestPath((a)-[${relPattern}*]-(b))`,
    'WHERE a <> b',
    'RETURN a.code AS fromCode,',
    '       b.code AS toCode,',
    '       (a = b OR a.snapWpId = b.snapWpId) AS shortCircuited,',
    '       CASE WHEN a = b OR a.snapWpId = b.snapWpId THEN 0 WHEN p IS NULL THEN null ELSE length(p) END AS hops,',
    '       CASE WHEN a = b OR a.snapWpId = b.snapWpId THEN 0.0 WHEN p IS NULL THEN null ELSE round(reduce(km = 0.0, r IN relationships(p) | km + r.km), 1) END AS totalKm,',
    '       CASE WHEN a = b THEN [[a.lon, a.lat]] WHEN a.snapWpId = b.snapWpId THEN [[a.lon, a.lat], [b.lon, b.lat]] WHEN p IS NULL THEN [] ELSE [n IN nodes(p) | [n.lon, n.lat]] END AS coords,',
    '       CASE WHEN a = b THEN [a.code] WHEN a.snapWpId = b.snapWpId THEN [a.code, b.code] WHEN p IS NULL THEN [] ELSE [n IN nodes(p) | coalesce(n.id, n.code)] END AS nodeIds,',
    '       CASE WHEN a = b OR a.snapWpId = b.snapWpId OR p IS NULL THEN [] ELSE [r IN relationships(p) | r.id] END AS edgeIds,',
    '       CASE WHEN a = b OR a.snapWpId = b.snapWpId OR p IS NULL THEN [] ELSE [r IN relationships(p) | type(r)] END AS relTypes',
  ].join('\n');

  return options.profile ? wrapWithProfile(query) : query;
}

export function buildIsolationQuery(
  catalog: ChokepointCatalog,
  blockedPassageIds: Iterable<string>,
  options: ProfileQueryOptions = {},
): string {
  const openRelTypes = getOpenRelTypes(catalog, blockedPassageIds);
  const relPattern = buildStaticRelTypeDisjunction(openRelTypes);

  const query = [
    'MATCH (hub:Port {code: $refHub})',
    `OPTIONAL MATCH p = shortestPath((hub)-[${relPattern}*]-(p2:Port))`,
    'WHERE p2 <> hub',
    'WITH hub, collect(p2.code) + [hub.code] AS reachableCodes',
    'MATCH (isolated:Port)',
    'WHERE NOT isolated.code IN reachableCodes',
    'RETURN isolated.code AS code,',
    '       isolated.name AS name,',
    '       isolated.country AS country,',
    '       isolated.lon AS lon,',
    '       isolated.lat AS lat,',
    '       isolated.rank AS rank,',
    '       isolated.tradeDegree AS tradeDegree',
    'ORDER BY isolated.rank ASC, isolated.code ASC',
  ].join('\n');

  return options.profile ? wrapWithProfile(query) : query;
}

export function buildTradeExposureForPortsQuery(options: ProfileQueryOptions = {}): string {
  const query = [
    'MATCH (isolated:Port)-[:TRADES_WITH]->(c:Country)',
    'WHERE isolated.code IN $isolatedCodes',
    'RETURN c.code AS countryCode,',
    '       c.name AS countryName,',
    '       count(DISTINCT isolated) AS exposedPorts',
    'ORDER BY exposedPorts DESC, c.code ASC',
  ].join('\n');

  return options.profile ? wrapWithProfile(query) : query;
}

export function buildBBoxEdgesQuery(): string {
  return [
    'UNWIND $boxes AS box',
    'MATCH (w:WP)',
    'WHERE point.withinBBox(w.loc, point({longitude: box.swLon, latitude: box.swLat}), point({longitude: box.neLon, latitude: box.neLat}))',
    "MATCH (w)-[r {kind: 'lane'}]-(w2:WP)",
    'RETURN DISTINCT r.id AS edgeId, type(r) AS relType, r.km AS km',
    'LIMIT $limit',
  ].join('\n');
}

export function buildDeleteEdgesByIdsQuery(): string {
  return [
    'MATCH (:WP)-[r]->(:WP)',
    'WHERE r.id IN $edgeIds',
    'DELETE r',
    'RETURN count(r) AS deletedCount',
  ].join('\n');
}

export const QueryBuilder = {
  buildRouteQuery,
  buildSameWaypointRouteQuery,
  buildIsolationQuery,
  buildTradeExposureForPortsQuery,
  buildBBoxEdgesQuery,
  buildDeleteEdgesByIdsQuery,
  wrapWithProfile,
} as const;
