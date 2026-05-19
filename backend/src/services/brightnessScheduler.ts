import { query } from '../db';
import { coexRegistry } from '../coex/registry';
import { CoexError } from '../coex/types';
import { isDayBrightness, sunEventsFor } from './sun';
import { writeLog } from './logs';

interface SchedulableDevice {
  id: string;
  organization_id: string;
  provider: 'vnnox' | 'lan_direct' | 'mock';
  device_key: string;
  ip_address: string | null;
  port: number;
  latitude: string | null;
  longitude: string | null;
  brightness_day: number;
  brightness_night: number;
  brightness_offset_minutes: number;
  last_applied_brightness: number | null;
  last_applied_at: string | null;
}

const TICK_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Per-tick scan: for each device with auto_brightness_enabled, figure out what
 * brightness it should be at right now, and apply it if it differs from the
 * last-applied value.
 *
 * VNNOX 403 / "enterprise auth pending" errors are caught and logged so they
 * don't bring down the loop. Once enterprise auth is approved upstream, the
 * scheduler will start succeeding without any code change.
 */
export async function tick(now: Date = new Date()): Promise<void> {
  const { rows } = await query<SchedulableDevice>(
    `SELECT id, organization_id, provider, device_key, ip_address, port,
            latitude, longitude, brightness_day, brightness_night,
            brightness_offset_minutes, last_applied_brightness, last_applied_at
       FROM devices
      WHERE auto_brightness_enabled = TRUE
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL`,
  );

  for (const d of rows) {
    try {
      const lat = parseFloat(d.latitude as string);
      const lng = parseFloat(d.longitude as string);
      const { sunrise, sunset } = sunEventsFor(lat, lng, now);
      const isDay = isDayBrightness(sunrise, sunset, d.brightness_offset_minutes, now);
      const target = isDay ? d.brightness_day : d.brightness_night;

      // Skip if we already applied this value AND it was within the last 12 hours.
      // (12h ensures we re-affirm at least once each day — useful if the device rebooted.)
      const lastAt = d.last_applied_at ? new Date(d.last_applied_at).getTime() : 0;
      const stale = now.getTime() - lastAt > 12 * 60 * 60 * 1000;
      if (d.last_applied_brightness === target && !stale) continue;

      const client = coexRegistry.get({
        id: d.id,
        provider: d.provider,
        deviceKey: d.device_key,
        ipAddress: d.ip_address ?? undefined,
        port: d.port,
      });

      await client.setBrightness(target);
      await query(
        `UPDATE devices
            SET last_applied_brightness = $1,
                last_applied_at = NOW(),
                updated_at = NOW()
          WHERE id = $2`,
        [target, d.id],
      );
      await writeLog(
        'info',
        'system',
        `auto-brightness: ${isDay ? 'day' : 'night'} ${target}% applied`,
        d.id,
        { sunrise: sunrise.toISOString(), sunset: sunset.toISOString() },
        d.organization_id,
      );
    } catch (err) {
      if (err instanceof CoexError && err.code === 'AUTH') {
        // Most likely VNNOX enterprise auth pending. Log once per hour per device, not every minute.
        const lastAt = d.last_applied_at ? new Date(d.last_applied_at).getTime() : 0;
        if (now.getTime() - lastAt > 60 * 60 * 1000) {
          await writeLog(
            'warn',
            'system',
            `auto-brightness skipped (auth): ${err.message}`,
            d.id,
            undefined,
            d.organization_id,
          );
        }
      } else {
        await writeLog(
          'error',
          'system',
          `auto-brightness failed: ${(err as Error).message}`,
          d.id,
          undefined,
          d.organization_id,
        );
      }
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (timer) return;
  // Fire once on boot, then every minute.
  void tick().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[scheduler] initial tick failed:', e);
  });
  timer = setInterval(() => {
    void tick().catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[scheduler] tick failed:', e);
    });
  }, TICK_INTERVAL_MS);
  // eslint-disable-next-line no-console
  console.log(`[scheduler] brightness automation started (tick=${TICK_INTERVAL_MS}ms)`);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
