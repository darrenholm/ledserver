import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { authRequired, requireOrgRole } from '../middleware/auth';
import { coexRegistry } from '../coex/registry';
import { writeLog } from '../services/logs';
import { orgClause, orgForInsert } from '../services/scope';

const router = Router();
router.use(authRequired);

interface DeviceRow {
  id: string;
  organization_id: string;
  name: string;
  model: string | null;
  device_key: string;
  ip_address: string;
  port: number;
  location: string | null;
  width_px: number | null;
  height_px: number | null;
  last_seen_at: string | null;
  online: boolean;
  firmware: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const createSchema = z.object({
  name: z.string().min(1),
  deviceKey: z.string().min(1),
  ipAddress: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  model: z.string().optional(),
  location: z.string().optional(),
  widthPx: z.number().int().positive().optional(),
  heightPx: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSchema = createSchema.partial();

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
  const orgId = orgForInsert(req);
  const { rows } = await query<DeviceRow>(
    `INSERT INTO devices (organization_id, name, model, device_key, ip_address, port, location, width_px, height_px, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, '{}'::jsonb))
     RETURNING *`,
    [
      orgId,
      data.name,
      data.model ?? null,
      data.deviceKey,
      data.ipAddress,
      data.port ?? 5000,
      data.location ?? null,
      data.widthPx ?? null,
      data.heightPx ?? null,
      data.metadata ?? null,
    ],
  );
  await writeLog('info', 'api', `device registered: ${data.name}`, rows[0].id, { ipAddress: data.ipAddress }, orgId);
  res.status(201).json(rows[0]);
});

router.patch('/:id', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const data = updateSchema.parse(req.body);
  const fields: string[] = [];
  const values: unknown[] = [];
  const mapping: Record<string, keyof typeof data> = {
    name: 'name',
    model: 'model',
    device_key: 'deviceKey',
    ip_address: 'ipAddress',
    port: 'port',
    location: 'location',
    width_px: 'widthPx',
    height_px: 'heightPx',
    metadata: 'metadata',
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
  const client = coexRegistry.get({
    id: device.id,
    ipAddress: device.ip_address,
    port: device.port,
    deviceKey: device.device_key,
  });
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
  const client = coexRegistry.get({
    id: device.id,
    ipAddress: device.ip_address,
    port: device.port,
    deviceKey: device.device_key,
  });
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
  const client = coexRegistry.get({
    id: device.id,
    ipAddress: device.ip_address,
    port: device.port,
    deviceKey: device.device_key,
  });
  await client.setBrightness(brightness);
  await writeLog('info', 'api', `brightness set to ${brightness}`, device.id, undefined, device.organization_id);
  res.json({ ok: true });
});

router.post('/:id/reboot', requireOrgRole('org_admin'), async (req, res) => {
  const device = await loadDevice(req);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const client = coexRegistry.get({
    id: device.id,
    ipAddress: device.ip_address,
    port: device.port,
    deviceKey: device.device_key,
  });
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
  const client = coexRegistry.get({
    id: device.id,
    ipAddress: device.ip_address,
    port: device.port,
    deviceKey: device.device_key,
  });
  await client.stop();
  res.json({ ok: true });
});

export default router;
