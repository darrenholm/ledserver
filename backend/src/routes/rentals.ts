import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { config } from '../config';
import { authRequired, requireRole } from '../middleware/auth';
import { rentalApprovedEmail, rentalRejectedEmail, sendEmail } from '../services/email';
import { publishApprovedAdToVnnox } from '../services/rentalPublisher';
import { mirrorRentalArtwork } from '../services/artworkMirror';
import { lookupClientViaShopApi, setClientTrustViaShopApi } from '../services/shopApiClient';
import { countSlotConflicts, sendNewRentalNotification } from './publicRentals';

const router = Router();

// --- Auth'd admin endpoints (super_admin only) ---

interface RentalRow {
  id: string;
  device_id: string;
  status: string;
  advertiser_name: string;
  advertiser_email: string;
  advertiser_phone: string | null;
  advertiser_business: string | null;
  advertiser_notes: string | null;
  start_date: string | null;
  end_date: string | null;
  start_time: string;
  end_time: string;
  duration_unit: string;
  duration_count: number;
  duration_days: number;
  amount_cents: number;
  currency: string;
  payment_provider: string | null;
  payment_reference: string | null;
  paid_at: string | null;
  media_id: string | null;
  artwork_warnings: string[];
  approval_token: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  fit_mode: string;
  qbo_receipt_id: string | null;
  vnnox_program_id: string | null;
  published_at: string | null;
  publish_error: string | null;
  created_at: string;
  updated_at: string;
  device_name: string;
  device_location: string | null;
  device_width_px: number | null;
  device_height_px: number | null;
  artwork_url: string | null;
  artwork_mime: string | null;
}

const listQuerySchema = z.object({
  status: z.string().optional(),
  deviceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

router.get('/', authRequired, requireRole('super_admin'), async (req, res) => {
  const params = listQuerySchema.parse(req.query);
  const where: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (params.status) {
    where.push(`r.status = $${i++}`);
    values.push(params.status);
  }
  if (params.deviceId) {
    where.push(`r.device_id = $${i++}`);
    values.push(params.deviceId);
  }
  // Hide orphaned synthetic rentals (attach-media → detach left behind).
  // They have no contract and no real payment history — they'd only clutter
  // the queue.
  // Hide orphaned synthetic rentals (attach-media → detach left behind).
  // Synthetic fingerprint = amount_cents=0 AND no payment_provider; if a
  // row also lost its contract link, it's a zombie and shouldn't appear
  // in the admin queue.
  where.push(`(r.contract_id IS NOT NULL OR r.amount_cents > 0 OR r.payment_provider IS NOT NULL)`);
  values.push(params.limit);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await query<RentalRow>(
    `SELECT r.*, d.name AS device_name, d.location AS device_location,
            d.width_px AS device_width_px, d.height_px AS device_height_px,
            m.storage_url AS artwork_url, m.mime_type AS artwork_mime
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN media m ON m.id = r.media_id
       ${clause}
      ORDER BY r.created_at DESC
      LIMIT $${i}`,
    values,
  );
  res.json(rows);
});

router.get('/:id', authRequired, requireRole('super_admin'), async (req, res) => {
  const { rows } = await query<RentalRow>(
    `SELECT r.*, d.name AS device_name, d.location AS device_location,
            d.width_px AS device_width_px, d.height_px AS device_height_px,
            m.storage_url AS artwork_url, m.mime_type AS artwork_mime
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

// --- Mark paid (payment stub for Phase 1) ---

const markPaidSchema = z.object({
  reference: z.string().min(1).max(200),
  provider: z.string().max(40).default('manual'),
});

router.post('/:id/mark-paid', authRequired, requireRole('super_admin'), async (req, res) => {
  const data = markPaidSchema.parse(req.body);
  const { rows } = await query<{ id: string; status: string }>(
    `UPDATE rentals
        SET payment_provider = $1,
            payment_reference = $2,
            paid_at = NOW(),
            status = CASE WHEN status = 'pending_payment' THEN 'pending_review' ELSE status END,
            updated_at = NOW()
      WHERE id = $3
      RETURNING id, status`,
    [data.provider, data.reference, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // If the rental has artwork, ping the admin email so they can review.
  void sendNewRentalNotification(req.params.id).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('sendNewRentalNotification failed:', e);
  });
  res.json(rows[0]);
});

// --- Approve / Reject ---

const reviewBodySchema = z.object({
  notes: z.string().max(2000).optional(),
  /** Optional override; defaults to today if not provided. */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expect YYYY-MM-DD').optional(),
});

/**
 * Given a duration in days and a start date, returns the inclusive end_date
 * (e.g. 7 days starting 2026-01-01 → 2026-01-07).
 */
function endDateForDuration(start: string, durationDays: number): string {
  const d = new Date(start + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + durationDays - 1);
  return d.toISOString().slice(0, 10);
}

/** Sentinel returned when the picked run window would exceed the device's max_ads. */
class SlotCapacityError extends Error {
  constructor(public readonly slotsBooked: number, public readonly maxSlots: number) {
    super(`slot capacity exceeded: ${slotsBooked}/${maxSlots} slots already booked for this window`);
  }
}

async function approveRental(
  rentalId: string,
  reviewerId: string | null,
  notes: string | null,
  startDateOverride: string | null,
): Promise<RentalRow | null> {
  // Look up duration_days, daypart, and device's slot capacity so we can
  // (a) compute the end_date and (b) refuse to overbook.
  const dRes = await query<{
    duration_days: number;
    start_time: string;
    end_time: string;
    device_id: string;
    max_ads: number;
  }>(
    `SELECT r.duration_days, r.start_time, r.end_time, r.device_id, d.max_ads
       FROM rentals r JOIN devices d ON d.id = r.device_id
      WHERE r.id = $1`,
    [rentalId],
  );
  if (dRes.rows.length === 0) return null;
  const { duration_days, start_time, end_time, device_id, max_ads } = dRes.rows[0];
  const durationDays = duration_days || 1;
  const startDate = startDateOverride ?? new Date().toISOString().slice(0, 10);
  const endDate = endDateForDuration(startDate, durationDays);

  // Capacity check: count other active rentals on this device whose date
  // ranges AND time-of-day windows overlap ours. Exclude ourselves so
  // re-approving an already-approved rental doesn't trip the check.
  const conflicts = await countSlotConflicts(device_id, startDate, endDate, start_time, end_time, rentalId);
  if (conflicts >= max_ads) {
    throw new SlotCapacityError(conflicts, max_ads);
  }

  const { rows } = await query<RentalRow & { device_name: string; artwork_url: string | null }>(
    `UPDATE rentals
        SET status = 'approved',
            start_date = $1::date,
            end_date   = $2::date,
            reviewed_by = $3,
            reviewed_at = NOW(),
            review_notes = $4,
            updated_at = NOW()
      WHERE id = $5 AND status IN ('pending_review','approved')
      RETURNING *`,
    [startDate, endDate, reviewerId, notes, rentalId],
  );
  if (rows.length === 0) return null;
  // Hydrate device + artwork for the email.
  const hydrated = await query<RentalRow>(
    `SELECT r.*, d.name AS device_name, d.location AS device_location,
            d.width_px AS device_width_px, d.height_px AS device_height_px,
            m.storage_url AS artwork_url, m.mime_type AS artwork_mime
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN media m ON m.id = r.media_id
      WHERE r.id = $1`,
    [rentalId],
  );
  const r = hydrated.rows[0];
  if (r) {
    const tmpl = rentalApprovedEmail({
      rentalId: r.id,
      advertiserName: r.advertiser_name,
      deviceName: r.device_name,
      startDate: r.start_date,
      endDate: r.end_date,
      startTime: r.start_time,
      endTime: r.end_time,
    });
    await sendEmail({ to: r.advertiser_email, subject: tmpl.subject, html: tmpl.html, text: tmpl.text });
    // Publish the ad to VNNOX as an insertion program. Best-effort: a
    // failure here doesn't roll back the approval — the admin can hit
    // "Republish" from device detail to retry. The error is stored on
    // rentals.publish_error so the admin queue can flag it.
    void publishApprovedAdToVnnox(rentalId).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('vnnox publish failed for rental', rentalId, err);
    });
  }
  return r ?? null;
}

// publishApprovedAdToVnnox is now in services/rentalPublisher.ts so the
// customer-facing /api/public artwork-swap flow can reach it without a
// routes ↔ routes circular import.

async function rejectRental(rentalId: string, reviewerId: string | null, notes: string | null): Promise<RentalRow | null> {
  const { rows } = await query<RentalRow & { device_name: string }>(
    `UPDATE rentals
        SET status = 'rejected',
            reviewed_by = $1,
            reviewed_at = NOW(),
            review_notes = $2,
            updated_at = NOW()
      WHERE id = $3 AND status IN ('pending_review','approved')
      RETURNING *`,
    [reviewerId, notes, rentalId],
  );
  if (rows.length === 0) return null;
  const hydrated = await query<RentalRow>(
    `SELECT r.*, d.name AS device_name, d.location AS device_location,
            d.width_px AS device_width_px, d.height_px AS device_height_px,
            m.storage_url AS artwork_url, m.mime_type AS artwork_mime
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN media m ON m.id = r.media_id
      WHERE r.id = $1`,
    [rentalId],
  );
  const r = hydrated.rows[0];
  if (r) {
    const tmpl = rentalRejectedEmail({
      rentalId: r.id,
      advertiserName: r.advertiser_name,
      deviceName: r.device_name,
      startDate: r.start_date,
      endDate: r.end_date,
      notes,
    });
    await sendEmail({ to: r.advertiser_email, subject: tmpl.subject, html: tmpl.html, text: tmpl.text });
  }
  return r ?? null;
}

router.post('/:id/approve', authRequired, requireRole('super_admin'), async (req, res) => {
  const data = reviewBodySchema.parse(req.body);
  try {
    const r = await approveRental(req.params.id, req.user!.sub, data.notes ?? null, data.startDate ?? null);
    if (!r) {
      res.status(404).json({ error: 'not found or wrong status' });
      return;
    }
    res.json(r);
  } catch (err) {
    if (err instanceof SlotCapacityError) {
      res.status(409).json({
        error: 'slot capacity exceeded',
        code: 'SLOT_FULL',
        slotsBooked: err.slotsBooked,
        maxSlots: err.maxSlots,
        message: `This display has ${err.maxSlots} ad slots and all are booked at the requested time window. Pick a different start date or daypart.`,
      });
      return;
    }
    throw err;
  }
});

/**
 * Manual retry of the VNNOX publish for a single rental. Useful when the
 * automatic publish at approval time fails (network blip, VNNOX 5xx,
 * pending enterprise auth, etc.). Returns the updated rental row so the
 * UI can refresh.
 */
/**
 * Read the client's self-serve trust flag (via shop-api lookup). Exposes
 * it on the rental detail page so admin can see at a glance whether this
 * advertiser is allowed to swap their ad without re-review.
 */
router.get('/:id/client-trust', authRequired, requireRole('super_admin'), async (req, res) => {
  const { rows } = await query<{ project_client_id: number | null }>(
    `SELECT project_client_id FROM rentals WHERE id = $1`,
    [req.params.id],
  );
  if (rows.length === 0 || !rows[0].project_client_id) {
    res.json({ clientId: null, trust: null });
    return;
  }
  try {
    const c = await lookupClientViaShopApi(rows[0].project_client_id);
    res.json({ clientId: c.id, trust: c.trust_self_serve_ads });
  } catch (err) {
    res.status(502).json({ error: 'shop-api unreachable', message: (err as Error).message });
  }
});

const trustSchema = z.object({ trust: z.boolean() });
router.post('/:id/client-trust', authRequired, requireRole('super_admin'), async (req, res) => {
  const { trust } = trustSchema.parse(req.body);
  const { rows } = await query<{ project_client_id: number | null }>(
    `SELECT project_client_id FROM rentals WHERE id = $1`,
    [req.params.id],
  );
  if (rows.length === 0 || !rows[0].project_client_id) {
    res.status(409).json({ error: 'rental has no linked client yet — pay it first' });
    return;
  }
  try {
    const c = await setClientTrustViaShopApi(rows[0].project_client_id, trust);
    res.json({ clientId: c.id, trust: c.trust_self_serve_ads });
  } catch (err) {
    res.status(502).json({ error: 'shop-api unreachable', message: (err as Error).message });
  }
});

router.post('/:id/republish', authRequired, requireRole('super_admin'), async (req, res) => {
  try {
    await publishApprovedAdToVnnox(req.params.id);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    res.status(502).json({ error: 'vnnox publish failed', message: msg });
    return;
  }
  const { rows } = await query<RentalRow>(
    `SELECT r.*, d.name AS device_name, d.location AS device_location,
            d.width_px AS device_width_px, d.height_px AS device_height_px,
            m.storage_url AS artwork_url, m.mime_type AS artwork_mime
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN media m ON m.id = r.media_id
      WHERE r.id = $1`,
    [req.params.id],
  );
  res.json(rows[0] ?? null);
});

// --- Swap a rental's creative in-place (admin) ---
//
// The "weekly artwork change" workflow. Updating media_id on the same
// rental row preserves the run window, client link, contract link, and
// payment history — only the playing creative changes. After the swap
// we republish to VNNOX (if the rental is in a publishable state) and
// fire-and-forget the L:\ mirror.
//
// The media file must already exist in the same org's media library —
// callers either upload to /api/media first or pick from the existing
// library. This endpoint deliberately doesn't accept a file upload so
// admins use Media's existing upload path (which handles dimensions,
// thumbnails, validation).

const replaceMediaSchema = z.object({ mediaId: z.string().uuid() });

router.patch('/:id/media', authRequired, requireRole('super_admin'), async (req, res) => {
  const { mediaId } = replaceMediaSchema.parse(req.body);

  // Verify the rental exists and the media is in the same org.
  const rentalRes = await query<{ device_id: string; status: string; organization_id: string }>(
    `SELECT r.device_id, r.status, d.organization_id
       FROM rentals r JOIN devices d ON d.id = r.device_id
      WHERE r.id = $1`,
    [req.params.id],
  );
  if (rentalRes.rows.length === 0) {
    res.status(404).json({ error: 'rental not found' });
    return;
  }
  const orgId = rentalRes.rows[0].organization_id;

  const mediaRes = await query<{ id: string }>(
    `SELECT id FROM media WHERE id = $1 AND organization_id = $2`,
    [mediaId, orgId],
  );
  if (mediaRes.rows.length === 0) {
    res.status(404).json({ error: 'media not found in this org' });
    return;
  }

  await query(
    `UPDATE rentals SET media_id = $1, updated_at = NOW() WHERE id = $2`,
    [mediaId, req.params.id],
  );

  // Mirror the new artwork into the client's L:\ folder. Best-effort —
  // never blocks the swap.
  void mirrorRentalArtwork(req.params.id);

  // Republish to VNNOX only if the rental is currently in a state that
  // pushes to the device. Pending/cancelled rentals don't have a live
  // program to update.
  let publishErrorMsg: string | null = null;
  if (rentalRes.rows[0].status === 'approved' || rentalRes.rows[0].status === 'active') {
    try {
      await publishApprovedAdToVnnox(req.params.id);
    } catch (err) {
      // Don't fail the swap if VNNOX is grumpy — admin can hit
      // "Republish" later. The DB swap succeeded.
      publishErrorMsg = (err as Error).message ?? String(err);
      // eslint-disable-next-line no-console
      console.warn('replace-media: vnnox publish failed for rental', req.params.id, publishErrorMsg);
    }
  }

  // Return the freshly-updated rental row with hydrated joins.
  const { rows } = await query<RentalRow>(
    `SELECT r.*, d.name AS device_name, d.location AS device_location,
            d.width_px AS device_width_px, d.height_px AS device_height_px,
            m.storage_url AS artwork_url, m.mime_type AS artwork_mime
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN media m ON m.id = r.media_id
      WHERE r.id = $1`,
    [req.params.id],
  );
  res.json({ rental: rows[0] ?? null, publishError: publishErrorMsg });
});

// --- Re-schedule a rental (admin can pre-program / shift run window) ---
//
// Pure date/time update. Unlike approve, this doesn't change status,
// send emails, or push to VNNOX -- it just edits the run window so
// admin can pre-program ads ahead of time or slide them around. Use
// the manual "Republish" button on Device Detail after editing if the
// rental is already approved/active and you want the change reflected
// on the screen immediately.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const scheduleSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expect YYYY-MM-DD').optional(),
  endDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expect YYYY-MM-DD').optional(),
  startTime: z.string().regex(TIME_RE, 'expect HH:MM').optional(),
  endTime:   z.string().regex(TIME_RE, 'expect HH:MM').optional(),
}).refine(
  (d) => d.startDate !== undefined || d.endDate !== undefined || d.startTime !== undefined || d.endTime !== undefined,
  { message: 'provide at least one field' },
);

router.patch('/:id/schedule', authRequired, requireRole('super_admin'), async (req, res) => {
  const data = scheduleSchema.parse(req.body);

  // Pull current dates so we can recompute duration_days when start/end change.
  const cur = await query<{ start_date: string | null; end_date: string | null }>(
    `SELECT start_date, end_date FROM rentals WHERE id = $1`,
    [req.params.id],
  );
  if (cur.rows.length === 0) {
    res.status(404).json({ error: 'rental not found' });
    return;
  }
  const newStart = data.startDate ?? cur.rows[0].start_date;
  const newEnd   = data.endDate   ?? cur.rows[0].end_date;
  if (newStart && newEnd && new Date(newEnd) < new Date(newStart)) {
    res.status(400).json({ error: 'endDate must be on or after startDate' });
    return;
  }
  const newDurationDays = newStart && newEnd
    ? Math.max(1, Math.ceil(
        (new Date(newEnd).getTime() - new Date(newStart).getTime()) / (1000 * 60 * 60 * 24),
      ))
    : null;

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (data.startDate !== undefined) { sets.push(`start_date = $${i++}::date`); values.push(data.startDate); }
  if (data.endDate !== undefined)   { sets.push(`end_date = $${i++}::date`);   values.push(data.endDate); }
  if (data.startTime !== undefined) { sets.push(`start_time = $${i++}::time`); values.push(data.startTime); }
  if (data.endTime !== undefined)   { sets.push(`end_time = $${i++}::time`);   values.push(data.endTime); }
  if (newDurationDays !== null && (data.startDate !== undefined || data.endDate !== undefined)) {
    sets.push(`duration_days = $${i++}`); values.push(newDurationDays);
  }
  sets.push(`updated_at = NOW()`);
  values.push(req.params.id);

  const { rows } = await query<RentalRow>(
    `UPDATE rentals SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values,
  );
  res.json(rows[0]);
});

router.post('/:id/reject', authRequired, requireRole('super_admin'), async (req, res) => {
  const data = reviewBodySchema.parse(req.body);
  const r = await rejectRental(req.params.id, req.user!.sub, data.notes ?? null);
  if (!r) {
    res.status(404).json({ error: 'not found or wrong status' });
    return;
  }
  res.json(r);
});

// --- Email button targets: token-signed approve/reject (no login) ---
// These are GET because they're clicked from an email link. They return a
// minimal HTML page since the user lands here from email, not from the SPA.

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:64px auto;padding:0 24px;color:#111}
.card{border:1px solid #ddd;border-radius:8px;padding:24px}
.ok{color:#16a34a}.err{color:#dc2626}
a{color:#2563eb}</style></head><body><div class="card">${body}<p style="margin-top:24px"><a href="${config.publicBaseUrl}/">Open the LED control dashboard →</a></p></div></body></html>`;
}

router.get('/approve/:token', async (req, res) => {
  const r = await query<{ id: string }>(`SELECT id FROM rentals WHERE approval_token = $1`, [req.params.token]);
  if (r.rows.length === 0) {
    res.status(404).type('html').send(htmlPage('Not found', '<h2 class="err">Approval link invalid</h2><p>This rental may have already been processed.</p>'));
    return;
  }
  const result = await approveRental(r.rows[0].id, null, null, null);
  if (!result) {
    res.type('html').send(htmlPage('Already processed', '<h2>Already processed</h2><p>This rental has already been approved or is not in a reviewable state.</p>'));
    return;
  }
  res.type('html').send(
    htmlPage('Approved', `<h2 class="ok">Approved ✓</h2><p>Confirmation email sent to ${result.advertiser_email}.</p>`),
  );
});

router.get('/reject/:token', async (req, res) => {
  const r = await query<{ id: string }>(`SELECT id FROM rentals WHERE approval_token = $1`, [req.params.token]);
  if (r.rows.length === 0) {
    res.status(404).type('html').send(htmlPage('Not found', '<h2 class="err">Reject link invalid</h2>'));
    return;
  }
  const result = await rejectRental(r.rows[0].id, null, 'Rejected via email link');
  if (!result) {
    res.type('html').send(htmlPage('Already processed', '<h2>Already processed</h2>'));
    return;
  }
  res.type('html').send(
    htmlPage('Rejected', `<h2 class="err">Rejected</h2><p>Email sent to ${result.advertiser_email}. Any payment should be refunded manually.</p>`),
  );
});

export default router;
