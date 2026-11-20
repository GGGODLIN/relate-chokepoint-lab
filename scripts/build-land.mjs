import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { roundCoord } from '../src/etl/geo.ts';

// Natural Earth is public domain, so the derived basemap ships without attribution
// and the workbench never needs a third-party tile server (zero external requests).
// Usage: node scripts/build-land.mjs <path/to/ne_50m_land.geojson>
const ROOT_DIR = resolve(import.meta.dirname, '..');
const OUTPUT_PATH = resolve(ROOT_DIR, 'public/data/land.geojson');
// 0.01 deg (~1.1 km) is below one screen pixel at the zoom levels the workbench uses.
const DECIMALS = 2;

function simplifyRing(ring) {
  const out = [];
  for (const point of ring) {
    const lon = roundCoord(point[0], DECIMALS);
    const lat = roundCoord(point[1], DECIMALS);
    const prev = out[out.length - 1];
    if (prev === undefined || prev[0] !== lon || prev[1] !== lat) {
      out.push([lon, lat]);
    }
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (first !== undefined && last !== undefined && (first[0] !== last[0] || first[1] !== last[1])) {
    out.push([first[0], first[1]]);
  }
  // A linear ring needs 4 positions (3 distinct + closing); anything smaller is a sliver island.
  return out.length >= 4 ? out : null;
}

function simplifyPolygon(rings) {
  const outer = simplifyRing(rings[0] ?? []);
  if (outer === null) {
    return null;
  }
  const holes = rings.slice(1).map(simplifyRing).filter((ring) => ring !== null);
  return [outer, ...holes];
}

function main() {
  const inputPath = process.argv[2];
  if (inputPath === undefined) {
    throw new Error('Usage: node scripts/build-land.mjs <path/to/ne_50m_land.geojson>');
  }
  const source = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
  if (source?.type !== 'FeatureCollection' || !Array.isArray(source.features)) {
    throw new Error('Input must be a GeoJSON FeatureCollection');
  }

  const polygons = [];
  for (const feature of source.features) {
    const geometry = feature?.geometry;
    if (geometry?.type === 'Polygon') {
      polygons.push(geometry.coordinates);
    } else if (geometry?.type === 'MultiPolygon') {
      polygons.push(...geometry.coordinates);
    } else {
      throw new Error(`Unexpected geometry type: ${String(geometry?.type)}`);
    }
  }

  const simplified = polygons.map(simplifyPolygon).filter((polygon) => polygon !== null);
  const output = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'MultiPolygon', coordinates: simplified },
      },
    ],
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(output));
  const bytes = statSync(OUTPUT_PATH).size;
  process.stdout.write(
    `${JSON.stringify({ inputPolygons: polygons.length, keptPolygons: simplified.length, bytes })}\n`,
  );
}

main();
