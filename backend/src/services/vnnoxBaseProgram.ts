/**
 * Publishes a device's BASE program (the regular content rotation that
 * plays between customer ads) plus any enabled overlay widgets (clock,
 * weather). Customer ads stay separate as insertion programs from
 * vnnoxAdPublisher — those slot in alongside this.
 *
 * This is a full replace: every call rebuilds the normal program with the
 * latest base playlist content + overlay settings. Doesn't touch the
 * insertion programs that carry approved customer ads.
 */
import { query } from '../db';
import { config } from '../config';
import { vnnoxBaseUrl, vnnoxFetch } from '../coex/vnnoxSign';
import { CoexError } from '../coex/types';

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

interface PlaylistItemRow {
  id: string;
  media_id: string;
  duration_ms: number;
  storage_url: string;
  mime_type: string;
  size_bytes: string;
  checksum_md5: string | null;
}

/**
 * Layout helpers: 4 fixed corner anchors with a small inset so the widget
 * doesn't bleed off the panel edge. Sizes are percentages of the panel.
 */
const OVERLAY_LAYOUTS: Record<Corner, { x: string; y: string; width: string; height: string }> = {
  'top-left':     { x: '2%',  y: '2%',  width: '20%', height: '10%' },
  'top-right':    { x: '78%', y: '2%',  width: '20%', height: '10%' },
  'bottom-left':  { x: '2%',  y: '88%', width: '20%', height: '10%' },
  'bottom-right': { x: '78%', y: '88%', width: '20%', height: '10%' },
};

function widgetTypeFor(mime: string): 'PICTURE' | 'GIF' | 'VIDEO' {
  if (mime === 'image/gif') return 'GIF';
  if (mime.startsWith('video/')) return 'VIDEO';
  return 'PICTURE';
}

async function resolvePlayerId(sn: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await vnnoxFetch(`${vnnoxBaseUrl()}/v2/player/current/online-status`, {
      method: 'POST',
      body: JSON.stringify({ playerSns: [sn] }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new CoexError(`vnnox player lookup failed (${res.status}): ${text}`, 'DEVICE_ERROR');
    }
    const data = JSON.parse(text) as Array<{ sn: string; playerId: string }>;
    const hit = data.find((p) => p.sn === sn) ?? data[0];
    if (!hit?.playerId) throw new CoexError(`vnnox returned no playerId for sn=${sn}`, 'DEVICE_ERROR');
    return hit.playerId;
  } finally {
    clearTimeout(timer);
  }
}

export async function republishBaseProgram(deviceId: string): Promise<{ programId?: string; rawResponse: unknown }> {
  // Pull everything we need in one query: device + overlay settings + the
  // base playlist's items in order.
  const dev = await query<{
    sn: string;
    provider: string;
    base_playlist_id: string | null;
    overlay_clock_enabled: boolean;
    overlay_clock_position: Corner;
    overlay_clock_format: string;
    overlay_weather_enabled: boolean;
    overlay_weather_position: Corner;
    overlay_weather_location: string | null;
    overlay_weather_units: string;
    latitude: string | null;
    longitude: string | null;
  }>(
    `SELECT device_key AS sn, provider, base_playlist_id,
            overlay_clock_enabled, overlay_clock_position, overlay_clock_format,
            overlay_weather_enabled, overlay_weather_position, overlay_weather_location,
            overlay_weather_units,
            latitude, longitude
       FROM devices WHERE id = $1`,
    [deviceId],
  );
  if (dev.rows.length === 0) {
    throw new Error(`device ${deviceId} not found`);
  }
  const d = dev.rows[0];
  if (d.provider !== 'vnnox') {
    throw new Error(`device provider is "${d.provider}" — base-program publish requires vnnox`);
  }

  // Base playlist content — empty array if not set, which produces an
  // overlay-only program. NovaStar may or may not accept that; if not the
  // error bubbles up so the admin sees it.
  let pages: Array<{ name: string; widgets: unknown[] }> = [];
  if (d.base_playlist_id) {
    const items = await query<PlaylistItemRow>(
      `SELECT pi.id, pi.media_id, pi.duration_ms,
              m.storage_url, m.mime_type, m.size_bytes, m.checksum_md5
         FROM playlist_items pi
         JOIN media m ON m.id = pi.media_id
        WHERE pi.playlist_id = $1
        ORDER BY pi.position`,
      [d.base_playlist_id],
    );
    pages = items.rows.map((it, i) => ({
      name: `base-page-${i + 1}`,
      widgets: [{
        type: widgetTypeFor(it.mime_type),
        name: `base-${it.media_id.slice(0, 8)}`,
        url: it.storage_url,
        size: Number(it.size_bytes),
        md5: it.checksum_md5 ?? undefined,
        duration: it.duration_ms,
        zIndex: 0,
        layout: { x: '0%', y: '0%', width: '100%', height: '100%' },
      }],
    }));
  }
  if (pages.length === 0) {
    // VNNOX needs at least one page. Use a black placeholder so the program
    // is valid; the overlays still render over it.
    pages = [{
      name: 'placeholder',
      widgets: [{
        type: 'PICTURE',
        name: 'placeholder',
        // Solid-black 1×1 PNG inlined as data URL — VNNOX accepts URLs;
        // for a placeholder this should be a hosted asset in production.
        url: `${config.publicBaseUrl}/files/uploads/black-1x1.png`,
        duration: 5000,
        zIndex: 0,
        layout: { x: '0%', y: '0%', width: '100%', height: '100%' },
      }],
    }];
  }

  // Layer overlays on every page so they stay visible throughout the loop.
  const overlays: unknown[] = [];
  if (d.overlay_clock_enabled) {
    overlays.push({
      type: 'CLOCK',
      name: 'clock-overlay',
      // VNNOX clock widget config — field names follow their docs;
      // unrecognized fields are ignored so we send a few common spellings.
      clockFormat: d.overlay_clock_format,
      format: d.overlay_clock_format,
      zIndex: 100,
      layout: OVERLAY_LAYOUTS[d.overlay_clock_position],
    });
  }
  if (d.overlay_weather_enabled) {
    // Prefer the explicit location string; fall back to lat,lng pair.
    const location = d.overlay_weather_location
      || (d.latitude && d.longitude ? `${d.latitude},${d.longitude}` : null);
    if (!location) {
      throw new Error('Weather overlay enabled but no location is set on the device.');
    }
    overlays.push({
      type: 'WEATHER',
      name: 'weather-overlay',
      location,
      units: d.overlay_weather_units,        // 'metric' | 'imperial'
      unit:  d.overlay_weather_units,        // alt spelling
      zIndex: 100,
      layout: OVERLAY_LAYOUTS[d.overlay_weather_position],
    });
  }
  if (overlays.length > 0) {
    for (const page of pages) {
      page.widgets.push(...overlays);
    }
  }

  // Publish: /v2/player/program/normal both creates the program and pushes
  // it to the players in the request. Same endpoint vnnoxClient.pushPlaylist
  // already uses for one-off deploys.
  const playerId = await resolvePlayerId(d.sn, config.vnnox.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.vnnox.timeoutMs);
  try {
    const res = await vnnoxFetch(`${vnnoxBaseUrl()}/v2/player/program/normal`, {
      method: 'POST',
      body: JSON.stringify({ playerIds: [playerId], pages }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new CoexError(`vnnox base-program publish failed (${res.status}): ${text}`, 'DEVICE_ERROR');
    }
    const data = text ? safeJson(text) : {};
    const programId =
      (data as any)?.programId ||
      (data as any)?.id ||
      (data as any)?.data?.programId ||
      undefined;
    return { programId, rawResponse: data };
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
