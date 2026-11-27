import { query } from '../db';
import { coexRegistry } from '../coex/registry';
import { CoexError } from '../coex/types';
import { writeLog } from './logs';

interface PowerDevice {
  id: string;
  organization_id: string;
  provider: 'vnnox' | 'lan_direct' | 'mock';
  device_key: string;
  ip_address: string | null;
  port: number;
  screen_off_enabled: boolean;
  screen_off_start: string | null; // "HH:MM:SS"
  screen_off_end: string | null;
  screen_off_tz: string;
  last_screen_power: 'OPEN' | 'CLOSE' | null;
  last_screen_power_at: string | null;
}

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map((n) => parseInt(n, 10));
  return h * 60 + m;
}

function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
  const m = parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
  return h * 60 + m;
}

/** True when `now` falls inside the device's off window. Handles windows that cross midnight. */
export function isInOffWindow(
  d: { screen_off_enabled: boolean; screen_off_start: string | null; screen_off_end: string | null; screen_off_tz: string },
  now: Date = new Date(),
): boolean {
  if (!d.screen_off_enabled || !d.screen_off_start || !d.screen_off_end) return false;
  const start = toMinutes(d.screen_off_start);
  const end = toMinutes(d.screen_off_end);
  if (start === end) return false;
  const cur = localMinutes(now, d.screen_off_tz || 'America/Toronto');
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

const REAFFIRM_CLOSE_MS = 60 * 60 * 1000; // re-send CLOSE hourly in case the player rebooted overnight

/**
 * Per-tick: turn screens off inside their off window, back on outside it.
 * Only acts on changes (plus an hourly CLOSE re-affirm), so a manual
 * "Stop playback" during the day is not undone by the scheduler.
 * Devices whose off hours were disabled while closed get reopened.
 */
export async function tick(now: Date = new Date()): Promise<void> {
  const { rows } = await query<PowerDevice>(
    `SELECT id, organization_id, provider, device_key, ip_address, port,
            screen_off_enabled, screen_off_start::text AS screen_off_start,
            screen_off_end::text AS screen_off_end, screen_off_tz,
            last_screen_power, last_screen_power_at
       FROM devices
      WHERE screen_off_enabled = TRUE OR last_screen_power = 'CLOSE'`,
  );

  for (const d of rows) {
    const desired: 'OPEN' | 'CLOSE' = isInOffWindow(d, now) ? 'CLOSE' : 'OPEN';
    const lastAt = d.last_screen_power_at ? new Date(d.last_screen_power_at).getTime() : 0;
    const changed = d.last_screen_power !== desired;
    const reaffirm = desired === 'CLOSE' && now.getTime() - lastAt > REAFFIRM_CLOSE_MS;
    // Never send an initial OPEN to a device we've never closed.
    if (!changed && !reaffirm) continue;
    if (desired === 'OPEN' && d.last_screen_power === null) continue;

    try {
      const client = coexRegistry.get({
        id: d.id,
        provider: d.provider,
        deviceKey: d.device_key,
        ipAddress: d.ip_address ?? undefined,
        port: d.port,
      });
      await client.setScreenPower(desired === 'OPEN');
      await query(
        `UPDATE devices
            SET last_screen_power = $1, last_screen_power_at = NOW(), updated_at = NOW()
          WHERE id = $2`,
        [desired, d.id],
      );
      if (changed) {
        // When the screen comes back on, force brightness automation to
        // re-apply on its next pass.
        if (desired === 'OPEN') {
          await query(`UPDATE devices SET last_applied_at = NULL WHERE id = $1`, [d.id]);
        }
        await writeLog(
          'info',
          'system',
          `off-hours: screen ${desired === 'CLOSE' ? 'off' : 'on'}`,
          d.id,
          undefined,
          d.organization_id,
        );
      }
    } catch (err) {
      // Log failures at most hourly per device.
      if (now.getTime() - lastAt > 60 * 60 * 1000) {
        const auth = err instanceof CoexError && err.code === 'AUTH';
        await writeLog(
          auth ? 'warn' : 'error',
          'system',
          `off-hours ${desired === 'CLOSE' ? 'screen off' : 'screen on'} failed: ${(err as Error).message}`,
          d.id,
          undefined,
          d.organization_id,
        );
        await query(`UPDATE devices SET last_screen_power_at = NOW() WHERE id = $1`, [d.id]);
      }
    }
  }
}
