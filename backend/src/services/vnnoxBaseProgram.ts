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
    /**
     * Set by deviceAlertsService when an active public-safety / weather
     * alert covers the device. Stays NULL when no alert is active OR
     * alerts_enabled is false. Rendering it here means the alert banner
     * shows up in the next base-program republish automatically — admin
     * doesn't have to flip anything else.
     */
    alerts_current_text: string | null;
    /**
     * Full-page weather widget (migration 022). When true, a WEATHER widget
     * page is appended to the base rotation — the NovaStar "Basic Weather"
     * look with sky background, large temperature, condition icon.
     */
    weather_page_enabled: boolean;
    weather_page_duration_ms: number;
    weather_page_location: string | null;
  }>(
    `SELECT device_key AS sn, provider, base_playlist_id,
            overlay_clock_enabled, overlay_clock_position, overlay_clock_format,
            overlay_weather_enabled, overlay_weather_position, overlay_weather_location,
            overlay_weather_units,
            latitude, longitude,
            alerts_current_text,
            weather_page_enabled, weather_page_duration_ms, weather_page_location
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

  // Full-page weather widget (NovaStar "Basic Weather" look). Appended to
  // the rotation AFTER customer content so ads play first. Different from
  // the corner overlay_weather widget — this takes a whole slot and uses
  // VNNOX's full-screen weather template (sky background, large temp,
  // condition icon, today's high/low).
  //
  // Location precedence: weather_page_location explicit override →
  // overlay_weather_location (reuse what they already configured) →
  // device's lat,lng. If none of those resolve, skip the page rather
  // than push a broken widget.
  if (d.weather_page_enabled) {
    const loc =
      d.weather_page_location?.trim()
      || d.overlay_weather_location?.trim()
      || (d.latitude && d.longitude ? `${d.latitude},${d.longitude}` : null);
    if (loc) {
      pages.push({
        name: 'weather-page',
        widgets: [{
          type: 'WEATHER',
          name: 'weather-page-full',
          location: loc,
          // Reuse the device's units choice from the overlay config so
          // °C/°F stays consistent across the corner overlay and this
          // full page.
          units: d.overlay_weather_units,
          unit: d.overlay_weather_units,
          // VNNOX's "Basic Weather" template style — most installs render
          // a sky background + large temp + condition icon at this scale.
          template: 'basic',
          style: 'basic',
          duration: d.weather_page_duration_ms,
          zIndex: 0,
          layout: { x: '0%', y: '0%', width: '100%', height: '100%' },
        }],
      });
    }
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
  // Public safety / weather alert overlay — a scrolling TEXT widget
  // pinned to the bottom 10% of the panel. We deliberately put it on the
  // bottom (where most ad copy doesn't compete) and at high zIndex so it
  // stays visible even if an ad has its own bottom strip. Only emitted
  // when deviceAlertsService has stamped alerts_current_text on the row.
  //
  // NovaStar's TEXT widget field names vary by VNNOX firmware; we send
  // a few common spellings (text/content/value, scroll/marquee/scrollMode)
  // so the device picks whichever it understands.
  if (d.alerts_current_text) {
    overlays.push({
      type: 'TEXT',
      name: 'alert-overlay',
      text: d.alerts_current_text,
      content: d.alerts_current_text,
      value: d.alerts_current_text,
      // High-contrast amber on black — easy to read at a distance and
      // unmistakably an alert vs. an ad. Sized at ~6% of panel height so
      // it reads from the road at typical billboard distances.
      fontSize: '6%',
      color: '#ffcc00',
      backgroundColor: '#000000',
      // Scroll right-to-left at a moderate speed. Speed units are pixels
      // per second on most VNNOX versions; 60 is roughly highway-billboard
      // legibility.
      scroll: true,
      marquee: true,
      scrollMode: 'left',
      scrollSpeed: 60,
      // Loop while the program is up — VNNOX clears the widget when the
      // program is republished without it (the no-alert case).
      repeatTimes: -1,
      zIndex: 200,
      layout: { x: '0%', y: '90%', width: '100%', height: '10%' },
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
