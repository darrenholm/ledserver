import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { query } from '../db';
import { config } from '../config';
import { authRequired, requireOrgRole } from '../middleware/auth';
import { coexRegistry, DeviceConnInfo, DeviceProvider } from '../coex/registry';
import { writeLog } from '../services/logs';
import { orgClause, orgForInsert } from '../services/scope';
import { republishBaseProgram } from '../services/vnnoxBaseProgram';
import { requestScreenshot } from '../services/vnnoxScreenshot';

const router = Router();
router.use(authRequired);

interface DeviceRow {
  id: string;
  organization_id: string;
  provider: DeviceProvider;
  name: string;
  model: string | null;
  device_key: string;
  ip_address: string | null;
  port: number;
  location: string | null;
  width_px: number | null;
  height_px: number | null;
  last_seen_at: string | null;
  online: boolean;
  firmware: string | null;
  metadata: Record<string, unknown>;
  auto_brightness_enabled: boolean;
  latitude: string | null;
  longitude: string | null;
  brightness_day: number;
  brightness_night: number;
  brightness_offset_minutes: number;
  last_applied_brightness: number | null;
  last_applied_at: string | null;
  photos: string[];
  traffic_stat: string | null;
  description: string | null;
  // Ad slot rotation config
  max_ads: number;
  ad_slot_seconds: number;
  base_playlist_id: string | null;
  // Overlay widgets
  overlay_clock_enabled: boolean;
  overlay_clock_position: string;
  overlay_clock_format: string;
  overlay_weather_enabled: boolean;
  overlay_weather_position: string;
  overlay_weather_location: string | null;
  overlay_weather_units: string;
  // Public-safety / weather alerts overlay (Environment Canada)
  alerts_enabled: boolean;
  alerts_severity_min: string;
  alerts_current_id: string | null;
  alerts_current_text: string | null;
  alerts_last_polled_at: string | null;
  // Overcast dimming
  dim_on_overcast_enabled: boolean;
  dim_max_pct: number;
  last_cloud_cover_pct: number | null;
  last_dim_applied_pct: number | null;
  // Full-page weather widget
  weather_page_enabled: boolean;
  weather_page_duration_ms: number;
  weather_page_location: string | null;
  // Ownership
  owner_client_id: number | null;
  owner_project_id: number | null;
  created_at: string;
  updated_at: string;
}

function connInfoFor(d: DeviceRow): DeviceConnInfo {
  return {
    id: d.id,
    provider: d.provider,
    deviceKey: d.device_key,
    ipAddress: d.ip_address ?? undefined,
    port: d.port,
  };
}

const providerEnum = z.enum(['vnnox', 'lan_direct', 'mock']);

const createSchema = z.object({
  name: z.string().min(1),
  provider: providerEnum.default('vnnox'),
  deviceKey: z.string().min(1),                  // SN for vnnox, local key for lan_direct
  ipAddress: z.string().min(1).optional(),       // required for lan_direct, ignored for vnnox
  port: z.number().int().min(1).max(65535).optional(),
  model: z.string().optional(),
  location: z.string().optional(),
  widthPx: z.number().int().positive().optional(),
  heightPx: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine(
  (d) => d.provider !== 'lan_direct' || !!d.ipAddress,
  { message: 'ipAddress is required when provider is lan_direct', path: ['ipAddress'] },
);

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  provider: providerEnum.optional(),
  deviceKey: z.string().min(1).optional(),
  ipAddress: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  model: z.string().optional(),
  location: z.string().optional(),
  widthPx: z.number().int().positive().optional(),
  heightPx: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
  // Brightness automation
  autoBrightnessEnabled: z.boolean().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  brightnessDay: z.number().int().min(0).max(100).optional(),
  brightnessNight: z.number().int().min(0).max(100).optional(),
  brightnessOffsetMinutes: z.number().int().min(-120).max(120).optional(),
  // Double-sided / side-by-side screen: duplicate each slide onto two halves.
  dualPanel: z.boolean().optional(),
  // Rentals
  isRentable: z.boolean().optional(),
  dailyRate: z.number().min(0).nullable().optional(),
  weeklyRate: z.number().min(0).nullable().optional(),
  monthlyRate: z.number().min(0).nullable().optional(),
  rentalCurrency: z.string().min(3).max(3).optional(),
  // Marketing (shown on holmgraphics.ca/advertise)
  photos: z.array(z.string().url()).max(20).optional(),
  trafficStat: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  // Ad slot rotation
  maxAds: z.number().int().min(0).max(64).optional(),
  adSlotSeconds: z.number().int().min(1).max(60).optional(),
  basePlaylistId: z.string().uuid().nullable().optional(),
  // Overlay widgets
  overlayClockEnabled: z.boolean().optional(),
  overlayClockPosition: z.enum(['top-left','top-right','bottom-left','bottom-right']).optional(),
  overlayClockFormat: z.enum(['12h','24h']).optional(),
  overlayWeatherEnabled: z.boolean().optional(),
  overlayWeatherPosition: z.enum(['top-left','top-right','bottom-left','bottom-right']).optional(),
  overlayWeatherLocation: z.string().max(120).nullable().optional(),
  overlayWeatherUnits: z.enum(['metric','imperial']).optional(),
  // Public-safety / weather alerts overlay
  alertsEnabled: z.boolean().optional(),
  alertsSeverityMin: z.enum(['minor','moderate','severe','extreme']).optional(),
  // Overcast dimming
  dimOnOvercastEnabled: z.boolean().optional(),
  dimMaxPct: z.number().int().min(0).max(30).optional(),
  // Full-page weather widget (NovaStar "Basic Weather" look)
  weatherPageEnabled: z.boolean().optional(),
  weatherPageDurationMs: z.number().int().min(3000).max(60000).optional(),
  weatherPageLocation: z.string().max(120).nullable().optional(),
  // Ownership: who owns this screen (shop-api.clients.id) and which sale
  // job delivered it. Setting owner_client_id triggers the DB trigger
  // that auto-creates an owner_perpetual ad_contracts row.
  ownerClientId: z.number().int().nullable().optional(),
  ownerProjectId: z.number().int().nullable().optional(),
});

router.get('/', async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 1);
  const { rows } = await query<DeviceRow>(
    `SELECT * FROM devices WHERE 1=1 ${clause} ORDER BY created_at DESC`,
    params,
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 2);
  const { rows } = await query<DeviceRow>(
    `SELECT * FROM devices WHERE id = $1 ${clause}`,
    [req.params.id, ...params],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(rows[0]);
});

router.post('/', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const data = createSchema.parse(req.body);
  // Only super-admins can register lan_direct devices (it's an in-shop diagnostic mode).
  if (data.provider === 'lan_direct' && req.user!.role !== 'super_admin') {
    res.status(403).json({ error: 'lan_direct provider is super-admin only' });
    return;
  }
  const orgId = await orgForInsert(req);
  const defaultPort = data.provider === 'lan_direct' ? 5200 : 5000;
  const { rows } = await query<DeviceRow>(
    `INSERT INTO devices (organization_id, provider, name, model, device_key, ip_address, port, location, width_px, height_px, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, '{}'::jsonb))
     RETURNING *`,
    [
      orgId,
      data.provider,
      data.name,
      data.model ?? null,
      data.deviceKey,
      data.ipAddress ?? null,
      data.port ?? defaultPort,
      data.location ?? null,
      data.widthPx ?? null,
      data.heightPx ?? null,
      data.metadata ?? null,
    ],
  );
  await writeLog('info', 'api', `device registered: ${data.name}`, rows[0].id, { provider: data.provider }, orgId);
  res.status(201).json(rows[0]);
});

// --- Bulk import (CSV-friendly) ---
//
// Match each row by `name` (exact, within the current org scope) and apply
// updates only to columns the caller provided. Designed for the CSV import
// page: super-admin pastes a spreadsheet, we patch each existing device.
//
// Doesn't create new devices — keeps it safe by only touching rows whose
// name matches something that already exists.

const bulkRowSchema = z.object({
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  location: z.string().nullable().optional(),
  trafficStat: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  photos: z.array(z.string().url()).max(20).optional(),
});

const bulkImportSchema = z.object({
  rows: z.array(bulkRowSchema).min(1).max(500),
});

router.post('/bulk-import', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const data = bulkImportSchema.parse(req.body);
  const scope = req.orgScope;

  // Field name → DB column mapping. Only these columns can be bulk-updated.
  const colMap: Record<string, string> = {
    latitude: 'latitude',
    longitude: 'longitude',
    location: 'location',
    trafficStat: 'traffic_stat',
    description: 'description',
    photos: 'photos',
  };

  const matched: { name: string; id: string }[] = [];
  const unmatched: string[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const row of data.rows) {
    try {
      // Find candidates by exact name. Use ILIKE to be tolerant of stray whitespace.
      const trimmed = row.name.trim();
      const matchClause = scope
        ? `WHERE name = $1 AND organization_id = $2`
        : `WHERE name = $1`;
      const matchParams = scope ? [trimmed, scope] : [trimmed];
      const candidates = await query<{ id: string }>(
        `SELECT id FROM devices ${matchClause}`,
        matchParams,
      );
      if (candidates.rows.length === 0) {
        unmatched.push(trimmed);
        continue;
      }
      if (candidates.rows.length > 1) {
        errors.push({ name: trimmed, error: `${candidates.rows.length} devices share this name; skipping for safety` });
        continue;
      }

      // Build SET clause for whichever columns the caller provided.
      const fields: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const [key, col] of Object.entries(colMap)) {
        if (Object.prototype.hasOwnProperty.call(row, key)) {
          fields.push(`${col} = $${i++}`);
          values.push((row as Record<string, unknown>)[key]);
        }
      }
      if (fields.length === 0) {
        // Nothing to patch — still count as matched.
        matched.push({ name: trimmed, id: candidates.rows[0].id });
        continue;
      }
      fields.push(`updated_at = NOW()`);
      values.push(candidates.rows[0].id);
      await query(`UPDATE devices SET ${fields.join(', ')} WHERE id = $${i}`, values);
      matched.push({ name: trimmed, id: candidates.rows[0].id });
    } catch (err) {
      errors.push({ name: row.name, error: (err as Error).message });
    }
  }

  res.json({
    matched: matched.length,
    unmatched: unmatched.length,
    errors: errors.length,
    matchedRows: matched,
    unmatchedRows: unmatched,
    errorRows: errors,
  });
});

router.patch('/:id', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const data = updateSchema.parse(req.body);
  const fields: string[] = [];
  const values: unknown[] = [];
  const mapping: Record<string, keyof typeof data> = {
    name: 'name',
    provider: 'provider',
    model: 'model',
    device_key: 'deviceKey',
    ip_address: 'ipAddress',
    port: 'port',
    location: 'location',
    width_px: 'widthPx',
    height_px: 'heightPx',
    metadata: 'metadata',
    auto_brightness_enabled: 'autoBrightnessEnabled',
    latitude: 'latitude',
    longitude: 'longitude',
    brightness_day: 'brightnessDay',
    brightness_night: 'brightnessNight',
    brightness_offset_minutes: 'brightnessOffsetMinutes',
    dual_panel: 'dualPanel',
    is_rentable: 'isRentable',
    daily_rate: 'dailyRate',
    weekly_rate: 'weeklyRate',
    monthly_rate: 'monthlyRate',
    rental_currency: 'rentalCurrency',
    photos: 'photos',
    traffic_stat: 'trafficStat',
    description: 'description',
    max_ads: 'maxAds',
    ad_slot_seconds: 'adSlotSeconds',
    base_playlist_id: 'basePlaylistId',
    overlay_clock_enabled: 'overlayClockEnabled',
    overlay_clock_position: 'overlayClockPosition',
    overlay_clock_format: 'overlayClockFormat',
    overlay_weather_enabled: 'overlayWeatherEnabled',
    overlay_weather_position: 'overlayWeatherPosition',
    overlay_weather_location: 'overlayWeatherLocation',
    overlay_weather_units: 'overlayWeatherUnits',
    alerts_enabled: 'alertsEnabled',
    alerts_severity_min: 'alertsSeverityMin',
    dim_on_overcast_enabled: 'dimOnOvercastEnabled',
    dim_max_pct: 'dimMaxPct',
    weather_page_enabled: 'weatherPageEnabled',
    weather_page_duration_ms: 'weatherPageDurationMs',
    weather_page_location: 'weatherPageLocation',
    owner_client_id: 'ownerClientId',
    owner_project_id: 'ownerProjectId',
  };
  let i = 1;
  for (const [col, key] of Object.entries(mapping)) {
    if (data[key] !== undefined) {
      fields.push(`${col} = $${i++}`);
      values.push(data[key]);
    }
  }
  if (fields.length === 0) {
    res.status(400).json({ error: 'no fields to update' });
    return;
  }
  fields.push(`updated_at = NOW()`);
  values.push(req.params.id);
  const idIdx = i;
  i++;
  const { clause, params: scopeParams } = orgClause(req, 'organization_id', i);
  const { rows } = await query<DeviceRow>(
    `UPDATE devices SET ${fields.join(', ')} WHERE id = $${idIdx} ${clause} RETURNING *`,
    [...values, ...scopeParams],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(rows[0]);
});

router.delete('/:id', requireOrgRole('org_admin'), async (req, res) => {
  await coexRegistry.drop(req.params.id);
  const { clause, params } = orgClause(req, 'organization_id', 2);
  const { rowCount } = await query(`DELETE FROM devices WHERE id = $1 ${clause}`, [req.params.id, ...params]);
  if (rowCount === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(204).end();
});

// --- COEX actions: org-scoped lookup, then bounce to the device ---

import type { Request } from 'express';
async function loadDevice(req: Request): Promise<DeviceRow | null> {
  const scope = req.orgScope;
  if (scope) {
    const { rows } = await query<DeviceRow>(
      `SELECT * FROM devices WHERE id = $1 AND organization_id = $2`,
      [req.params.id, scope],
    );
    return rows[0] ?? null;
  }
  const { rows } = await query<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  return rows[0] ?? null;
}

router.post('/:id/ping', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const device = await loadDevice(req);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const client = coexRegistry.get(connInfoFor(device));
  const info = await client.handshake();
  await query(
    `UPDATE devices SET online = TRUE, last_seen_at = NOW(), firmware = COALESCE($2, firmware), updated_at = NOW() WHERE id = $1`,
    [device.id, info.firmware],
  );
  res.json({ ok: true, info });
});

/**
 * Live weather snapshot for the DeviceDetail weather-page preview panel.
 * Resolves location with the same precedence as the publish path
 * (explicit override → overlay_weather_location → device lat/lng) so the
 * preview matches what'll get pushed.
 *
 * `?location=` query param lets the UI pass an unsaved override from the
 * form so the preview reacts to typing without saving first. Falls back
 * to the saved location if not provided.
 */
router.get('/:id/weather-preview', async (req, res) => {
  const device = await loadDevice(req);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const overrideRaw = typeof req.query.location === 'string' ? req.query.location : '';
  const loc =
    overrideRaw.trim()
    || device.weather_page_location?.trim()
    || device.overlay_weather_location?.trim()
    || (device.latitude && device.longitude ? `${device.latitude},${device.longitude}` : '');
  if (!loc) {
    res.status(422).json({
      error: 'no location resolvable for this device',
      message: 'Set the device lat/lng (brightness card) or enter a location override.',
    });
    return;
  }

  // Parse "lat,lng" → numbers. If the user supplied a city name, geocode
  // it via Open-Meteo's free geocoding endpoint first.
  let lat: number | null = null;
  let lng: number | null = null;
  const m = loc.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (m) {
    lat = Number(m[1]);
    lng = Number(m[2]);
  } else {
    try {
      const gres = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(loc)}&count=1`,
      );
      if (gres.ok) {
        const gdata = (await gres.json()) as { results?: { latitude: number; longitude: number }[] };
        const hit = gdata.results?.[0];
        if (hit) {
          lat = hit.latitude;
          lng = hit.longitude;
        }
      }
    } catch {
      // fall through to error below
    }
  }
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(422).json({
      error: 'could not resolve location',
      message: `Couldn't turn "${loc}" into coordinates. Try "City, Province" or "lat,lng" instead.`,
    });
    return;
  }
  try {
    const { getCurrentWeather } = await import('../services/cloudCoverClient');
    const snap = await getCurrentWeather(lat, lng);
    res.json({
      location: loc,
      latitude: lat,
      longitude: lng,
      units: device.overlay_weather_units, // 'celsius' | 'fahrenheit'
      ...snap,
    });
  } catch (err) {
    res.status(502).json({ error: 'weather lookup failed', message: (err as Error).message });
  }
});

router.get('/:id/status', async (req, res) => {
  const device = await loadDevice(req);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const client = coexRegistry.get(connInfoFor(device));
  const status = await client.getStatus();
  await query(
    `UPDATE devices SET online = $2, last_seen_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [device.id, status.online],
  );
  // Auto-populate resolution when VNNOX returned it AND the device row's
  // dimensions are still NULL. Never overwrite admin-typed values — if
  // someone explicitly set 1920x1080 we trust their intent over whatever
  // VNNOX is reporting. The /pull-info endpoint below forces a refresh
  // when an admin wants to override.
  if (
    status.widthPx && status.heightPx &&
    (device.width_px == null || device.height_px == null)
  ) {
    await query(
      `UPDATE devices SET width_px = COALESCE(width_px, $2),
                          height_px = COALESCE(height_px, $3),
                          updated_at = NOW()
        WHERE id = $1`,
      [device.id, status.widthPx, status.heightPx],
    );
  }
  res.json(status);
});

/**
 * Force-refresh device metadata from VNNOX. Overwrites width_px/height_px
 * with what VNNOX is currently reporting. Use when admin knows the screen
 * was reconfigured and the stored values are wrong.
 */
router.post('/:id/pull-info', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const device = await loadDevice(req);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const client = coexRegistry.get(connInfoFor(device));
  const status = await client.getStatus();
  const updates: { widthPx?: number; heightPx?: number } = {};
  if (status.widthPx)  updates.widthPx  = status.widthPx;
  if (status.heightPx) updates.heightPx = status.heightPx;
  if (Object.keys(updates).length === 0) {
    // Soft response: not an error, just nothing to apply. The frontend
    // can render this as an info notice and the admin types the
    // resolution manually. Raw VNNOX shape lands in the Railway log via
    // vnnoxClient — share that with us if you want the auto-pull to
    // start working for this tier.
    res.json({
      device,
      pulled: {},
      notice: "VNNOX didn't return a resolution for this screen. Likely the API tier doesn't expose it. Type it in below; the rest of the app will use the manual values.",
    });
    return;
  }
  const { rows } = await query<DeviceRow>(
    `UPDATE devices SET width_px = $1, height_px = $2, updated_at = NOW()
      WHERE id = $3 RETURNING *`,
    [updates.widthPx ?? device.width_px, updates.heightPx ?? device.height_px, device.id],
  );
  res.json({ device: rows[0], pulled: updates });
});

const brightnessSchema = z.object({ brightness: z.number().int().min(0).max(100) });
router.post('/:id/brightness', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const { brightness } = brightnessSchema.parse(req.body);
  const device = await loadDevice(req);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const client = coexRegistry.get(connInfoFor(device));
  await client.setBrightness(brightness);
  // Mirror the scheduler's bookkeeping so the UI can show "Last applied".
  await query(
    `UPDATE devices SET last_applied_brightness = $1, last_applied_at = NOW(), updated_at = NOW() WHERE id = $2`,
    [brightness, device.id],
  );
  await writeLog('info', 'api', `brightness set to ${brightness}`, device.id, undefined, device.organization_id);
  res.json({ ok: true });
});

router.post('/:id/reboot', requireOrgRole('org_admin'), async (req, res) => {
  const device = await loadDevice(req);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const client = coexRegistry.get(connInfoFor(device));
  await client.reboot();
  await writeLog('warn', 'api', `device reboot triggered`, device.id, undefined, device.organization_id);
  res.json({ ok: true });
});

/**
 * Trigger a remote screenshot of what the player is currently showing. NovaStar
 * delivers the image asynchronously to the noticeUrl callback
 * (POST /api/public/vnnox-screenshot), which stores it on the device row. The
 * UI polls GET /:id/screenshot for the result. A nonce ties this request to its
 * callback so a stale/forged callback can't overwrite the stored image.
 */
router.post('/:id/screenshot', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const device = await loadDevice(req);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (device.provider !== 'vnnox') {
    res.status(400).json({ error: `screenshots require a vnnox device (this is "${device.provider}")` });
    return;
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  await query(`UPDATE devices SET screenshot_nonce = $1 WHERE id = $2`, [nonce, device.id]);
  const noticeUrl = `${config.publicBaseUrl}/api/public/vnnox-screenshot?d=${device.id}&n=${nonce}`;
  try {
    await requestScreenshot(device.device_key, noticeUrl);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[screenshot] capture request failed for ${device.name} (${device.id}):`, (err as Error).message);
    res.status(502).json({ error: (err as Error).message });
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`[screenshot] capture requested for ${device.name} (${device.id}); awaiting VNNOX callback`);
  await writeLog('info', 'api', 'screenshot requested', device.id, undefined, device.organization_id);
  res.json({ ok: true, requestedAt: new Date().toISOString() });
});

/** Latest screenshot delivered for this device (null until a capture arrives). */
router.get('/:id/screenshot', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const device = await loadDevice(req);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const { rows } = await query<{ last_screenshot_url: string | null; last_screenshot_at: string | null }>(
    `SELECT last_screenshot_url, last_screenshot_at FROM devices WHERE id = $1`,
    [device.id],
  );
  res.json({ url: rows[0]?.last_screenshot_url ?? null, at: rows[0]?.last_screenshot_at ?? null });
});

/**
 * Republish the device's base program (base playlist + clock/weather
 * overlays). Customer ad insertion programs are NOT touched. Returns the
 * VNNOX response so the admin can confirm.
 */
router.post('/:id/republish-base', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const device = await loadDevice(req);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  try {
    const result = await republishBaseProgram(device.id);
    await writeLog('info', 'api', 'base program republished', device.id, undefined, device.organization_id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: 'republish failed', message: (err as Error).message });
  }
});

router.post('/:id/stop', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const device = await loadDevice(req);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const client = coexRegistry.get(connInfoFor(device));
  await client.stop();
  res.json({ ok: true });
});

export default router;
