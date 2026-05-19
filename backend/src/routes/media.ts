import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import { query } from '../db';
import { authRequired, requireRole } from '../middleware/auth';
import { config } from '../config';

const router = Router();
router.use(authRequired);

const MEDIA_DIR = path.join('/app', 'media', 'uploads');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
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
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: string;
  duration_ms: number | null;
  width_px: number | null;
  height_px: number | null;
  checksum_sha256: string | null;
  storage_url: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

router.get('/', async (_req, res) => {
  const { rows } = await query<MediaRow>(`SELECT * FROM media ORDER BY created_at DESC`);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await query<MediaRow>(`SELECT * FROM media WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(rows[0]);
});

function sha256File(filepath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filepath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

router.post('/', requireRole('admin', 'operator'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'no file uploaded' });
    return;
  }
  const checksum = await sha256File(req.file.path);
  const publicUrl = `${config.mediaPublicBaseUrl}/uploads/${req.file.filename}`;
  const { rows } = await query<MediaRow>(
    `INSERT INTO media (filename, original_name, mime_type, size_bytes, checksum_sha256, storage_url)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, checksum, publicUrl],
  );
  res.status(201).json(rows[0]);
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { rows } = await query<MediaRow>(`SELECT * FROM media WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const media = rows[0];
  const filepath = path.join(MEDIA_DIR, media.filename);
  await query(`DELETE FROM media WHERE id = $1`, [req.params.id]);
  fs.promises.unlink(filepath).catch(() => undefined);
  res.status(204).end();
});

const updateSchema = z.object({
  metadata: z.record(z.unknown()).optional(),
  durationMs: z.number().int().positive().optional(),
  widthPx: z.number().int().positive().optional(),
  heightPx: z.number().int().positive().optional(),
});

router.patch('/:id', requireRole('admin', 'operator'), async (req, res) => {
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
  const { rows } = await query<MediaRow>(
    `UPDATE media SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values,
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(rows[0]);
});

export default router;
