import { Router } from 'express';
import { z } from 'zod';
import { query, withTx } from '../db';
import { authRequired, requireRole } from '../middleware/auth';
import { coexRegistry } from '../coex/registry';
import { writeLog } from '../services/logs';
import { PlaylistManifest } from '../coex/types';

const router = Router();
router.use(authRequired);

interface PlaylistRow {
  id: string;
  name: string;
  description: string | null;
  loop: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface PlaylistItemRow {
  id: string;
  playlist_id: string;
  media_id: string;
  position: number;
  duration_ms: number;
  transition: string;
}

const itemSchema = z.object({
  mediaId: z.string().uuid(),
  durationMs: z.number().int().positive().optional(),
  transition: z.string().optional(),
});

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  loop: z.boolean().optional(),
  items: z.array(itemSchema).default([]),
  metadata: z.record(z.unknown()).optional(),
});

const updateSchema = createSchema.partial();

router.get('/', async (_req, res) => {
  const { rows } = await query<PlaylistRow>(`SELECT * FROM playlists ORDER BY updated_at DESC`);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const playlist = await query<PlaylistRow>(`SELECT * FROM playlists WHERE id = $1`, [req.params.id]);
  if (playlist.rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const items = await query<PlaylistItemRow>(
    `SELECT * FROM playlist_items WHERE playlist_id = $1 ORDER BY position`,
    [req.params.id],
  );
  res.json({ ...playlist.rows[0], items: items.rows });
});

router.post('/', requireRole('admin', 'operator'), async (req, res) => {
  const data = createSchema.parse(req.body);
  const created = await withTx(async (client) => {
    const pl = await client.query<PlaylistRow>(
      `INSERT INTO playlists (name, description, loop, metadata)
       VALUES ($1, $2, COALESCE($3, TRUE), COALESCE($4, '{}'::jsonb)) RETURNING *`,
      [data.name, data.description ?? null, data.loop ?? null, data.metadata ?? null],
    );
    const playlist = pl.rows[0];
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      await client.query(
        `INSERT INTO playlist_items (playlist_id, media_id, position, duration_ms, transition)
         VALUES ($1, $2, $3, COALESCE($4, 10000), COALESCE($5, 'cut'))`,
        [playlist.id, item.mediaId, i, item.durationMs ?? null, item.transition ?? null],
      );
    }
    return playlist;
  });
  res.status(201).json(created);
});

router.patch('/:id', requireRole('admin', 'operator'), async (req, res) => {
  const data = updateSchema.parse(req.body);
  const updated = await withTx(async (client) => {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (data.name !== undefined) { fields.push(`name = $${i++}`); values.push(data.name); }
    if (data.description !== undefined) { fields.push(`description = $${i++}`); values.push(data.description); }
    if (data.loop !== undefined) { fields.push(`loop = $${i++}`); values.push(data.loop); }
    if (data.metadata !== undefined) { fields.push(`metadata = $${i++}`); values.push(data.metadata); }
    if (fields.length > 0) {
      fields.push(`updated_at = NOW()`);
      values.push(req.params.id);
      const r = await client.query<PlaylistRow>(
        `UPDATE playlists SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
        values,
      );
      if (r.rows.length === 0) return null;
    }
    if (data.items !== undefined) {
      await client.query(`DELETE FROM playlist_items WHERE playlist_id = $1`, [req.params.id]);
      for (let idx = 0; idx < data.items.length; idx++) {
        const item = data.items[idx];
        await client.query(
          `INSERT INTO playlist_items (playlist_id, media_id, position, duration_ms, transition)
           VALUES ($1, $2, $3, COALESCE($4, 10000), COALESCE($5, 'cut'))`,
          [req.params.id, item.mediaId, idx, item.durationMs ?? null, item.transition ?? null],
        );
      }
    }
    const r = await client.query<PlaylistRow>(`SELECT * FROM playlists WHERE id = $1`, [req.params.id]);
    return r.rows[0] ?? null;
  });
  if (!updated) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(updated);
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { rowCount } = await query(`DELETE FROM playlists WHERE id = $1`, [req.params.id]);
  if (rowCount === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(204).end();
});

// --- Deploy / play on a device ---

const deploySchema = z.object({ deviceId: z.string().uuid() });

interface DeployRow {
  pl_id: string;
  pl_loop: boolean;
  media_id: string;
  storage_url: string;
  mime_type: string;
  duration_ms: number;
  checksum_sha256: string | null;
  ip_address: string;
  port: number;
  device_key: string;
}

router.post('/:id/deploy', requireRole('admin', 'operator'), async (req, res) => {
  const { deviceId } = deploySchema.parse(req.body);
  const { rows } = await query<DeployRow>(
    `SELECT
        p.id AS pl_id,
        p.loop AS pl_loop,
        m.id AS media_id,
        m.storage_url,
        m.mime_type,
        pi.duration_ms,
        m.checksum_sha256,
        d.ip_address,
        d.port,
        d.device_key
     FROM playlists p
     JOIN playlist_items pi ON pi.playlist_id = p.id
     JOIN media m ON m.id = pi.media_id
     CROSS JOIN devices d
     WHERE p.id = $1 AND d.id = $2
     ORDER BY pi.position`,
    [req.params.id, deviceId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'playlist, device, or items not found' });
    return;
  }
  const first = rows[0];
  const manifest: PlaylistManifest = {
    playlistId: first.pl_id,
    loop: first.pl_loop,
    items: rows.map((r) => ({
      mediaId: r.media_id,
      url: r.storage_url,
      mimeType: r.mime_type,
      durationMs: r.duration_ms,
      checksumSha256: r.checksum_sha256 ?? undefined,
    })),
  };
  const client = coexRegistry.get({
    id: deviceId,
    ipAddress: first.ip_address,
    port: first.port,
    deviceKey: first.device_key,
  });
  await client.pushPlaylist(manifest);
  await client.play(manifest.playlistId);
  await query(
    `INSERT INTO device_playlists (device_id, playlist_id) VALUES ($1, $2)
     ON CONFLICT (device_id, playlist_id) DO UPDATE SET assigned_at = NOW()`,
    [deviceId, manifest.playlistId],
  );
  await writeLog('info', 'api', `playlist deployed`, deviceId, { playlistId: manifest.playlistId, items: manifest.items.length });
  res.json({ ok: true, manifest });
});

export default router;
