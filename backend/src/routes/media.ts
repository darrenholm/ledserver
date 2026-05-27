import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { query } from '../db';
import { authRequired, requireOrgRole } from '../middleware/auth';
import { orgClause, orgForInsert } from '../services/scope';
import { config } from '../config';

const router = Router();
router.use(authRequired);

const MEDIA_DIR = path.join('/app', 'media', 'uploads');
const THUMB_DIR = path.join(MEDIA_DIR, 'thumbnails');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

const THUMB_SIZE = 240;

function isThumbnailable(mimeType: string): boolean {
  // Sharp handles raster images and the first frame of GIFs/WEBPs.
  return mimeType.startsWith('image/');
}

/**
 * Generate a 240px webp thumbnail from a source image file. Returns the
 * public URL of the thumbnail. Throws on Sharp errors so the upload route
 * can decide whether to fail the whole upload or just skip the thumb.
 */
async function generateThumbnail(srcPath: string, mediaId: string): Promise<string> {
  const thumbFile = `${mediaId}.webp`;
  const thumbPath = path.join(THUMB_DIR, thumbFile);
  await sharp(srcPath)
    .rotate() // honor EXIF orientation
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(thumbPath);
  return `${config.mediaPublicBaseUrl}/uploads/thumbnails/${thumbFile}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
  filename: (_req, file, cb) => {
    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname);
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^(image|video|audio)\//;
    if (!allowed.test(file.mimetype)) {
      cb(new Error(`unsupported mime type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

interface MediaRow {
  id: string;
  organization_id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: string;
  duration_ms: number | null;
  width_px: number | null;
  height_px: number | null;
  checksum_sha256: string | null;
  checksum_md5: string | null;
  storage_url: string;
  thumbnail_url: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

router.get('/', async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 1);
  const { rows } = await query<MediaRow>(
    `SELECT * FROM media WHERE 1=1 ${clause} ORDER BY created_at DESC`,
    params,
  );
  res.json(rows);
});

/**
 * Surface probable duplicate uploads so admins can clean them up. Two flavours:
 *
 *   - byChecksum: rows that share an identical sha256. These are bit-for-bit
 *     duplicates — same file uploaded twice. Always safe to dedupe (keep the
 *     one that's actually referenced by a playlist/rental; delete the rest).
 *
 *   - byName: rows that share the same original_name but different checksums.
 *     Usually means someone re-exported the artwork (different bytes) and
 *     uploaded under the same filename — which is exactly how the
 *     "Coldwell05042026.png" / "Mortgage Centre" confusion arose: the playlist
 *     is pointing at the *old* upload, the rental at the *new* one, and they
 *     look identical to a human. Needs human eyeballs because the bytes
 *     genuinely differ; the UI shows thumbnails side by side.
 *
 * Both groupings exclude singletons. Sorted by group size descending so the
 * worst offenders bubble up.
 */
router.get('/duplicates', async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 1);
  const { rows } = await query<MediaRow>(
    `SELECT * FROM media WHERE 1=1 ${clause} ORDER BY created_at DESC`,
    params,
  );

  const byChecksum = new Map<string, MediaRow[]>();
  const byName = new Map<string, MediaRow[]>();
  for (const m of rows) {
    if (m.checksum_sha256) {
      const arr = byChecksum.get(m.checksum_sha256) ?? [];
      arr.push(m);
      byChecksum.set(m.checksum_sha256, arr);
    }
    const nameKey = (m.original_name ?? '').trim().toLowerCase();
    if (nameKey) {
      const arr = byName.get(nameKey) ?? [];
      arr.push(m);
      byName.set(nameKey, arr);
    }
  }

  // Drop singletons. For byName, also drop the cluster if every row in it is
  // already covered by a byChecksum group — no need to double-report.
  const checksumDupes = new Set<string>();
  const byChecksumOut = [...byChecksum.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([checksum, items]) => {
      items.forEach((m) => checksumDupes.add(m.id));
      return { checksum_sha256: checksum, count: items.length, items };
    })
    .sort((a, b) => b.count - a.count);

  const byNameOut = [...byName.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([name, items]) => ({
      original_name: items[0].original_name,
      count: items.length,
      items,
      // Tag rows that are *also* in a checksum group; UI can show "exact match"
      // separately from "same name, different bytes".
      items_with_checksum_match: items.filter((m) => checksumDupes.has(m.id)).map((m) => m.id),
    }))
    .filter((g) => g.items.length > g.items_with_checksum_match.length) // skip if fully covered
    .sort((a, b) => b.count - a.count);

  res.json({ byChecksum: byChecksumOut, byName: byNameOut });
});

router.get('/:id', async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 2);
  const { rows } = await query<MediaRow>(
    `SELECT * FROM media WHERE id = $1 ${clause}`,
    [req.params.id, ...params],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(rows[0]);
});

function hashFile(filepath: string): Promise<{ sha256: string; md5: string }> {
  return new Promise((resolve, reject) => {
    const sha = crypto.createHash('sha256');
    const md = crypto.createHash('md5');
    const stream = fs.createReadStream(filepath);
    stream.on('data', (chunk) => { sha.update(chunk); md.update(chunk); });
    stream.on('end', () => resolve({ sha256: sha.digest('hex'), md5: md.digest('hex') }));
    stream.on('error', reject);
  });
}

router.post('/', requireOrgRole('org_admin', 'org_operator'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'no file uploaded' });
    return;
  }
  const orgId = await orgForInsert(req);
  const { sha256, md5 } = await hashFile(req.file.path);
  const publicUrl = `${config.mediaPublicBaseUrl}/uploads/${req.file.filename}`;

  // Insert first so we have the media id to base the thumbnail filename on.
  const { rows } = await query<MediaRow>(
    `INSERT INTO media (organization_id, filename, original_name, mime_type, size_bytes, checksum_sha256, checksum_md5, storage_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [orgId, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, sha256, md5, publicUrl],
  );
  const media = rows[0];

  if (isThumbnailable(media.mime_type)) {
    try {
      const thumbnailUrl = await generateThumbnail(req.file.path, media.id);
      const updated = await query<MediaRow>(
        `UPDATE media SET thumbnail_url = $1 WHERE id = $2 RETURNING *`,
        [thumbnailUrl, media.id],
      );
      res.status(201).json(updated.rows[0]);
      return;
    } catch (err) {
      // Don't fail the upload over a thumbnail issue — log and return the row
      // without one. The frontend will fall back to the original.
      // eslint-disable-next-line no-console
      console.error(`[media] thumbnail generation failed for ${media.id}:`, err);
    }
  }
  res.status(201).json(media);
});

router.delete('/:id', requireOrgRole('org_admin'), async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 2);
  const { rows } = await query<MediaRow>(
    `SELECT * FROM media WHERE id = $1 ${clause}`,
    [req.params.id, ...params],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const media = rows[0];
  const filepath = path.join(MEDIA_DIR, media.filename);
  const thumbPath = path.join(THUMB_DIR, `${media.id}.webp`);
  await query(`DELETE FROM media WHERE id = $1`, [req.params.id]);
  fs.promises.unlink(filepath).catch(() => undefined);
  fs.promises.unlink(thumbPath).catch(() => undefined);
  res.status(204).end();
});

/**
 * One-shot thumbnail backfill for image rows that pre-date thumbnail support.
 * Skips rows that already have a thumbnail or whose source file is missing,
 * so it's safe to re-run. Returns a small summary so the UI can show progress.
 */
router.post('/backfill-thumbnails', requireOrgRole('org_admin'), async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 1);
  const { rows } = await query<MediaRow>(
    `SELECT * FROM media WHERE thumbnail_url IS NULL AND mime_type LIKE 'image/%' ${clause}`,
    params,
  );

  let generated = 0;
  let skipped = 0;
  const errors: { id: string; message: string }[] = [];

  for (const m of rows) {
    const srcPath = path.join(MEDIA_DIR, m.filename);
    if (!fs.existsSync(srcPath)) {
      skipped++;
      continue;
    }
    try {
      const thumbnailUrl = await generateThumbnail(srcPath, m.id);
      await query(`UPDATE media SET thumbnail_url = $1 WHERE id = $2`, [thumbnailUrl, m.id]);
      generated++;
    } catch (err) {
      errors.push({ id: m.id, message: (err as Error).message });
    }
  }

  res.json({ candidates: rows.length, generated, skipped, errors });
});

const updateSchema = z.object({
  metadata: z.record(z.unknown()).optional(),
  durationMs: z.number().int().positive().optional(),
  widthPx: z.number().int().positive().optional(),
  heightPx: z.number().int().positive().optional(),
});

router.patch('/:id', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const data = updateSchema.parse(req.body);
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (data.metadata !== undefined) { fields.push(`metadata = $${i++}`); values.push(data.metadata); }
  if (data.durationMs !== undefined) { fields.push(`duration_ms = $${i++}`); values.push(data.durationMs); }
  if (data.widthPx !== undefined) { fields.push(`width_px = $${i++}`); values.push(data.widthPx); }
  if (data.heightPx !== undefined) { fields.push(`height_px = $${i++}`); values.push(data.heightPx); }
  if (fields.length === 0) {
    res.status(400).json({ error: 'no fields to update' });
    return;
  }
  values.push(req.params.id);
  const idIdx = i;
  i++;
  const { clause, params: scopeParams } = orgClause(req, 'organization_id', i);
  const { rows } = await query<MediaRow>(
    `UPDATE media SET ${fields.join(', ')} WHERE id = $${idIdx} ${clause} RETURNING *`,
    [...values, ...scopeParams],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(rows[0]);
});

export default router;
