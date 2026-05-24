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
import {
  chargeViaShopApi,
  createProjectViaShopApi,
  ShopApiError,
  upsertClientViaShopApi,
} from '../services/shopApiClient';

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
  durationUnit: z.enum(['day', 'week', 'month']),
  durationCount: z.coerce.number().int().min(1).max(52),
});

function durationInDays(unit: 'day' | 'week' | 'month', count: number): number {
  if (unit === 'day')   return count;
  if (unit === 'week')  return count * 7;
  if (unit === 'month') return count * 30;
  return count;
}

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
  latitude: string | null;
  longitude: string | null;
  photos: string[];
  traffic_stat: string | null;
  description: string | null;
}

const DISPLAY_SELECT = `id, name, model, location, width_px, height_px,
            daily_rate, weekly_rate, monthly_rate, rental_currency, is_rentable,
            latitude, longitude, photos, traffic_stat, description`;

router.get('/displays', async (_req, res) => {
  const { rows } = await query<RentableDeviceRow>(
    `SELECT ${DISPLAY_SELECT}
       FROM devices
      WHERE is_rentable = TRUE
      ORDER BY name`,
  );
  res.json(rows);
});

router.get('/displays/:id', async (req, res) => {
  const { rows } = await query<RentableDeviceRow>(
    `SELECT ${DISPLAY_SELECT}
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
  const amountCents = computeAmountCents(d, data.durationUnit, data.durationCount);
  const days = durationInDays(data.durationUnit, data.durationCount);

  // No conflict check at booking — we don't know the run window until
  // Holm Graphics approves and schedules it. The admin approval flow
  // surfaces the device's currently-booked-through date so they can
  // pick a sane start_date.

  const { rows } = await query<{ id: string; approval_token: string }>(
    `INSERT INTO rentals (
        device_id, advertiser_name, advertiser_email, advertiser_phone,
        advertiser_business, advertiser_notes,
        duration_unit, duration_count, duration_days,
        amount_cents, currency, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending_payment')
      RETURNING id, approval_token`,
    [
      data.deviceId,
      data.advertiserName,
      data.advertiserEmail,
      data.advertiserPhone ?? null,
      data.advertiserBusiness ?? null,
      data.advertiserNotes ?? null,
      data.durationUnit,
      data.durationCount,
      days,
      amountCents,
      d.rental_currency,
    ],
  );

  res.status(201).json({
    id: rows[0].id,
    status: 'pending_payment',
    durationDays: days,
    amountCents,
    currency: d.rental_currency,
    paymentInstructions:
      'Your run window will be scheduled by Holm Graphics once your artwork is approved. The clock starts on the day your ad goes live.',
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

// --- Payment (charges card via shop-api bridge) ---

const paySchema = z.object({
  token: z.string().min(8).max(200),
  /** Card metadata returned by tokenize, stored on the rental for the renter's reference. */
  cardBrand: z.string().max(40).optional(),
  cardLast4: z.string().max(8).optional(),
});

router.post('/rentals/:id/pay', async (req, res) => {
  const data = paySchema.parse(req.body);
  const { rows } = await query<{
    id: string;
    status: string;
    amount_cents: number;
    currency: string;
    advertiser_email: string;
    advertiser_name: string;
    advertiser_business: string | null;
    advertiser_phone: string | null;
    device_name: string;
    paid_at: string | null;
  }>(
    `SELECT r.id, r.status, r.amount_cents, r.currency, r.advertiser_email,
            r.advertiser_name, r.advertiser_business, r.advertiser_phone,
            r.paid_at, d.name AS device_name
       FROM rentals r JOIN devices d ON d.id = r.device_id
      WHERE r.id = $1`,
    [req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'rental not found' });
    return;
  }
  const rental = rows[0];
  if (rental.status !== 'pending_payment') {
    res.status(409).json({ error: `rental is ${rental.status}; cannot pay` });
    return;
  }

  try {
    const charge = await chargeViaShopApi({
      token: data.token,
      amount: rental.amount_cents / 100, // shop-api expects dollars
      currency: rental.currency,
      description: `LED ad rental on ${rental.device_name} (${rental.id})`,
      requestId: rental.id,             // idempotency: same rental id never double-charges
    });

    await query(
      `UPDATE rentals
          SET payment_provider = 'quickbooks',
              payment_reference = $1,
              paid_at = NOW(),
              status = 'pending_review',
              updated_at = NOW(),
              advertiser_notes = COALESCE(advertiser_notes, '') ||
                CASE WHEN COALESCE(advertiser_notes, '') = '' THEN '' ELSE E'\n' END ||
                'Card: ' || COALESCE($2, '?') || ' ****' || COALESCE($3, '?')
        WHERE id = $4`,
      [charge.charge_id, data.cardBrand ?? charge.card_brand ?? null, data.cardLast4 ?? charge.card_last4 ?? null, rental.id],
    );

    // Surface the booking on the staff jobs board. Best-effort: any failure
    // here logs and continues — the payment itself already succeeded and the
    // rental row holds the source of truth.
    void (async () => {
      try {
        const client = await upsertClientViaShopApi({
          email: rental.advertiser_email,
          name: rental.advertiser_name,
          business: rental.advertiser_business ?? undefined,
          phone: rental.advertiser_phone ?? undefined,
        });
        const project = await createProjectViaShopApi({
          clientId: client.id,
          description: `Ad rental: ${rental.advertiser_name} on ${rental.device_name}`,
          contactName: rental.advertiser_name,
          contactPhone: rental.advertiser_phone ?? undefined,
          contactEmail: rental.advertiser_email,
        });
        await query(
          `UPDATE rentals SET project_client_id = $1, project_id = $2, updated_at = NOW() WHERE id = $3`,
          [client.id, project.id, rental.id],
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('job-board sync failed for rental', rental.id, e);
      }
    })();

    // Notify Holm Graphics admin so they can review the artwork.
    void sendNewRentalNotification(rental.id).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('sendNewRentalNotification failed:', e);
    });

    res.json({ ok: true, chargeId: charge.charge_id, status: 'pending_review' });
  } catch (err) {
    if (err instanceof ShopApiError) {
      // 402 = card declined; 503 = bridge not configured; everything else gets generic 502.
      const status = err.status === 402 ? 402 : err.status === 503 ? 503 : 502;
      res.status(status).json({ error: 'coex', code: 'PAYMENT', message: err.message });
      return;
    }
    throw err;
  }
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
