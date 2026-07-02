import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { query, withTx } from '../db';
import { authRequired, requireOrgRole } from '../middleware/auth';
import { coexRegistry } from '../coex/registry';
import { writeLog } from '../services/logs';
import { orgClause, orgForInsert } from '../services/scope';
import { PlaylistManifest, CoexError } from '../coex/types';
import { probeVideoFromUrl, VideoMeta } from '../services/videoProbe';

// VNNOX widget payloads need lowercase MD5. We fetch the file from its
// storage_url (the same URL VNNOX itself will download from) so this
// works regardless of whether media lives on a local volume, S3, or a
// CDN — and if the URL isn't reachable, we surface a clear error
// instead of failing the deploy with an opaque 500.
async function md5FromUrl(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new CoexError(
      `media unreachable at ${url}: ${(err as Error).message}. Check MEDIA_PUBLIC_BASE_URL and that the file still exists.`,
      'UNREACHABLE',
      err,
    );
  }
  if (!res.ok) {
    throw new CoexError(
      `media unreachable at ${url} (HTTP ${res.status}). The file may have been lost on container redeploy, or MEDIA_PUBLIC_BASE_URL is misconfigured.`,
      'UNREACHABLE',
    );
  }
  if (!res.body) {
    throw new CoexError(`media fetch returned empty body for ${url}`, 'UNREACHABLE');
  }
  const hash = crypto.createHash('md5');
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

const router = Router();
router.use(authRequired);

interface PlaylistRow {
  id: string;
  organization_id: string;
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

interface ThumbnailRow {
  playlist_id: string;
  position: number;
  storage_url: string;
  thumbnail_url: string | null;
  mime_type: string;
}

const THUMBS_PER_PLAYLIST = 4;

router.get('/', async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 1);
  const { rows } = await query<PlaylistRow>(
    `SELECT * FROM playlists WHERE 1=1 ${clause} ORDER BY updated_at DESC`,
    params,
  );

  // Batch-fetch a few preview items per playlist so the list view can show
  // thumbnails without N+1 queries. Pulls all items for the listed playlists
  // and trims to THUMBS_PER_PLAYLIST per id on the JS side.
  let thumbsByPlaylist = new Map<string, { storage_url: string; thumbnail_url: string | null; mime_type: string }[]>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const { rows: tRows } = await query<ThumbnailRow>(
      `SELECT pi.playlist_id, pi.position, m.storage_url, m.thumbnail_url, m.mime_type
         FROM playlist_items pi
         JOIN media m ON m.id = pi.media_id
        WHERE pi.playlist_id = ANY($1::uuid[])
        ORDER BY pi.playlist_id, pi.position`,
      [ids],
    );
    for (const t of tRows) {
      const arr = thumbsByPlaylist.get(t.playlist_id) ?? [];
      if (arr.length < THUMBS_PER_PLAYLIST) {
        arr.push({ storage_url: t.storage_url, thumbnail_url: t.thumbnail_url, mime_type: t.mime_type });
      }
      thumbsByPlaylist.set(t.playlist_id, arr);
    }
  }

  res.json(
    rows.map((r) => ({
      ...r,
      thumbnails: thumbsByPlaylist.get(r.id) ?? [],
    })),
  );
});

router.get('/:id', async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 2);
  const playlist = await query<PlaylistRow>(
    `SELECT * FROM playlists WHERE id = $1 ${clause}`,
    [req.params.id, ...params],
  );
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

router.post('/', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const data = createSchema.parse(req.body);
  const orgId = await orgForInsert(req);
  const created = await withTx(async (client) => {
    // Validate all referenced media belong to the same org.
    if (data.items.length > 0) {
      const ids = data.items.map((i) => i.mediaId);
      const mediaCheck = await client.query<{ id: string }>(
        `SELECT id FROM media WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
        [ids, orgId],
      );
      if (mediaCheck.rows.length !== new Set(ids).size) {
        const err = new Error('one or more media items not found in this organization');
        (err as any).status = 400;
        throw err;
      }
    }
    const pl = await client.query<PlaylistRow>(
      `INSERT INTO playlists (organization_id, name, description, loop, metadata)
       VALUES ($1, $2, $3, COALESCE($4, TRUE), COALESCE($5, '{}'::jsonb)) RETURNING *`,
      [orgId, data.name, data.description ?? null, data.loop ?? null, data.metadata ?? null],
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

router.patch('/:id', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const data = updateSchema.parse(req.body);
  const updated = await withTx(async (client) => {
    // First confirm the playlist belongs to scoped org.
    const scope = req.orgScope;
    const exists = scope
      ? await client.query<{ id: string }>(`SELECT id FROM playlists WHERE id = $1 AND organization_id = $2`, [req.params.id, scope])
      : await client.query<{ id: string }>(`SELECT id FROM playlists WHERE id = $1`, [req.params.id]);
    if (exists.rows.length === 0) return null;

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
      await client.query(`UPDATE playlists SET ${fields.join(', ')} WHERE id = $${i}`, values);
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

router.delete('/:id', requireOrgRole('org_admin'), async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 2);
  const { rowCount } = await query(
    `DELETE FROM playlists WHERE id = $1 ${clause}`,
    [req.params.id, ...params],
  );
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
  pl_org_id: string;
  pl_loop: boolean;
  media_id: string;
  storage_url: string;
  mime_type: string;
  duration_ms: number;
  size_bytes: string;
  checksum_sha256: string | null;
  checksum_md5: string | null;
  media_width_px: number | null;
  media_height_px: number | null;
  d_org_id: string;
  d_provider: 'vnnox' | 'lan_direct' | 'mock';
  ip_address: string | null;
  port: number;
  device_key: string;
  d_width_px: number | null;
  d_height_px: number | null;
}

router.post('/:id/deploy', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const { deviceId } = deploySchema.parse(req.body);
  const scope = req.orgScope;
  const scopeFilter = scope ? `AND p.organization_id = $3 AND d.organization_id = $3` : '';
  const { rows } = await query<DeployRow>(
    `SELECT
        p.id AS pl_id,
        p.organization_id AS pl_org_id,
        p.loop AS pl_loop,
        m.id AS media_id,
        m.storage_url,
        m.mime_type,
        pi.duration_ms,
        m.size_bytes,
        m.checksum_sha256,
        m.checksum_md5,
        m.width_px  AS media_width_px,
        m.height_px AS media_height_px,
        d.organization_id AS d_org_id,
        d.provider AS d_provider,
        d.ip_address,
        d.port,
        d.device_key,
        d.width_px  AS d_width_px,
        d.height_px AS d_height_px
     FROM playlists p
     JOIN playlist_items pi ON pi.playlist_id = p.id
     JOIN media m ON m.id = pi.media_id
     CROSS JOIN devices d
     WHERE p.id = $1 AND d.id = $2 ${scopeFilter}
     ORDER BY pi.position`,
    scope ? [req.params.id, deviceId, scope] : [req.params.id, deviceId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'playlist, device, or items not found' });
    return;
  }
  const first = rows[0];
  // Cross-org deploy guard (shouldn't happen given the scopeFilter, but belt + suspenders).
  if (first.pl_org_id !== first.d_org_id) {
    res.status(403).json({ error: 'playlist and device belong to different organizations' });
    return;
  }
  // VNNOX widget payloads require lowercase MD5. Backfill any media row missing it
  // by fetching from storage_url, then persist so we only ever do this once per row.
  const videoMeta = new Map<string, VideoMeta>();
  if (first.d_provider === 'vnnox') {
    for (const r of rows) {
      if (!r.checksum_md5) {
        const md5 = await md5FromUrl(r.storage_url);
        r.checksum_md5 = md5;
        await query(`UPDATE media SET checksum_md5 = $1 WHERE id = $2`, [md5, r.media_id]);
      }
      // VNNOX VIDEO widgets need codec/fps/dimensions or the Taurus shows a
      // frozen frame. Probe video items (cached by md5) and persist the pixel
      // dimensions we learn so the media row is progressively backfilled.
      if (r.mime_type?.startsWith('video/')) {
        const meta = await probeVideoFromUrl(r.storage_url, r.checksum_md5 ?? undefined);
        if (meta) {
          videoMeta.set(r.media_id, meta);
          if (!r.media_width_px || !r.media_height_px) {
            r.media_width_px = meta.widthPx;
            r.media_height_px = meta.heightPx;
            await query(
              `UPDATE media SET width_px = $1, height_px = $2 WHERE id = $3`,
              [meta.widthPx, meta.heightPx, r.media_id],
            );
          }
        }
      }
    }
  }

  const manifest: PlaylistManifest = {
    playlistId: first.pl_id,
    loop: first.pl_loop,
    deviceWidthPx: first.d_width_px ?? undefined,
    deviceHeightPx: first.d_height_px ?? undefined,
    items: rows.map((r) => {
      const vm = videoMeta.get(r.media_id);
      return {
        mediaId: r.media_id,
        url: r.storage_url,
        mimeType: r.mime_type,
        durationMs: r.duration_ms,
        sizeBytes: Number(r.size_bytes),
        checksumSha256: r.checksum_sha256 ?? undefined,
        checksumMd5: r.checksum_md5 ?? undefined,
        widthPx: vm?.widthPx ?? r.media_width_px ?? undefined,
        heightPx: vm?.heightPx ?? r.media_height_px ?? undefined,
        fps: vm?.fps,
        codec: vm?.codec,
        byteRateKbps: vm?.byteRateKbps,
      };
    }),
  };
  const client = coexRegistry.get({
    id: deviceId,
    provider: first.d_provider,
    deviceKey: first.device_key,
    ipAddress: first.ip_address ?? undefined,
    port: first.port,
  });
  await client.pushPlaylist(manifest);
  await client.play(manifest.playlistId);
  await query(
    `INSERT INTO device_playlists (device_id, playlist_id) VALUES ($1, $2)
     ON CONFLICT (device_id, playlist_id) DO UPDATE SET assigned_at = NOW()`,
    [deviceId, manifest.playlistId],
  );
  await writeLog(
    'info',
    'api',
    `playlist deployed`,
    deviceId,
    { playlistId: manifest.playlistId, items: manifest.items.length },
    first.d_org_id,
  );
  res.json({ ok: true, manifest });
});

export default router;
