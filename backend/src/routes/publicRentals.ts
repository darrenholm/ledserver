import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import { query, withTx } from '../db';
import { config } from '../config';
import { probeArtwork } from '../services/artworkValidation';
import { newRentalEmail, sendEmail } from '../services/email';

/**
 * Public (no-auth) routes for the ad-rental marketplace.
 * Mounted at /api/public.
 */
const router = Router();

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
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^(image|video)\//.test(file.mimetype)) {
      cb(new Error(`unsupported file type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

// --- Schemas ---

const createRentalSchema = z.object({
  deviceId: z.string().uuid(),
  advertiserName: z.string().min(1).max(120),
  advertiserEmail: z.string().email(),
  advertiserPhone: z.string().max(40).optional(),
  advertiserBusiness: z.string().max(120).optional(),
  advertiserNotes: z.string().max(2000).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expect YYYY-MM-DD'),
  durationUnit: z.enum(['day', 'week', 'month']),
  durationCount: z.coerce.number().int().min(1).max(52),
});

// --- Listings ---

interface RentableDeviceRow {
  id: string;
  name: string;
  model: string | null;
  location: string | null;
  width_px: number | null;
  height_px: number | null;
  daily_rate: string | null;
  weekly_rate: string | null;
  monthly_rate: string | null;
  rental_currency: string;
  is_rentable: boolean;
}

router.get('/displays', async (_req, res) => {
  const { rows } = await query<RentableDeviceRow>(
    `SELECT id, name, model, location, width_px, height_px,
            daily_rate, weekly_rate, monthly_rate, rental_currency, is_rentable
       FROM devices
      WHERE is_rentable = TRUE
      ORDER BY name`,
  );
  res.json(rows);
});

router.get('/displays/:id', async (req, res) => {
  const { rows } = await query<RentableDeviceRow>(
    `SELECT id, name, model, location, width_px, height_px,
            daily_rate, weekly_rate, monthly_rate, rental_currency, is_rentable
       FROM devices
      WHERE id = $1 AND is_rentable = TRUE`,
    [req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Also surface booked windows so the client can disable conflicting dates.
  const booked = await query<{ start_date: string; end_date: string }>(
    `SELECT start_date, end_date FROM rentals
      WHERE device_id = $1 AND status IN ('pending_payment','pending_review','approved','active')
      ORDER BY start_date`,
    [req.params.id],
  );
  res.json({ ...rows[0], bookedWindows: booked.rows });
});

// --- Booking ---

function addDurationToDate(start: string, unit: 'day' | 'week' | 'month', count: number): string {
  const d = new Date(start + 'T00:00:00Z');
  if (unit === 'day') d.setUTCDate(d.getUTCDate() + count - 1);
  else if (unit === 'week') d.setUTCDate(d.getUTCDate() + count * 7 - 1);
  else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + count, d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function computeAmountCents(d: RentableDeviceRow, unit: 'day' | 'week' | 'month', count: number): number {
  const rateStr = unit === 'day' ? d.daily_rate : unit === 'week' ? d.weekly_rate : d.monthly_rate;
  if (!rateStr) {
    const err = new Error(`device has no ${unit} rate set`);
    (err as any).status = 400;
    throw err;
  }
  const rate = parseFloat(rateStr);
  if (!Number.isFinite(rate) || rate < 0) throw new Error(`invalid rate: ${rateStr}`);
  return Math.round(rate * 100) * count;
}

router.post('/rentals', async (req, res) => {
  const data = createRentalSchema.parse(req.body);
  const dev = await query<RentableDeviceRow>(
    `SELECT id, name, model, location, width_px, height_px,
            daily_rate, weekly_rate, monthly_rate, rental_currency, is_rentable
       FROM devices WHERE id = $1 AND is_rentable = TRUE`,
    [data.deviceId],
  );
  if (dev.rows.length === 0) {
    res.status(404).json({ error: 'display not rentable or not found' });
    return;
  }
  const d = dev.rows[0];
  const endDate = addDurationToDate(data.startDate, data.durationUnit, data.durationCount);
  const amountCents = computeAmountCents(d, data.durationUnit, data.durationCount);

  // Conflict check: any approved/active rental overlapping our window?
  const conflict = await query(
    `SELECT 1 FROM rentals
      WHERE device_id = $1
        AND status IN ('pending_payment','pending_review','approved','active')
        AND start_date <= $3::date
        AND end_date   >= $2::date
      LIMIT 1`,
    [data.deviceId, data.startDate, endDate],
  );
  if (conflict.rowCount > 0) {
    res.status(409).json({ error: 'requested window overlaps an existing booking' });
    return;
  }

  const { rows } = await query<{ id: string; approval_token: string }>(
    `INSERT INTO rentals (
        device_id, advertiser_name, advertiser_email, advertiser_phone,
        advertiser_business, advertiser_notes,
        start_date, end_date, duration_unit, duration_count,
        amount_cents, currency, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12, 'pending_payment')
      RETURNING id, approval_token`,
    [
      data.deviceId,
      data.advertiserName,
      data.advertiserEmail,
      data.advertiserPhone ?? null,
      data.advertiserBusiness ?? null,
      data.advertiserNotes ?? null,
      data.startDate,
      endDate,
      data.durationUnit,
      data.durationCount,
      amountCents,
      d.rental_currency,
    ],
  );

  res.status(201).json({
    id: rows[0].id,
    status: 'pending_payment',
    endDate,
    amountCents,
    currency: d.rental_currency,
    // Phase 1: no actual payment URL — admin will manually mark as paid.
    // Phase 2: replace with a QuickBooks Payments session URL.
    paymentInstructions: 'A Holm Graphics team member will contact you within one business day to take payment and confirm your booking.',
  });
});

// --- Artwork upload (after booking is created, before payment / review) ---

router.post('/rentals/:id/artwork', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'no file uploaded' });
    return;
  }

  // Look up rental + device for dimension targets.
  const r = await query<{
    rental_id: string;
    device_id: string;
    status: string;
    advertiser_email: string;
    width_px: number | null;
    height_px: number | null;
    organization_id: string;
  }>(
    `SELECT r.id AS rental_id, r.device_id, r.status, r.advertiser_email,
            d.width_px, d.height_px, d.organization_id
       FROM rentals r JOIN devices d ON d.id = r.device_id
      WHERE r.id = $1`,
    [req.params.id],
  );
  if (r.rows.length === 0) {
    fs.promises.unlink(req.file.path).catch(() => undefined);
    res.status(404).json({ error: 'rental not found' });
    return;
  }
  const rental = r.rows[0];
  if (!['pending_payment', 'pending_review'].includes(rental.status)) {
    fs.promises.unlink(req.file.path).catch(() => undefined);
    res.status(409).json({ error: `rental is ${rental.status}; artwork can only be uploaded before approval` });
    return;
  }

  const probe = await probeArtwork(req.file.path, {
    targetWidth: rental.width_px,
    targetHeight: rental.height_px,
    mimeType: req.file.mimetype,
  });

  const publicUrl = `${config.mediaPublicBaseUrl}/uploads/${req.file.filename}`;

  // Create the media row (no auth context, so we attach it to the device's org).
  const media = await query<{ id: string }>(
    `INSERT INTO media (organization_id, filename, original_name, mime_type, size_bytes,
                        width_px, height_px, storage_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      rental.organization_id,
      req.file.filename,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      probe.widthPx,
      probe.heightPx,
      publicUrl,
      JSON.stringify({ source: 'rental', rentalId: rental.rental_id }),
    ],
  );

  await query(
    `UPDATE rentals
        SET media_id = $1,
            artwork_warnings = $2::jsonb,
            updated_at = NOW()
      WHERE id = $3`,
    [media.rows[0].id, JSON.stringify(probe.warnings), rental.rental_id],
  );

  res.json({
    ok: true,
    mediaId: media.rows[0].id,
    warnings: probe.warnings,
    dimensions: probe.widthPx && probe.heightPx ? { width: probe.widthPx, height: probe.heightPx } : null,
    artworkUrl: publicUrl,
  });
});

// --- Status (renter-facing) ---

router.get('/rentals/:id', async (req, res) => {
  const { rows } = await query<{
    id: string;
    status: string;
    advertiser_name: string;
    advertiser_email: string;
    start_date: string;
    end_date: string;
    amount_cents: number;
    currency: string;
    artwork_warnings: string[];
    paid_at: string | null;
    review_notes: string | null;
    device_name: string;
    storage_url: string | null;
  }>(
    `SELECT r.id, r.status, r.advertiser_name, r.advertiser_email,
            r.start_date, r.end_date, r.amount_cents, r.currency,
            r.artwork_warnings, r.paid_at, r.review_notes,
            d.name AS device_name,
            m.storage_url
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN media m ON m.id = r.media_id
      WHERE r.id = $1`,
    [req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(rows[0]);
});

// Helper used by admin email links — see admin route file.
export async function sendNewRentalNotification(rentalId: string): Promise<void> {
  const { rows } = await query<{
    rental_id: string;
    approval_token: string;
    advertiser_name: string;
    advertiser_email: string;
    advertiser_business: string | null;
    advertiser_notes: string | null;
    start_date: string;
    end_date: string;
    amount_cents: number;
    currency: string;
    artwork_warnings: string[];
    storage_url: string | null;
    device_name: string;
    device_location: string | null;
  }>(
    `SELECT r.id AS rental_id, r.approval_token, r.advertiser_name, r.advertiser_email,
            r.advertiser_business, r.advertiser_notes, r.start_date, r.end_date,
            r.amount_cents, r.currency, r.artwork_warnings,
            m.storage_url, d.name AS device_name, d.location AS device_location
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN media m ON m.id = r.media_id
      WHERE r.id = $1`,
    [rentalId],
  );
  if (rows.length === 0) return;
  const r = rows[0];
  const formatter = new Intl.NumberFormat('en-CA', { style: 'currency', currency: r.currency });
  const tmpl = newRentalEmail({
    rentalId: r.rental_id,
    approvalToken: r.approval_token,
    advertiserName: r.advertiser_name,
    advertiserEmail: r.advertiser_email,
    advertiserBusiness: r.advertiser_business,
    advertiserNotes: r.advertiser_notes,
    deviceName: r.device_name,
    deviceLocation: r.device_location,
    startDate: r.start_date,
    endDate: r.end_date,
    amountFormatted: formatter.format(r.amount_cents / 100),
    artworkPreviewUrl: r.storage_url,
    artworkWarnings: r.artwork_warnings ?? [],
  });
  await sendEmail({
    to: config.email.adminAddress,
    subject: tmpl.subject,
    html: tmpl.html,
    text: tmpl.text,
    replyTo: r.advertiser_email,
  });
}

export { withTx };
export default router;
