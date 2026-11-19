export type LonLat = readonly [number, number];

const EARTH_RADIUS_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;

const LOWERCASE_COUNTRY_WORDS = new Set(['and', 'of', 'the']);
const UPPERCASE_COUNTRY_WORDS = new Set(['us']);

/**
 * Normalizes any finite longitude into the half-open interval [-180, 180).
 * Uses Euclidean modulo so negative longitudes and values >= 180 (such as
 * Bering Strait vertices at 190.8498) wrap deterministically without -0.
 */
export function normalizeLon(lon: number): number {
  if (!Number.isFinite(lon)) {
    throw new RangeError(`Longitude must be a finite number (got ${String(lon)})`);
  }
  // Short-circuit values already in [-180, 180) to avoid +180/-180 ULP drift and guarantee strict === idempotence.
  if (lon >= -180 && lon < 180) {
    return lon === 0 ? 0 : lon;
  }
  const shifted = lon + 180;
  let wrapped = (((shifted % 360) + 360) % 360) - 180;
  // Guard against IEEE-754 rounding near -1e-16 + 360 === 360 producing 180.
  if (wrapped >= 180 || wrapped < -180) {
    wrapped = -180;
  }
  return wrapped === 0 ? 0 : wrapped;
}

export function roundCoord(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function shortestDeltaLon(lon1: number, lon2: number): number {
  let dLon = lon2 - lon1;
  if (dLon > 180) {
    dLon -= 360;
  } else if (dLon < -180) {
    dLon += 360;
  }
  return dLon;
}

export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = shortestDeltaLon(lon1, lon2) * DEG_TO_RAD;
  const lat1Rad = lat1 * DEG_TO_RAD;
  const lat2Rad = lat2 * DEG_TO_RAD;
  const sinHalfLat = Math.sin(dLat / 2);
  const sinHalfLon = Math.sin(dLon / 2);
  const a =
    sinHalfLat * sinHalfLat +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinHalfLon * sinHalfLon;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

export function pointToSegmentKm(
  pLon: number,
  pLat: number,
  aLon: number,
  aLat: number,
  bLon: number,
  bLat: number,
): number {
  const dLonAB = shortestDeltaLon(aLon, bLon);
  const dLonAP = shortestDeltaLon(aLon, pLon);
  const cosMidLat = Math.cos(((aLat + bLat) / 2) * DEG_TO_RAD);
  const bx = dLonAB * cosMidLat;
  const by = bLat - aLat;
  const px = dLonAP * cosMidLat;
  const py = pLat - aLat;
  const lenSq = bx * bx + by * by;
  const rawT = lenSq > 0 ? (px * bx + py * by) / lenSq : 0;
  const t = Math.max(0, Math.min(1, rawT));
  const closestLon = normalizeLon(aLon + dLonAB * t);
  const closestLat = aLat + (bLat - aLat) * t;
  return haversineKm(pLon, pLat, closestLon, closestLat);
}

export function interpolateAntimeridian(c1: LonLat, c2: LonLat, t: number): [number, number] {
  const dLon = shortestDeltaLon(c1[0], c2[0]);
  const lon = normalizeLon(c1[0] + dLon * t);
  const lat = c1[1] + (c2[1] - c1[1]) * t;
  return [lon, lat];
}

export function polylineLengthKm(coords: readonly LonLat[]): number {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    if (a && b) {
      total += haversineKm(a[0], a[1], b[0], b[1]);
    }
  }
  return total;
}

/**
 * Resamples a polyline uniformly by arc length around `stepKm`, always
 * preserving the exact start and end coordinates. `minSegments` allows callers
 * to force at least 2 segments when avoiding a parallel multi-edge between two
 * anchor vertices.
 */
export function resamplePolyline(
  coords: readonly LonLat[],
  stepKm = 250,
  minSegments = 1,
): [number, number][] {
  if (coords.length < 2) {
    throw new RangeError(`Polyline must contain at least 2 coordinates (got ${coords.length})`);
  }
  if (!Number.isFinite(stepKm) || stepKm <= 0) {
    throw new RangeError(`stepKm must be a positive finite number (got ${String(stepKm)})`);
  }

  const start = coords[0];
  const end = coords[coords.length - 1];
  if (!start || !end) {
    throw new RangeError('Polyline endpoints missing');
  }

  const segLens: number[] = [];
  let totalKm = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    if (!a || !b) continue;
    const d = haversineKm(a[0], a[1], b[0], b[1]);
    segLens.push(d);
    totalKm += d;
  }

  const nSegs = Math.max(minSegments, Math.round(totalKm / stepKm));
  if (nSegs <= 1) {
    return [
      [start[0], start[1]],
      [end[0], end[1]],
    ];
  }

  const sampled: [number, number][] = [[start[0], start[1]]];
  let segIdx = 0;
  let accumKm = 0;

  for (let k = 1; k < nSegs; k++) {
    const targetKm = (totalKm * k) / nSegs;
    while (segIdx < segLens.length - 1 && accumKm + (segLens[segIdx] ?? 0) < targetKm) {
      accumKm += segLens[segIdx] ?? 0;
      segIdx++;
    }
    const segKm = segLens[segIdx] ?? 0;
    const c1 = coords[segIdx];
    const c2 = coords[segIdx + 1];
    if (!c1 || !c2) {
      break;
    }
    const frac = segKm > 0 ? Math.max(0, Math.min(1, (targetKm - accumKm) / segKm)) : 0;
    sampled.push(interpolateAntimeridian(c1, c2, frac));
  }

  sampled.push([end[0], end[1]]);
  return sampled;
}

/**
 * Splits a normalized polyline into antimeridian-safe GeoJSON segments so
 * MapLibre never renders horizontal wrap-around streaks across +/-180 deg.
 */
export function splitAntimeridianLine(coords: readonly LonLat[]): [number, number][][] {
  if (coords.length < 2) {
    return [];
  }
  const first = coords[0];
  if (!first) {
    return [];
  }

  const parts: [number, number][][] = [];
  let current: [number, number][] = [[first[0], first[1]]];

  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1];
    const next = coords[i];
    if (!prev || !next) continue;

    const rawDelta = next[0] - prev[0];
    if (Math.abs(rawDelta) <= 180) {
      current.push([next[0], next[1]]);
      continue;
    }

    // Crossing the antimeridian: interpolate latitude at +/-180 deg boundary.
    const goingEastPast180 = rawDelta < -180;
    const exitLon = goingEastPast180 ? 180 : -180;
    const enterLon = goingEastPast180 ? -180 : 180;
    const unwrappedNextLon = goingEastPast180 ? next[0] + 360 : next[0] - 360;
    const denom = unwrappedNextLon - prev[0];
    const frac = denom !== 0 ? (exitLon - prev[0]) / denom : 0.5;
    const crossLat = prev[1] + (next[1] - prev[1]) * Math.max(0, Math.min(1, frac));

    const pushIfNonDegenerate = (seg: [number, number][]): void => {
      // Collapse consecutive identical points and skip zero-length 2-point artifacts (e.g., [-180, lat] -> [-180, lat]).
      const deduped: [number, number][] = [];
      for (const pt of seg) {
        const last = deduped[deduped.length - 1];
        if (!last || last[0] !== pt[0] || last[1] !== pt[1]) {
          deduped.push(pt);
        }
      }
      if (deduped.length >= 2) {
        parts.push(deduped);
      }
    };

    current.push([exitLon, crossLat]);
    pushIfNonDegenerate(current);
    current = [
      [enterLon, crossLat],
      [next[0], next[1]],
    ];
  }

  const finalDeduped: [number, number][] = [];
  for (const pt of current) {
    const last = finalDeduped[finalDeduped.length - 1];
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) {
      finalDeduped.push(pt);
    }
  }
  if (finalDeduped.length >= 2) {
    parts.push(finalDeduped);
  }
  return parts;
}

export function formatCountryName(rawCountry: string): string {
  const cleaned = rawCountry.trim().replace(/_+/g, ' ').replace(/\s+/g, ' ');
  if (cleaned.length === 0) {
    return 'Unknown';
  }
  return cleaned
    .split(' ')
    .map((word, idx) => {
      const lower = word.toLowerCase();
      if (UPPERCASE_COUNTRY_WORDS.has(lower)) {
        return lower.toUpperCase();
      }
      if (idx > 0 && LOWERCASE_COUNTRY_WORDS.has(lower)) {
        return lower;
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}
