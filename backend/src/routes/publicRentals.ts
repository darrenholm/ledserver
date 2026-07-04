import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import { query, withTx } from '../db';
import { config } from '../config';
import sharp from 'sharp';
import { probeArtwork } from '../services/artworkValidation';
import { optionalAdvertiser, requireAdvertiser } from '../middleware/advertiserAuth';
import { newRentalEmail, sendEmail } from '../services/email';
import {
  chargeViaShopApi,
  createProjectViaShopApi,
  createSalesReceiptViaShopApi,
  lookupClientViaShopApi,
  ShopApiError,
  upsertClientViaShopApi,
} from '../services/shopApiClient';
import { publishApprovedAdToVnnox } from '../services/rentalPublisher';
import { mirrorRentalArtwork } from '../services/artworkMirror';
import { republishBaseProgram } from '../services/vnnoxBaseProgram';
import { buildTextSlideSvg, textSlideSchema } from '../services/textSlide';
import { ensureTaurusSafeVideo } from '../services/videoTranscode';

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

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

const createRentalSchema = z.object({
  deviceId: z.string().uuid(),
  advertiserName: z.string().min(1).max(120),
  advertiserEmail: z.string().email(),
  advertiserPhone: z.string().max(40).optional(),
  advertiserBusiness: z.string().max(120).optional(),
  advertiserNotes: z.string().max(2000).optional(),
  durationUnit: z.enum(['day', 'week', 'month']),
  durationCount: z.coerce.number().int().min(1).max(52),
  startTime: z.string().regex(timeRegex, 'expect HH:MM or HH:MM:SS').optional(),
  endTime:   z.string().regex(timeRegex, 'expect HH:MM or HH:MM:SS').optional(),
}).refine(
  (d) => {
    if (!d.startTime || !d.endTime) return true;
    return d.endTime > d.startTime;
  },
  { message: 'endTime must be after startTime', path: ['endTime'] },
);

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
            latitude, longitude, photos, traffic_stat, description,
            max_ads, ad_slot_seconds`;

router.get('/displays', async (_req, res) => {
  const { rows } = await query<RentableDeviceRow & { max_ads: number; ad_slot_seconds: number }>(
    `SELECT ${DISPLAY_SELECT}
       FROM devices
      WHERE is_rentable = TRUE
      ORDER BY name`,
  );
  res.json(rows);
});

router.get('/displays/:id', async (req, res) => {
  const { rows } = await query<RentableDeviceRow & {
    max_ads: number;
    ad_slot_seconds: number;
  }>(
    `SELECT ${DISPLAY_SELECT}, max_ads, ad_slot_seconds
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
        AND start_date IS NOT NULL AND end_date IS NOT NULL
      ORDER BY start_date`,
    [req.params.id],
  );
  res.json({ ...rows[0], bookedWindows: booked.rows });
});

/**
 * Counts how many existing rentals (in the active pipeline) would overlap a
 * proposed window. "Overlap" means BOTH the date range and the time-of-day
 * range intersect — two ads can co-exist if their date ranges overlap but
 * their dayparts don't (e.g. morning ad vs evening ad).
 *
 * Used both by the availability endpoint and by the approval flow.
 */
export async function countSlotConflicts(
  deviceId: string,
  startDate: string,
  endDate: string,
  startTime: string,
  endTime: string,
  excludeRentalId?: string,
): Promise<number> {
  const params: unknown[] = [deviceId, startDate, endDate, startTime, endTime];
  let exclude = '';
  if (excludeRentalId) {
    params.push(excludeRentalId);
    exclude = `AND r.id <> $6`;
  }
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM rentals r
      WHERE r.device_id = $1
        AND r.status IN ('pending_review','approved','active')
        AND r.start_date IS NOT NULL AND r.end_date IS NOT NULL
        AND r.start_date <= $3::date
        AND r.end_date   >= $2::date
        AND r.start_time <  $5::time
        AND r.end_time   >  $4::time
        ${exclude}`,
    params,
  );
  return Number(rows[0]?.n ?? '0');
}

const availabilityQuerySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expect YYYY-MM-DD').optional(),
  endDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expect YYYY-MM-DD').optional(),
  startTime: z.string().regex(timeRegex, 'expect HH:MM').optional(),
  endTime:   z.string().regex(timeRegex, 'expect HH:MM').optional(),
});

router.get('/displays/:id/availability', async (req, res) => {
  const q = availabilityQuerySchema.parse(req.query);
  const dev = await query<{ max_ads: number; ad_slot_seconds: number }>(
    `SELECT max_ads, ad_slot_seconds FROM devices WHERE id = $1 AND is_rentable = TRUE`,
    [req.params.id],
  );
  if (dev.rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const { max_ads, ad_slot_seconds } = dev.rows[0];

  // If caller didn't give a window, just summarize CURRENT slot occupancy
  // (today + all-day). Useful for the display detail page tease.
  const todayISO = new Date().toISOString().slice(0, 10);
  const startDate = q.startDate ?? todayISO;
  const endDate   = q.endDate   ?? todayISO;
  const startTime = q.startTime ?? '00:00:00';
  const endTime   = q.endTime   ?? '23:59:59';

  const slotsBooked = await countSlotConflicts(req.params.id, startDate, endDate, startTime, endTime);
  res.json({
    maxSlots: max_ads,
    slotSeconds: ad_slot_seconds,
    slotsBooked,
    slotsAvailable: Math.max(0, max_ads - slotsBooked),
    window: { startDate, endDate, startTime, endTime },
  });
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
        amount_cents, currency, status,
        start_time, end_time
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending_payment',
                COALESCE($12::time, '00:00:00'::time),
                COALESCE($13::time, '23:59:59'::time))
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
      data.startTime ?? null,
      data.endTime ?? null,
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

// --- Artwork upload (booking flow OR mid-rental swap for self-serve advertisers) ---
//
// Two callers, one endpoint:
//
//   1. Booking flow (pre-approval): rental.id is the secret. No auth header.
//      Allowed statuses: pending_payment, pending_review. Just attaches the
//      asset; admin will review + approve in the usual flow.
//
//   2. Self-serve swap (post-approval): caller sends a customer JWT in the
//      Authorization header. The middleware sets req.advertiser. We confirm
//      the JWT matches rentals.project_client_id, then branch on the
//      client's trust_self_serve_ads flag:
//        - TRUE  → stay active, immediately republish to VNNOX.
//        - FALSE → flip back to pending_review, clear the VNNOX program,
//                  admin reviews the new art before it goes live again.

/**
 * Determine what to do with the upload given who's asking and the rental's
 * current status. Encapsulates the access rules so both file-upload and
 * text-ad swap routes apply them identically.
 */
async function authorizeArtworkChange(opts: {
  rental: {
    id: string;
    status: string;
    project_client_id: number | null;
    advertiser_email: string;
    /**
     * For contract-attributed rentals (the new ownership/attribution path),
     * this carries the client_id from the parent ad_contract. We accept a
     * swap when the advertiser's id matches it — even when
     * project_client_id is NULL.
     */
    contract_client_id: number | null;
  };
  advertiser: { id: number; email: string } | undefined;
}): Promise<
  | { kind: 'allow-booking' }                                 // pre-approval, no auth
  | { kind: 'allow-self-serve'; trusted: boolean }            // logged-in advertiser, post-approval
  | { kind: 'deny'; reason: string; status: number }
> {
  const { rental, advertiser } = opts;

  if (['pending_payment', 'pending_review'].includes(rental.status)) {
    // Pre-approval: rental id is the secret. No auth needed.
    return { kind: 'allow-booking' };
  }

  if (!['approved', 'active'].includes(rental.status)) {
    return { kind: 'deny', status: 409, reason: `rental is ${rental.status}; artwork is locked` };
  }

  // Approved/active swap path — require a logged-in advertiser whose identity
  // matches the rental owner. Three accepted link paths:
  //   1. rental.project_client_id  (paid /advertise bookings)
  //   2. rental.contract.client_id (admin-attributed via contracts)
  //   3. advertiser_email          (legacy rentals before the client-id link)
  if (!advertiser) {
    return { kind: 'deny', status: 401, reason: 'sign in to change a running ad' };
  }
  const matchesProjectId  = rental.project_client_id  && rental.project_client_id  === advertiser.id;
  const matchesContractId = rental.contract_client_id && rental.contract_client_id === advertiser.id;
  const matchesEmail      = !rental.project_client_id && !rental.contract_client_id &&
                            rental.advertiser_email?.toLowerCase() === advertiser.email.toLowerCase();
  if (!matchesProjectId && !matchesContractId && !matchesEmail) {
    return { kind: 'deny', status: 403, reason: 'this rental belongs to a different account' };
  }

  // Ask shop-api whether this client is trusted for instant publish.
  let trusted = true;
  try {
    const client = await lookupClientViaShopApi(advertiser.id);
    trusted = client.trust_self_serve_ads !== false;
  } catch (e) {
    // If shop-api is unreachable, fall back to the safer behaviour:
    // re-review the change. Better to ping the admin than to publish
    // something we couldn't verify.
    // eslint-disable-next-line no-console
    console.warn('lookupClient failed for advertiser', advertiser.id, e);
    trusted = false;
  }
  return { kind: 'allow-self-serve', trusted };
}

/**
 * Apply a status transition + optional republish after a successful art swap.
 * Called by both the file-upload and text-ad routes.
 */
async function applyPostSwapState(
  rentalId: string,
  decision: { kind: 'allow-booking' } | { kind: 'allow-self-serve'; trusted: boolean },
): Promise<{ mode: 'pre-approval' | 'instant-republish' | 'pending-review-again' }> {
  if (decision.kind === 'allow-booking') {
    return { mode: 'pre-approval' };
  }
  if (decision.trusted) {
    // Republish in the background — the customer's HTTP response shouldn't
    // wait on VNNOX. publishApprovedAdToVnnox sets status=active on success
    // and stamps publish_error on failure; the customer's "my-ads" view
    // shows that field so they know if their republish hit a snag.
    void publishApprovedAdToVnnox(rentalId).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('self-serve publish failed for rental', rentalId, err);
    });
    return { mode: 'instant-republish' };
  }
  // Untrusted: move back to pending_review so admin sees the change. Clear
  // the live VNNOX program ID so the next admin approval republishes
  // cleanly (rather than thinking the old asset is still on the device).
  await query(
    `UPDATE rentals
        SET status = 'pending_review',
            vnnox_program_id = NULL,
            published_at = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [rentalId],
  );
  void sendNewRentalNotification(rentalId).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('sendNewRentalNotification failed:', err);
  });
  return { mode: 'pending-review-again' };
}

router.post('/rentals/:id/artwork', optionalAdvertiser, upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'no file uploaded' });
    return;
  }

  // Look up rental + device + ownership for dimension targets and auth.
  // The LEFT JOIN onto ad_contracts surfaces the contract's client_id so
  // contract-attributed rentals can self-serve via the customer portal.
  const r = await query<{
    rental_id: string;
    device_id: string;
    status: string;
    project_client_id: number | null;
    contract_client_id: number | null;
    advertiser_email: string;
    width_px: number | null;
    height_px: number | null;
    organization_id: string;
  }>(
    `SELECT r.id AS rental_id, r.device_id, r.status,
            r.project_client_id, c.client_id AS contract_client_id, r.advertiser_email,
            d.width_px, d.height_px, d.organization_id
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN ad_contracts c ON c.id = r.contract_id
      WHERE r.id = $1`,
    [req.params.id],
  );
  if (r.rows.length === 0) {
    fs.promises.unlink(req.file.path).catch(() => undefined);
    res.status(404).json({ error: 'rental not found' });
    return;
  }
  const rental = r.rows[0];

  const decision = await authorizeArtworkChange({
    rental: {
      id: rental.rental_id,
      status: rental.status,
      project_client_id: rental.project_client_id,
      contract_client_id: rental.contract_client_id,
      advertiser_email: rental.advertiser_email,
    },
    advertiser: req.advertiser,
  });
  if (decision.kind === 'deny') {
    fs.promises.unlink(req.file.path).catch(() => undefined);
    res.status(decision.status).json({ error: decision.reason });
    return;
  }

  // Normalize video ads to a Taurus-decodable encoding before we record or
  // publish them, same as the admin media library. Advertisers upload straight
  // from their phones, so this is where most non-playable files come from.
  if (req.file.mimetype.startsWith('video/')) {
    await ensureTaurusSafeVideo(req.file);
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

  const post = await applyPostSwapState(rental.rental_id, decision);

  // Fire-and-forget mirror to L:\<client>\LED Ads\<contractRef>\. Never
  // blocks the swap; failures land in the server log.
  void mirrorRentalArtwork(rental.rental_id);

  res.json({
    ok: true,
    mediaId: media.rows[0].id,
    warnings: probe.warnings,
    dimensions: probe.widthPx && probe.heightPx ? { width: probe.widthPx, height: probe.heightPx } : null,
    artworkUrl: publicUrl,
    mode: post.mode,
  });
});

// --- Text-only ads: server-rendered PNG ---
//
// Customers who don't have artwork can type a short headline + pick
// colours, and we render it to a PNG sized to the display. The rendered
// file then flows through the same media+rental pipeline as an upload,
// so VNNOX publish and the order-page preview work unchanged.

// textSlideSchema + buildTextSlideSvg moved to services/textSlide.ts so the
// admin media-library endpoint shares the same renderer.

router.post('/rentals/:id/text-artwork', optionalAdvertiser, async (req, res) => {
  const data = textSlideSchema.parse(req.body);

  const r = await query<{
    rental_id: string;
    device_id: string;
    status: string;
    project_client_id: number | null;
    contract_client_id: number | null;
    advertiser_email: string;
    width_px: number | null;
    height_px: number | null;
    organization_id: string;
  }>(
    `SELECT r.id AS rental_id, r.device_id, r.status,
            r.project_client_id, c.client_id AS contract_client_id, r.advertiser_email,
            d.width_px, d.height_px, d.organization_id
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN ad_contracts c ON c.id = r.contract_id
      WHERE r.id = $1`,
    [req.params.id],
  );
  if (r.rows.length === 0) {
    res.status(404).json({ error: 'rental not found' });
    return;
  }
  const rental = r.rows[0];

  const decision = await authorizeArtworkChange({
    rental: {
      id: rental.rental_id,
      status: rental.status,
      project_client_id: rental.project_client_id,
      contract_client_id: rental.contract_client_id,
      advertiser_email: rental.advertiser_email,
    },
    advertiser: req.advertiser,
  });
  if (decision.kind === 'deny') {
    res.status(decision.status).json({ error: decision.reason });
    return;
  }

  // Fall back to 1920×1080 if the device doesn't have dimensions on file
  // — better to produce a usable PNG than to reject the request.
  const widthPx  = rental.width_px  || 1920;
  const heightPx = rental.height_px || 1080;

  const svg = buildTextSlideSvg({
    ...data,
    widthPx,
    heightPx,
  });

  const filename = `${crypto.randomUUID()}.png`;
  const destPath = path.join(MEDIA_DIR, filename);
  await sharp(Buffer.from(svg))
    .png()
    .toFile(destPath);

  const stat = await fs.promises.stat(destPath);
  const publicUrl = `${config.mediaPublicBaseUrl}/uploads/${filename}`;

  const media = await query<{ id: string }>(
    `INSERT INTO media (organization_id, filename, original_name, mime_type, size_bytes,
                        width_px, height_px, storage_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      rental.organization_id,
      filename,
      `text-ad-${rental.rental_id.slice(0, 8)}.png`,
      'image/png',
      stat.size,
      widthPx,
      heightPx,
      publicUrl,
      JSON.stringify({
        source: 'rental-text',
        rentalId: rental.rental_id,
        text: data.text,
        textColor: data.textColor,
        bgColor: data.bgColor,
        fontFamily: data.fontFamily,
      }),
    ],
  );

  await query(
    `UPDATE rentals
        SET media_id = $1,
            artwork_warnings = '[]'::jsonb,
            updated_at = NOW()
      WHERE id = $2`,
    [media.rows[0].id, rental.rental_id],
  );

  const post = await applyPostSwapState(rental.rental_id, decision);

  // Fire-and-forget mirror — see file-upload branch above.
  void mirrorRentalArtwork(rental.rental_id);

  res.json({
    ok: true,
    mediaId: media.rows[0].id,
    artworkUrl: publicUrl,
    dimensions: { width: widthPx, height: heightPx },
    mode: post.mode,
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

    // Surface the booking on the staff jobs board AND record the QBO sales
    // receipt. Best-effort: any failure here logs and continues — the
    // payment itself already succeeded and the rental row holds the source
    // of truth.
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

        // QBO sales receipt — records the sale + payment together. Independent
        // try-block so a QBO outage doesn't blow away the job-board link we
        // just made (and vice-versa).
        try {
          const receipt = await createSalesReceiptViaShopApi({
            clientId: client.id,
            lineDescription: `LED ad rental on ${rental.device_name}`,
            amountCents: rental.amount_cents,
            currency: rental.currency,
            paymentRef: charge.charge_id,
            chargeDate: new Date().toISOString(),
          });
          await query(
            `UPDATE rentals SET qbo_receipt_id = $1, updated_at = NOW() WHERE id = $2`,
            [receipt.id, rental.id],
          );
        } catch (qboErr) {
          // eslint-disable-next-line no-console
          console.error('qbo sales receipt failed for rental', rental.id, qboErr);
        }
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

// --- Self-serve advertiser portal: list "my rentals" ---
//
// Authenticated via the customer JWT minted on holmgraphics.ca/login.
// Returns the logged-in client's rentals grouped into three buckets so
// the UI can render "Currently running / Upcoming / Past" without
// reshuffling on the client side.
//
// Back-fill: rentals booked before the project-link feature (or before
// this advertiser first logged in) have project_client_id = NULL. On
// every call we opportunistically link any rentals where advertiser_email
// matches the authenticated email so the next call picks them up cleanly.

router.get('/my-rentals', requireAdvertiser, async (req, res) => {
  const adv = req.advertiser!;

  // Best-effort back-fill: link orphaned rentals by email. Case-insensitive
  // since clients.email is canonicalised lower-case but advertiser_email
  // captures whatever the booking form typed.
  await query(
    `UPDATE rentals
        SET project_client_id = $1, updated_at = NOW()
      WHERE project_client_id IS NULL
        AND LOWER(advertiser_email) = LOWER($2)`,
    [adv.id, adv.email],
  );

  const { rows } = await query<{
    id: string;
    status: string;
    start_date: string | null;
    end_date: string | null;
    start_time: string;
    end_time: string;
    amount_cents: number;
    currency: string;
    artwork_warnings: string[];
    fit_mode: string;
    paid_at: string | null;
    device_name: string;
    device_location: string | null;
    device_width_px: number | null;
    device_height_px: number | null;
    storage_url: string | null;
    media_mime: string | null;
    published_at: string | null;
    publish_error: string | null;
    review_notes: string | null;
  }>(
    `SELECT r.id, r.status, r.start_date, r.end_date, r.start_time, r.end_time,
            r.amount_cents, r.currency, r.artwork_warnings, r.fit_mode,
            r.paid_at, r.published_at, r.publish_error, r.review_notes,
            d.name AS device_name, d.location AS device_location,
            d.width_px AS device_width_px, d.height_px AS device_height_px,
            m.storage_url, m.mime_type AS media_mime
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN media m ON m.id = r.media_id
       -- Surface contract-attributed rentals too: the join lets us match
       -- by the contract's client_id alongside the legacy project_client_id
       -- linkage from paid /advertise bookings.
       LEFT JOIN ad_contracts c ON c.id = r.contract_id
      WHERE r.project_client_id = $1
         OR c.client_id          = $1
      ORDER BY COALESCE(r.start_date, r.created_at::date) DESC`,
    [adv.id],
  );

  // Bucket logic — runs server-side so the client can render directly.
  const today = new Date().toISOString().slice(0, 10);
  const running: typeof rows = [];
  const upcoming: typeof rows = [];
  const past: typeof rows = [];
  for (const r of rows) {
    if (r.status === 'active') {
      running.push(r);
    } else if (r.status === 'approved' && r.start_date && r.start_date > today) {
      upcoming.push(r);
    } else if (['pending_payment', 'pending_review'].includes(r.status)) {
      // Treat these as upcoming from the customer's perspective — they
      // haven't gone live yet but they're not in the "past" bucket either.
      upcoming.push(r);
    } else {
      past.push(r);
    }
  }

  res.json({
    advertiser: { id: adv.id, name: adv.name, email: adv.email, company: adv.company },
    running,
    upcoming,
    past,
  });
});

// --- Status (renter-facing) ---

router.get('/rentals/:id', optionalAdvertiser, async (req, res) => {
  const { rows } = await query<{
    id: string;
    status: string;
    advertiser_name: string;
    advertiser_email: string;
    start_date: string | null;
    end_date: string | null;
    start_time: string;
    end_time: string;
    amount_cents: number;
    currency: string;
    artwork_warnings: string[];
    paid_at: string | null;
    review_notes: string | null;
    fit_mode: string;
    device_name: string;
    device_width_px: number | null;
    device_height_px: number | null;
    storage_url: string | null;
    media_mime: string | null;
  }>(
    `SELECT r.id, r.status, r.advertiser_name, r.advertiser_email,
            r.start_date, r.end_date, r.start_time, r.end_time,
            r.amount_cents, r.currency,
            r.artwork_warnings, r.paid_at, r.review_notes, r.fit_mode,
            d.name AS device_name,
            d.width_px AS device_width_px,
            d.height_px AS device_height_px,
            m.storage_url,
            m.mime_type AS media_mime
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

// Customer-facing toggle: "fit as-is" (contain) vs "stretch to fill" (cover).
// No auth — the rental id is the secret. We only allow the change while the
// rental is still before approval; after approval we've already published
// to the device with whatever fit_mode was set.
const fitModeSchema = z.object({ fitMode: z.enum(['contain', 'cover']) });

router.patch('/rentals/:id/fit-mode', async (req, res) => {
  const { fitMode } = fitModeSchema.parse(req.body);
  const { rows } = await query<{ id: string; status: string; fit_mode: string }>(
    `UPDATE rentals
        SET fit_mode = $1, updated_at = NOW()
      WHERE id = $2 AND status IN ('pending_payment', 'pending_review')
      RETURNING id, status, fit_mode`,
    [fitMode, req.params.id],
  );
  if (rows.length === 0) {
    res.status(409).json({ error: 'rental not found or already approved' });
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

// ---------------------------------------------------------------------------
// My devices — customer-facing weather page self-serve
// ---------------------------------------------------------------------------
//
// Any client who either OWNS a screen (devices.owner_client_id = their id,
// via the owner_perpetual contract) or has an active rental on a screen
// (rentals.project_client_id, OR ad_contracts.client_id) can enable a
// full-screen weather page on that screen without admin intervention.
//
// Scope this tightly:
//   - Only fields we want customer-controlled: weather_page_enabled,
//     weather_page_duration_ms, weather_page_location. NOT things like
//     base_playlist_id or pricing.
//   - Ownership check on every write — can't blast at someone else's
//     screen by guessing the device id.

router.get('/my-devices', requireAdvertiser, async (req, res) => {
  const adv = req.advertiser!;
  // Devices this client either owns directly or has an active/upcoming
  // rental (or contract) on. UNION dedupes if both apply.
  const { rows } = await query<{
    id: string;
    name: string;
    location: string | null;
    width_px: number | null;
    height_px: number | null;
    latitude: string | null;
    longitude: string | null;
    overlay_weather_location: string | null;
    overlay_weather_units: string;
    weather_page_enabled: boolean;
    weather_page_duration_ms: number;
    weather_page_location: string | null;
    relationship: string;
  }>(
    `SELECT d.id, d.name, d.location, d.width_px, d.height_px,
            d.latitude, d.longitude,
            d.overlay_weather_location, d.overlay_weather_units,
            d.weather_page_enabled, d.weather_page_duration_ms,
            d.weather_page_location,
            CASE WHEN d.owner_client_id = $1 THEN 'owner' ELSE 'renter' END AS relationship
       FROM devices d
      WHERE d.owner_client_id = $1
         OR d.id IN (
              SELECT r.device_id FROM rentals r
               WHERE r.status IN ('approved','active')
                 AND r.project_client_id = $1
              UNION
              SELECT a.device_id FROM ad_contracts a
               WHERE a.client_id = $1
                 AND (a.end_date IS NULL OR a.end_date >= CURRENT_DATE)
            )
      ORDER BY relationship ASC, d.name`,
    [adv.id],
  );
  res.json(rows);
});

router.patch('/my-devices/:id/weather-page', requireAdvertiser, async (req, res) => {
  const adv = req.advertiser!;
  const body = req.body as {
    enabled?: boolean;
    durationMs?: number;
    location?: string | null;
  };

  // Verify the caller has SOME claim on this device. Same predicate as
  // the GET above so the UI and the write match.
  const check = await query<{ id: string }>(
    `SELECT d.id FROM devices d
      WHERE d.id = $1
        AND ( d.owner_client_id = $2
              OR d.id IN (
                SELECT r.device_id FROM rentals r
                 WHERE r.status IN ('approved','active')
                   AND r.project_client_id = $2
                UNION
                SELECT a.device_id FROM ad_contracts a
                 WHERE a.client_id = $2
                   AND (a.end_date IS NULL OR a.end_date >= CURRENT_DATE)
              ))`,
    [req.params.id, adv.id],
  );
  if (check.rows.length === 0) {
    res.status(404).json({ error: 'device not found or not yours' });
    return;
  }

  // Validate inputs before touching the DB.
  if (body.durationMs !== undefined) {
    if (typeof body.durationMs !== 'number' || body.durationMs < 3000 || body.durationMs > 60000) {
      res.status(400).json({ error: 'durationMs must be 3000-60000' });
      return;
    }
  }
  if (body.location !== undefined && body.location !== null) {
    if (typeof body.location !== 'string' || body.location.length > 120) {
      res.status(400).json({ error: 'location must be a string ≤120 chars' });
      return;
    }
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (body.enabled !== undefined) {
    fields.push(`weather_page_enabled = $${i++}`);
    values.push(body.enabled);
  }
  if (body.durationMs !== undefined) {
    fields.push(`weather_page_duration_ms = $${i++}`);
    values.push(body.durationMs);
  }
  if (body.location !== undefined) {
    fields.push(`weather_page_location = $${i++}`);
    values.push(body.location);
  }
  if (fields.length === 0) {
    res.status(400).json({ error: 'no fields to update' });
    return;
  }
  values.push(req.params.id);
  await query(
    `UPDATE devices SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i}`,
    values,
  );

  // Push the change to the device immediately. Failures don't roll back
  // the DB write — admin (and the customer) can hit Republish later if
  // VNNOX is flaky. Match the pattern used by the artwork swap.
  let publishError: string | null = null;
  try {
    await republishBaseProgram(req.params.id);
  } catch (err) {
    publishError = (err as Error).message;
    // eslint-disable-next-line no-console
    console.warn('[my-devices/weather-page] publish failed:', publishError);
  }

  const updated = await query(
    `SELECT id, name, location, width_px, height_px, latitude, longitude,
            overlay_weather_location, overlay_weather_units,
            weather_page_enabled, weather_page_duration_ms, weather_page_location
       FROM devices WHERE id = $1`,
    [req.params.id],
  );
  res.json({ device: updated.rows[0], publishError });
});

// ---------------------------------------------------------------------------
// My sign — customer-facing slide list (self-serve content management)
// ---------------------------------------------------------------------------
//
// A client who owns or rents a screen manages the ordered list of slides that
// plays on it, without touching the admin playlist/deploy tooling. Slides are
// the device's base-program playlist; saving republishes the base program
// (which re-applies weather/clock/alert overlays automatically).

/** Load a device the caller owns or rents, or null. Same claim predicate as /my-devices. */
async function loadOwnedDevice(deviceId: string, clientId: number) {
  const { rows } = await query<{
    id: string;
    name: string;
    organization_id: string;
    base_playlist_id: string | null;
  }>(
    `SELECT d.id, d.name, d.organization_id, d.base_playlist_id
       FROM devices d
      WHERE d.id = $1
        AND ( d.owner_client_id = $2
              OR d.id IN (
                SELECT r.device_id FROM rentals r
                 WHERE r.status IN ('approved','active') AND r.project_client_id = $2
                UNION
                SELECT a.device_id FROM ad_contracts a
                 WHERE a.client_id = $2 AND (a.end_date IS NULL OR a.end_date >= CURRENT_DATE)
              ))`,
    [deviceId, clientId],
  );
  return rows[0] ?? null;
}

router.get('/my-devices/:id/slides', requireAdvertiser, async (req, res) => {
  const adv = req.advertiser!;
  const device = await loadOwnedDevice(req.params.id, adv.id);
  if (!device) {
    res.status(404).json({ error: 'device not found or not yours' });
    return;
  }
  if (!device.base_playlist_id) {
    res.json({ deviceName: device.name, slides: [] });
    return;
  }
  const { rows } = await query<{
    media_id: string;
    duration_ms: number;
    original_name: string;
    mime_type: string;
    storage_url: string;
    thumbnail_url: string | null;
  }>(
    `SELECT pi.media_id, pi.duration_ms,
            m.original_name, m.mime_type, m.storage_url, m.thumbnail_url
       FROM playlist_items pi
       JOIN media m ON m.id = pi.media_id
      WHERE pi.playlist_id = $1
      ORDER BY pi.position`,
    [device.base_playlist_id],
  );
  res.json({
    deviceName: device.name,
    slides: rows.map((r) => ({
      mediaId: r.media_id,
      name: r.original_name,
      mimeType: r.mime_type,
      url: r.storage_url,
      thumbnailUrl: r.thumbnail_url,
      durationMs: r.duration_ms,
    })),
  });
});

const slidesSchema = z.object({
  slides: z
    .array(
      z.object({
        mediaId: z.string().uuid(),
        durationMs: z.number().int().min(3000).max(60000).optional(),
      }),
    )
    .max(50),
});

router.put('/my-devices/:id/slides', requireAdvertiser, async (req, res) => {
  const adv = req.advertiser!;
  const device = await loadOwnedDevice(req.params.id, adv.id);
  if (!device) {
    res.status(404).json({ error: 'device not found or not yours' });
    return;
  }
  const parsed = slidesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid slides' });
    return;
  }
  const { slides } = parsed.data;

  // Every referenced media item must belong to this screen's org — a client
  // can't point their sign at someone else's media by guessing ids.
  if (slides.length > 0) {
    const ids = slides.map((s) => s.mediaId);
    const { rows: valid } = await query<{ id: string }>(
      `SELECT id FROM media WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
      [ids, device.organization_id],
    );
    const ok = new Set(valid.map((v) => v.id));
    const bad = ids.find((id) => !ok.has(id));
    if (bad) {
      res.status(400).json({ error: `media ${bad} is not available for this screen` });
      return;
    }
  }

  const playlistId = await withTx(async (client) => {
    let plId = device.base_playlist_id;
    if (!plId) {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO playlists (organization_id, name, loop) VALUES ($1, $2, TRUE) RETURNING id`,
        [device.organization_id, `${device.name} content`],
      );
      plId = ins.rows[0].id;
      await client.query(`UPDATE devices SET base_playlist_id = $1 WHERE id = $2`, [plId, device.id]);
    }
    await client.query(`DELETE FROM playlist_items WHERE playlist_id = $1`, [plId]);
    for (let idx = 0; idx < slides.length; idx++) {
      await client.query(
        `INSERT INTO playlist_items (playlist_id, media_id, position, duration_ms)
         VALUES ($1, $2, $3, COALESCE($4, 7000))`,
        [plId, slides[idx].mediaId, idx, slides[idx].durationMs ?? null],
      );
    }
    return plId;
  });

  // Push to the sign now. A publish failure doesn't roll back the saved order —
  // the client's list is stored; VNNOX can be retried. Mirrors weather-page.
  let publishError: string | null = null;
  try {
    await republishBaseProgram(device.id);
  } catch (err) {
    publishError = (err as Error).message;
    // eslint-disable-next-line no-console
    console.warn('[my-devices/slides] publish failed:', publishError);
  }
  res.json({ ok: true, playlistId, publishError });
});

router.post('/my-devices/:id/slides/upload', requireAdvertiser, upload.single('file'), async (req, res) => {
  const adv = req.advertiser!;
  const device = await loadOwnedDevice(req.params.id, adv.id);
  if (!device) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => undefined);
    res.status(404).json({ error: 'device not found or not yours' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'no file uploaded' });
    return;
  }
  // Normalize video to a Taurus-decodable encoding so the client's upload just
  // works, then record it against the screen's org.
  if (req.file.mimetype.startsWith('video/')) {
    await ensureTaurusSafeVideo(req.file);
  }
  const buf = await fs.promises.readFile(req.file.path);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const publicUrl = `${config.mediaPublicBaseUrl}/uploads/${req.file.filename}`;
  const ins = await query<{ id: string }>(
    `INSERT INTO media (organization_id, filename, original_name, mime_type, size_bytes,
                        checksum_sha256, checksum_md5, storage_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      device.organization_id,
      req.file.filename,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      sha256,
      md5,
      publicUrl,
      JSON.stringify({ source: 'self-serve', deviceId: device.id }),
    ],
  );
  res.status(201).json({
    mediaId: ins.rows[0].id,
    name: req.file.originalname,
    mimeType: req.file.mimetype,
    url: publicUrl,
  });
});

// ---------------------------------------------------------------------------
// VNNOX screenshot callback (no auth — NovaStar's servers POST here)
// ---------------------------------------------------------------------------
//
// NovaStar's screen-capture is async: routes/devices.ts POST /:id/screenshot
// asks VNNOX to capture and gives it this noticeUrl with ?d=deviceId&n=nonce.
// VNNOX POSTs { playerId, playerTime, screenShotUrl } here when the image is
// ready. We match the nonce (so a forged/stale callback can't overwrite) and
// stash the image URL on the device for the UI to poll. Always answer 200
// quickly — VNNOX requires the callback to respond within 3s.
router.post('/vnnox-screenshot', async (req, res) => {
  try {
    const deviceId = String(req.query.d || '');
    const nonce = String(req.query.n || '');
    const url = (req.body as { screenShotUrl?: string })?.screenShotUrl;
    if (deviceId && nonce && url) {
      const { rowCount } = await query(
        `UPDATE devices
            SET last_screenshot_url = $1, last_screenshot_at = NOW(), screenshot_nonce = NULL
          WHERE id = $2 AND screenshot_nonce = $3`,
        [url, deviceId, nonce],
      );
      // eslint-disable-next-line no-console
      console.log(`[vnnox-screenshot] callback d=${deviceId} matched=${rowCount} url=${url.slice(0, 60)}…`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[vnnox-screenshot] callback missing fields: d=${!!deviceId} n=${!!nonce} url=${!!url}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[vnnox-screenshot] callback failed:', (err as Error).message);
  }
  res.status(200).json({ ok: true });
});

export { withTx };
export default router;
