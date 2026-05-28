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

/**
 * Quick current-weather snapshot for UI previews of the full-page weather
 * widget. Separate cache from cloud cover because the UI hits this more
 * often (every time admin opens a device page) but with the same Open-Meteo
 * provider — so we cache aggressively (15 min) per lat,lng to stay polite.
 */
interface WeatherSnapshot {
  temperatureC: number;
  weatherCode: number;
  /** "Sunny", "Mostly cloudy", "Rain", etc. — derived from WMO weather code. */
  conditionLabel: string;
  /** Bucket → emoji glyph for the UI mock. Real device uses VNNOX's icon. */
  conditionGlyph: '☀' | '⛅' | '☁' | '🌧' | '⛈' | '❄' | '🌫';
  highC: number | null;
  lowC: number | null;
}
const WX_CACHE_TTL_MS = 15 * 60 * 1000;
const wxCache = new Map<string, { snap: WeatherSnapshot; fetchedAt: number }>();

/**
 * WMO weather code → human label + bucket glyph. Open-Meteo follows the
 * WMO 4677 codes. We collapse the long tail (e.g. drizzle / freezing
 * drizzle / light drizzle) into the common buckets so the preview reads
 * like a real billboard, not a meteorology textbook.
 */
function describeWmoCode(code: number): { label: string; glyph: WeatherSnapshot['conditionGlyph'] } {
  if (code === 0) return { label: 'Sunny', glyph: '☀' };
  if (code === 1) return { label: 'Mostly sunny', glyph: '⛅' };
  if (code === 2) return { label: 'Partly cloudy', glyph: '⛅' };
  if (code === 3) return { label: 'Cloudy', glyph: '☁' };
  if (code >= 45 && code <= 48) return { label: 'Fog', glyph: '🌫' };
  if (code >= 51 && code <= 57) return { label: 'Drizzle', glyph: '🌧' };
  if (code >= 61 && code <= 67) return { label: 'Rain', glyph: '🌧' };
  if (code >= 71 && code <= 77) return { label: 'Snow', glyph: '❄' };
  if (code >= 80 && code <= 82) return { label: 'Rain showers', glyph: '🌧' };
  if (code >= 85 && code <= 86) return { label: 'Snow showers', glyph: '❄' };
  if (code >= 95) return { label: 'Thunderstorm', glyph: '⛈' };
  return { label: 'Mixed', glyph: '⛅' };
}

export async function getCurrentWeather(
  lat: number,
  lng: number,
  timeoutMs = 8_000,
): Promise<WeatherSnapshot> {
  const key = cacheKey(lat, lng);
  const cached = wxCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < WX_CACHE_TTL_MS) {
    return cached.snap;
  }

  // One round-trip for current temp + weather code + today's hi/lo.
  const url =
    `${BASE_URL}?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&forecast_days=1&timezone=auto`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`open-meteo wx ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
      daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
    };
    const tempC = data.current?.temperature_2m;
    const code = data.current?.weather_code;
    if (typeof tempC !== 'number' || typeof code !== 'number') {
      throw new Error(`open-meteo wx missing current fields: ${JSON.stringify(data).slice(0, 200)}`);
    }
    const desc = describeWmoCode(code);
    const snap: WeatherSnapshot = {
      temperatureC: Math.round(tempC * 10) / 10,
      weatherCode: code,
      conditionLabel: desc.label,
      conditionGlyph: desc.glyph,
      highC: typeof data.daily?.temperature_2m_max?.[0] === 'number'
        ? Math.round(data.daily.temperature_2m_max[0])
        : null,
      lowC: typeof data.daily?.temperature_2m_min?.[0] === 'number'
        ? Math.round(data.daily.temperature_2m_min[0])
        : null,
    };
    wxCache.set(key, { snap, fetchedAt: Date.now() });
    return snap;
  } finally {
    clearTimeout(timer);
  }
}

export type { WeatherSnapshot };
