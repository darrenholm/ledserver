/**
 * Open-Meteo current-conditions client. Free, no API key, CC-BY 4.0 data.
 *
 * Endpoint: GET https://api.open-meteo.com/v1/forecast
 *   ?latitude=43.72&longitude=-81.27
 *   &current=cloud_cover
 *
 * Returns { current: { cloud_cover: 47 } } — a percentage 0-100.
 *
 * Why this and not Environment Canada: EC's MSC datamart serves SWOB
 * station observations in a separate XML format per station, and the
 * nearest-station distance can be 50+ km in rural Ontario. Open-Meteo
 * interpolates from ECMWF/GFS grids, which is closer to the actual
 * conditions over the device's location. It's also unambiguous to call.
 */

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';

/** Cache one cloud-cover reading per lat,lng pair for a few minutes. */
interface CacheEntry {
  pct: number;
  fetchedAt: number;
}
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — cloud cover changes slowly
const cache = new Map<string, CacheEntry>();

function cacheKey(lat: number, lng: number): string {
  // Quantize to 0.01° so devices a few hundred metres apart share the
  // same lookup. Keeps cache hit rate high without sacrificing accuracy.
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

/**
 * Returns the current cloud cover percentage at the given location.
 * Cached for 10 minutes per ~1km grid cell. Network failures throw — the
 * caller (brightness scheduler) treats failures as "no dim applied" so a
 * weather outage doesn't dim the panel unpredictably.
 */
export async function getCloudCoverPct(
  lat: number,
  lng: number,
  timeoutMs = 8_000,
): Promise<number> {
  const key = cacheKey(lat, lng);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.pct;
  }

  const url = `${BASE_URL}?latitude=${lat}&longitude=${lng}&current=cloud_cover`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`open-meteo returned ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { current?: { cloud_cover?: number } };
    const raw = data.current?.cloud_cover;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new Error(`open-meteo missing cloud_cover in response: ${JSON.stringify(data).slice(0, 200)}`);
    }
    // Clamp to [0, 100] — Open-Meteo occasionally returns values like
    // 100.0000001 which would break SMALLINT storage on the device row.
    const pct = Math.max(0, Math.min(100, Math.round(raw)));
    cache.set(key, { pct, fetchedAt: Date.now() });
    return pct;
  } finally {
    clearTimeout(timer);
  }
}

/** Test hook: clear the cache between unit tests. */
export function _clearCloudCoverCache(): void {
  cache.clear();
}
