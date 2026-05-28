/**
 * Environment Canada active-alerts client.
 *
 * Source: GeoMet OGC API Features at
 *   https://geo.weather.gc.ca/geomet/features/collections/wxo-active-alerts/items?f=json
 *
 * License: Open Government Licence — Canada / CC-BY 4.0. Free to use,
 * including for commercial display, with attribution. We satisfy
 * attribution by prefixing rendered banners with "Environment Canada:".
 *
 * The feed returns a GeoJSON FeatureCollection. Each feature is one alert
 * with a polygon (or multipolygon) geometry covering the affected area and
 * properties carrying the headline, severity, expiry, etc. Polygon coords
 * are [lng, lat] pairs (GeoJSON convention).
 *
 * We poll this once per cycle (every ~5min) for the whole country, then
 * filter alerts to each enabled device by point-in-polygon. Caching the
 * full list is fine — the response is usually a few hundred KB even
 * during active weather.
 */

const FEED_URL =
  'https://geo.weather.gc.ca/geomet/features/collections/wxo-active-alerts/items?f=json&limit=2000';

/** EC's severity ladder, ordered low → high. */
export const SEVERITY_ORDER = ['minor', 'moderate', 'severe', 'extreme'] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export interface EcAlert {
  /** Stable id from the feed — used to detect "same alert still active". */
  id: string;
  /** Human-facing one-line title, e.g. "Severe thunderstorm warning". */
  headline: string;
  /** Description body, often a few sentences. */
  description: string | null;
  /** EC's category — 'Met' (weather), 'Geo' (geological), 'Safety', etc. */
  category: string | null;
  /** Severity bucket, normalized to lowercase. */
  severity: Severity;
  /** Original "warning" / "watch" / "statement" string for UI hints. */
  alertType: string | null;
  /** ISO-8601 expiry. After this time the alert isn't rendered. */
  expires: string | null;
  /** GeoJSON Polygon or MultiPolygon — coords are [lng, lat]. */
  geometry: { type: 'Polygon'; coordinates: number[][][] } |
            { type: 'MultiPolygon'; coordinates: number[][][][] };
}

interface RawFeature {
  id?: string | number;
  properties?: Record<string, unknown>;
  geometry?: { type: string; coordinates: unknown };
}

interface RawFeatureCollection {
  type?: string;
  features?: RawFeature[];
}

/**
 * Fetches and normalizes the active-alerts feed. Network failures throw
 * so the caller (cron) can log and try again next cycle without poisoning
 * device state.
 */
export async function fetchActiveAlerts(timeoutMs = 15_000): Promise<EcAlert[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(FEED_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`ec-alerts feed returned ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as RawFeatureCollection;
    const features = data.features ?? [];
    const alerts: EcAlert[] = [];
    for (const f of features) {
      const norm = normalize(f);
      if (norm) alerts.push(norm);
    }
    return alerts;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps a raw GeoJSON feature into our typed EcAlert. Returns null for
 * features we can't make sense of (missing geometry, unknown severity) —
 * the cron logs how many were dropped per cycle.
 */
function normalize(f: RawFeature): EcAlert | null {
  const p = (f.properties ?? {}) as Record<string, unknown>;
  const geom = f.geometry;
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return null;

  // EC's property names have shifted across feed versions. Try the common
  // variants for each field; fall through to the most reasonable default.
  const id = String(f.id ?? p.identifier ?? p.id ?? '');
  if (!id) return null;

  const headline = String(p.headline ?? p.alertBannerText ?? p.event ?? '').trim();
  if (!headline) return null;

  const severityRaw = String(p.severity ?? '').toLowerCase();
  const severity = (SEVERITY_ORDER as readonly string[]).includes(severityRaw)
    ? (severityRaw as Severity)
    : 'moderate'; // safe default — surfaces if user picks 'minor' or 'moderate'

  return {
    id,
    headline,
    description: typeof p.description === 'string' ? p.description : null,
    category: typeof p.category === 'string' ? p.category : null,
    severity,
    alertType: typeof p.alertType === 'string'
      ? p.alertType
      : (typeof p.event === 'string' ? p.event : null),
    expires: typeof p.expires === 'string' ? p.expires
      : (typeof p.effective === 'string' ? p.effective : null),
    geometry: geom as EcAlert['geometry'],
  };
}

/**
 * Ray-casting point-in-polygon. Works on a single polygon ring (no holes
 * for now — EC alerts almost never use them).
 *
 * GeoJSON convention: coords are [lng, lat]. We treat them as flat 2D
 * coords; EC's alert polygons are small enough that we don't need a
 * spherical-distance check.
 */
function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Returns true if the device's location falls within the alert's affected
 * area. Handles both Polygon (one ring) and MultiPolygon (multiple rings).
 */
export function alertCoversPoint(alert: EcAlert, lat: number, lng: number): boolean {
  if (alert.geometry.type === 'Polygon') {
    // First ring is the outer boundary; subsequent rings are holes (rare
    // in EC data — we ignore them, which biases toward "covered" rather
    // than the other direction).
    const outer = alert.geometry.coordinates[0];
    return pointInRing(lng, lat, outer);
  }
  // MultiPolygon: covered if ANY of its polygons contains the point.
  for (const poly of alert.geometry.coordinates) {
    const outer = poly[0];
    if (pointInRing(lng, lat, outer)) return true;
  }
  return false;
}

/**
 * Comparison helper: is severity A at least B?
 *   severityMeets('severe', 'moderate') === true
 *   severityMeets('minor', 'severe')    === false
 */
export function severityMeets(actual: Severity, minimum: Severity): boolean {
  return SEVERITY_ORDER.indexOf(actual) >= SEVERITY_ORDER.indexOf(minimum);
}
