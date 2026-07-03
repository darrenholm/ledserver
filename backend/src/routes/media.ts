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
import { buildTextSlideSvg, textSlideSchema } from '../services/textSlide';
import { ensureTaurusSafeVideo } from '../services/videoTranscode';

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

  // Per-media usage counts. playlist_items has ON DELETE RESTRICT so any non-
  // zero count there will block a delete; rentals.media_id is SET NULL so
  // we surface it as info but don't treat it as blocking.
  const ids = rows.map((m) => m.id);
  const usage = new Map<string, { playlist_items: number; rentals: number }>();
  if (ids.length > 0) {
    const playlistCounts = await query<{ media_id: string; n: string }>(
      `SELECT media_id, COUNT(*)::text AS n FROM playlist_items WHERE media_id = ANY($1) GROUP BY media_id`,
      [ids],
    );
    const rentalCounts = await query<{ media_id: string; n: string }>(
      `SELECT media_id, COUNT(*)::text AS n FROM rentals WHERE media_id = ANY($1) GROUP BY media_id`,
      [ids],
    );
    for (const r of playlistCounts.rows) {
      const u = usage.get(r.media_id) ?? { playlist_items: 0, rentals: 0 };
      u.playlist_items = Number(r.n);
      usage.set(r.media_id, u);
    }
    for (const r of rentalCounts.rows) {
      const u = usage.get(r.media_id) ?? { playlist_items: 0, rentals: 0 };
      u.rentals = Number(r.n);
      usage.set(r.media_id, u);
    }
  }
  const decorate = (m: MediaRow) => ({
    ...m,
    usage: usage.get(m.id) ?? { playlist_items: 0, rentals: 0 },
  });

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

  const checksumDupes = new Set<string>();
  const byChecksumOut = [...byChecksum.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([checksum, items]) => {
      items.forEach((m) => checksumDupes.add(m.id));
      return { checksum_sha256: checksum, count: items.length, items: items.map(decorate) };
    })
    .sort((a, b) => b.count - a.count);

  const byNameOut = [...byName.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([, items]) => ({
      original_name: items[0].original_name,
      count: items.length,
      items: items.map(decorate),
      items_with_checksum_match: items.filter((m) => checksumDupes.has(m.id)).map((m) => m.id),
    }))
    .filter((g) => g.items.length > g.items_with_checksum_match.length)
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
  // Auto-normalize videos to a Taurus-decodable encoding on the way in, so
  // clients never have to think about codecs/profiles/frame rate. Hashing +
  // sizing below then operate on the normalized file.
  if (req.file.mimetype.startsWith('video/')) {
    await ensureTaurusSafeVideo(req.file);
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

/**
 * Compose a text slide and store it as a media row. Same renderer the
 * customer-facing rental booking uses (services/textSlide.ts), so the
 * output is pixel-identical regardless of who creates it.
 *
 * Width/height default to 1920×1080 — a sensible "generic landscape"
 * canvas that resamples cleanly onto most LED panels. Admin can override
 * to match a specific screen (e.g. 240×120 ticker, 1024×1024 square)
 * by passing widthPx/heightPx.
 */
const textSlideBodySchema = textSlideSchema.extend({
  widthPx: z.number().int().min(64).max(7680).default(1920),
  heightPx: z.number().int().min(64).max(7680).default(1080),
  /** Optional display name; defaults to a snippet of the text. */
  name: z.string().max(160).optional(),
});

router.post('/text-slide', requireOrgRole('org_admin', 'org_operator'), async (req, res) => {
  const data = textSlideBodySchema.parse(req.body);
  const orgId = await orgForInsert(req);

  const svg = buildTextSlideSvg({
    text: data.text,
    textColor: data.textColor,
    bgColor: data.bgColor,
    fontFamily: data.fontFamily,
    widthPx: data.widthPx,
    heightPx: data.heightPx,
  });
  const id = crypto.randomUUID();
  const filename = `${id}.png`;
  const destPath = path.join(MEDIA_DIR, filename);
  await sharp(Buffer.from(svg)).png().toFile(destPath);
  const stat = await fs.promises.stat(destPath);
  const publicUrl = `${config.mediaPublicBaseUrl}/uploads/${filename}`;

  // Use a readable original_name so this row shows up legibly in the
  // media table — first 40 chars of the headline + .png.
  const snippet = (data.name || data.text).replace(/\s+/g, ' ').trim().slice(0, 40);
  const originalName = `${snippet || 'text-slide'}.png`;

  const { rows } = await query<MediaRow>(
    `INSERT INTO media (organization_id, filename, original_name, mime_type, size_bytes,
                        width_px, height_px, storage_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING *`,
    [
      orgId,
      filename,
      originalName,
      'image/png',
      stat.size,
      data.widthPx,
      data.heightPx,
      publicUrl,
      JSON.stringify({
        source: 'text-slide',
        text: data.text,
        textColor: data.textColor,
        bgColor: data.bgColor,
        fontFamily: data.fontFamily,
      }),
    ],
  );
  const media = rows[0];

  // Generate a thumbnail using the same path the upload route uses, so
  // text slides show up in playlists/contracts with previews like any
  // other media. Wrapped in try/catch since a thumb failure shouldn't
  // throw away a successful slide.
  try {
    const thumbnailUrl = await generateThumbnail(destPath, media.id);
    const updated = await query<MediaRow>(
      `UPDATE media SET thumbnail_url = $1 WHERE id = $2 RETURNING *`,
      [thumbnailUrl, media.id],
    );
    res.status(201).json(updated.rows[0]);
    return;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[media/text-slide] thumbnail generation failed for ${media.id}:`, err);
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

  // Pre-flight: playlist_items.media_id is ON DELETE RESTRICT, so deleting a
  // media row that's still on a playlist will fail with a vague FK error.
  // Surface it cleanly instead so the user knows what to clean up first.
  const blockers = await query<{ playlist_id: string; playlist_name: string }>(
    `SELECT DISTINCT pi.playlist_id, p.name AS playlist_name
       FROM playlist_items pi
       JOIN playlists p ON p.id = pi.playlist_id
      WHERE pi.media_id = $1`,
    [req.params.id],
  );
  if (blockers.rows.length > 0) {
    res.status(409).json({
      error: 'media is in use',
      message: `Still referenced by ${blockers.rows.length} playlist item${blockers.rows.length === 1 ? '' : 's'}. Remove from the playlist(s) first.`,
      playlists: blockers.rows,
    });
    return;
  }

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
