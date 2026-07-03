/**
 * Shared rental → VNNOX publish helper. Lives in services/ rather than
 * routes/rentals.ts so both the admin approve flow AND the customer
 * self-serve artwork-swap flow can import it without creating a
 * routes ↔ routes circular dependency.
 *
 * What it does:
 *   1. Loads the rental + linked device + linked media in one query.
 *   2. Validates the prerequisites (vnnox provider, asset uploaded, run
 *      window set) — soft-failures land in rentals.publish_error so the
 *      admin queue surfaces them.
 *   3. Tears down any prior insertion program on the device for this rental.
 *   4. Publishes the new program; persists vnnox_program_id + published_at;
 *      flips status to 'active'.
 *   5. On a hard failure (VNNOX rejected the call) records publish_error
 *      and re-throws so the caller can surface a 502.
 */
import { query } from '../db';
import { publishAd, unpublishAd } from './vnnoxAdPublisher';

export async function publishApprovedAdToVnnox(rentalId: string): Promise<void> {
  const { rows } = await query<{
    rental_id: string;
    advertiser_name: string;
    start_date: string;
    end_date: string;
    start_time: string;
    end_time: string;
    fit_mode: string;
    device_provider: string;
    device_sn: string;
    device_name: string;
    ad_slot_seconds: number;
    dual_panel: boolean;
    media_url: string | null;
    media_mime: string | null;
    media_size: string | null;     // bigint comes back as string
    media_md5: string | null;
    existing_program_id: string | null;
  }>(
    `SELECT r.id AS rental_id, r.advertiser_name,
            r.start_date, r.end_date, r.start_time, r.end_time, r.fit_mode,
            r.vnnox_program_id AS existing_program_id,
            d.provider AS device_provider,
            d.device_key AS device_sn,
            d.name AS device_name,
            d.ad_slot_seconds,
            d.dual_panel,
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
      fitMode: x.fit_mode === 'cover' ? 'cover' : 'contain',
      dualPanel: x.dual_panel,
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
