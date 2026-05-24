/**
 * Nightly job that tidies up the ad rotation:
 *
 *   1. Marks rentals whose end_date is in the past as 'expired'.
 *   2. For each newly-expired rental that has a VNNOX program ID, calls
 *      unpublishAd to remove the program from the device. (VNNOX's own
 *      scheduler should already have stopped showing it after end_date —
 *      this is belt-and-suspenders cleanup.)
 *   3. Flips approved rentals whose start_date is today to 'active', so the
 *      admin UI shows the right state.
 *
 * Runs hourly (cheap) and on startup. The combination of VNNOX's own
 * date-range scheduling + this DB sync keeps reality and the database in
 * agreement without us having to push a fresh program on every change.
 */
import { query } from '../db';
import { unpublishAd } from './vnnoxAdPublisher';
import { writeLog } from './logs';

const TICK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export async function rentalExpiryTick(): Promise<void> {
  // 1. Promote approved → active when the run starts today.
  await query(
    `UPDATE rentals
        SET status = 'active', updated_at = NOW()
      WHERE status = 'approved'
        AND start_date IS NOT NULL
        AND start_date <= CURRENT_DATE`,
  );

  // 2. Find rentals that should be expired now (end_date in the past, still
  //    in a "playing" state). We grab their VNNOX program ID + device SN so
  //    we can also remove the program from the device.
  const { rows: toExpire } = await query<{
    id: string;
    vnnox_program_id: string | null;
    device_sn: string | null;
    device_provider: string;
  }>(
    `SELECT r.id, r.vnnox_program_id,
            d.device_key AS device_sn, d.provider AS device_provider
       FROM rentals r
       JOIN devices d ON d.id = r.device_id
      WHERE r.status IN ('approved', 'active')
        AND r.end_date IS NOT NULL
        AND r.end_date < CURRENT_DATE`,
  );

  for (const r of toExpire) {
    if (r.vnnox_program_id && r.device_sn && r.device_provider === 'vnnox') {
      try {
        await unpublishAd(r.device_sn, r.vnnox_program_id);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`rentalExpiry: unpublish failed for rental ${r.id}:`, (e as Error).message);
        // Continue — we'll still mark it expired in the DB. The program
        // was already past its run window so it shouldn't be playing.
      }
    }
    await query(
      `UPDATE rentals SET status = 'expired', updated_at = NOW() WHERE id = $1`,
      [r.id],
    );
  }

  if (toExpire.length > 0) {
    await writeLog('info', 'system', `expired ${toExpire.length} rental(s)`, null, { count: toExpire.length });
  }
}

let timer: NodeJS.Timeout | null = null;

export function startRentalExpiryCron(): void {
  // Run once at startup, then on a 1-hour interval.
  void rentalExpiryTick().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('rentalExpiry initial tick failed:', e);
  });
  timer = setInterval(() => {
    void rentalExpiryTick().catch((e) => {
      // eslint-disable-next-line no-console
      console.error('rentalExpiry tick failed:', e);
    });
  }, TICK_INTERVAL_MS);
}

export function stopRentalExpiryCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
