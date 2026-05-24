import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { config } from '../config';
import { authRequired, requireRole } from '../middleware/auth';
import { rentalApprovedEmail, rentalRejectedEmail, sendEmail } from '../services/email';
import { publishAd, unpublishAd } from '../services/vnnoxAdPublisher';
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
  created_at: string;
  updated_at: string;
  device_name: string;
  device_location: string | null;
  artwork_url: string | null;
  artwork_mime: string | null;
}

const listQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
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
  values.push(params.limit);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await query<RentalRow>(
    `SELECT r.*, d.name AS device_name, d.location AS device_location,
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

/**
 * Push an approved rental to VNNOX as an insertion program, then store the
 * returned program ID on the rental. Called from approveRental and the
 * manual Republish button.
 *
 * If the device isn't VNNOX-provider, or it has no SN configured, we record
 * a publish_error and bail without throwing — those displays will be
 * managed by hand for now.
 */
export async function publishApprovedAdToVnnox(rentalId: string): Promise<void> {
  const { rows } = await query<{
    rental_id: string;
    advertiser_name: string;
    start_date: string;
    end_date: string;
    start_time: string;
    end_time: string;
    device_provider: string;
    device_sn: string;
    device_name: string;
    ad_slot_seconds: number;
    media_url: string | null;
    media_mime: string | null;
    media_size: string | null;     // bigint comes back as string
    media_md5: string | null;
    existing_program_id: string | null;
  }>(
    `SELECT r.id AS rental_id, r.advertiser_name,
            r.start_date, r.end_date, r.start_time, r.end_time,
            r.vnnox_program_id AS existing_program_id,
            d.provider AS device_provider,
            d.device_key AS device_sn,
            d.name AS device_name,
            d.ad_slot_seconds,
            m.storage_url AS media_url,
            m.mime_type   AS media_mime,
            m.size_bytes  AS media_size,
            m.checksum_md5 AS media_md5
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN media m ON m.id = r.media_id
      WHERE r.id = $1`,
    [rentalId],
  );
  if (rows.length === 0) return;
  const x = rows[0];

  if (x.device_provider !== 'vnnox') {
    await query(
      `UPDATE rentals SET publish_error = $1, updated_at = NOW() WHERE id = $2`,
      [`device provider is "${x.device_provider}" — manual publish required`, rentalId],
    );
    return;
  }
  if (!x.media_url || !x.media_mime || !x.media_size) {
    await query(
      `UPDATE rentals SET publish_error = $1, updated_at = NOW() WHERE id = $2`,
      ['no artwork uploaded — cannot publish', rentalId],
    );
    return;
  }
  if (!x.start_date || !x.end_date) {
    await query(
      `UPDATE rentals SET publish_error = $1, updated_at = NOW() WHERE id = $2`,
      ['rental has no run window set', rentalId],
    );
    return;
  }

  // If a previous attempt already left a program on VNNOX, tear it down
  // first so we don't end up with two copies. Swallow errors — if the
  // delete fails, the create will either supersede or fail loudly.
  if (x.existing_program_id) {
    try { await unpublishAd(x.device_sn, x.existing_program_id); } catch { /* ignore */ }
  }

  try {
    const result = await publishAd({
      sn: x.device_sn,
      name: `Ad: ${x.advertiser_name} (${rentalId.slice(0, 8)})`,
      mediaUrl: x.media_url,
      mediaMimeType: x.media_mime,
      mediaSizeBytes: Number(x.media_size),
      mediaMd5: x.media_md5,
      slotSeconds: x.ad_slot_seconds || 6,
      startDate: x.start_date,
      endDate: x.end_date,
      startTime: x.start_time,
      endTime: x.end_time,
    });
    await query(
      `UPDATE rentals
          SET vnnox_program_id = $1,
              published_at = NOW(),
              publish_error = NULL,
              status = 'active',
              updated_at = NOW()
        WHERE id = $2`,
      [result.programId, rentalId],
    );
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    await query(
      `UPDATE rentals SET publish_error = $1, updated_at = NOW() WHERE id = $2`,
      [msg, rentalId],
    );
    throw err;
  }
}

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
            m.storage_url AS artwork_url, m.mime_type AS artwork_mime
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN media m ON m.id = r.media_id
      WHERE r.id = $1`,
    [req.params.id],
  );
  res.json(rows[0] ?? null);
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
