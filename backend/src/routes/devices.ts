import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { authRequired, requireOrgRole } from '../middleware/auth';
import { coexRegistry, DeviceConnInfo, DeviceProvider } from '../coex/registry';
import { writeLog } from '../services/logs';
import { orgClause, orgForInsert } from '../services/scope';

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
  const orgId = orgForInsert(req);
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
  res.json(status);
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
