/**
 * Orchestrator for the public-alerts feature. Runs as a cron (every ~5
 * minutes); each tick:
 *   1. Pulls the active-alerts feed once for the whole country.
 *   2. For each device with alerts_enabled, finds the highest-severity
 *      alert whose polygon covers the device's lat/lng AND meets the
 *      device's configured minimum severity.
 *   3. Compares against the device's last-rendered alert (alerts_current_id):
 *      - same → do nothing
 *      - new / changed → republish VNNOX base program with the alert
 *        text as a scrolling TEXT overlay
 *      - cleared (no active alert now) → republish without the overlay
 *
 * Republishing only on state CHANGE keeps VNNOX traffic minimal even
 * during long-running alerts, since most alerts last for hours and we
 * don't want to push the same banner every 5 minutes.
 */
import { query } from '../db';
import {
  fetchActiveAlerts,
  alertCoversPoint,
  severityMeets,
  SEVERITY_ORDER,
  type EcAlert,
  type Severity,
} from './ecAlertsClient';
import { republishBaseProgram } from './vnnoxBaseProgram';

interface DeviceRow {
  id: string;
  name: string;
  sn: string;
  provider: string;
  latitude: number | string | null;
  longitude: number | string | null;
  alerts_enabled: boolean;
  alerts_severity_min: Severity;
  alerts_current_id: string | null;
}

/**
 * Format an alert for on-screen display. Short enough to be readable on a
 * scrolling banner — most LED billboards run ~100-200 chars before the
 * text wraps off the panel. We prepend the attribution (required by EC's
 * open-data license) and the alert type so viewers know what they're
 * looking at.
 */
export function formatAlertBanner(alert: EcAlert): string {
  const prefix = alert.alertType ? `${alert.alertType.toUpperCase()}` : 'ALERT';
  return `Environment Canada · ${prefix}: ${alert.headline}`;
}

/**
 * Picks the worst-severity alert covering a device's location that also
 * meets the device's configured minimum. Returns null if nothing covers
 * the device or nothing meets the threshold.
 */
function pickAlertForDevice(
  alerts: EcAlert[],
  lat: number,
  lng: number,
  minSeverity: Severity,
): EcAlert | null {
  let best: EcAlert | null = null;
  let bestRank = -1;
  for (const a of alerts) {
    if (!severityMeets(a.severity, minSeverity)) continue;
    if (!alertCoversPoint(a, lat, lng)) continue;
    const rank = SEVERITY_ORDER.indexOf(a.severity);
    if (rank > bestRank) {
      best = a;
      bestRank = rank;
    }
  }
  return best;
}

export interface TickResult {
  fetchedAlerts: number;
  devicesChecked: number;
  republishedWithAlert: number;
  republishedClear: number;
  unchanged: number;
  errors: { device_id: string; message: string }[];
}

/**
 * Runs one polling cycle. Returns counts so the cron can log a summary
 * without flooding the logs with per-device chatter.
 */
export async function runAlertsTick(): Promise<TickResult> {
  const result: TickResult = {
    fetchedAlerts: 0,
    devicesChecked: 0,
    republishedWithAlert: 0,
    republishedClear: 0,
    unchanged: 0,
    errors: [],
  };

  const alerts = await fetchActiveAlerts();
  result.fetchedAlerts = alerts.length;

  // Only consider VNNOX devices for now — that's the only transport
  // wired up to base-program publishing.
  const { rows } = await query<DeviceRow>(
    `SELECT id, name, sn, provider, latitude, longitude,
            alerts_enabled, alerts_severity_min, alerts_current_id
       FROM devices
      WHERE alerts_enabled = TRUE
        AND provider = 'vnnox'
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL`,
  );
  result.devicesChecked = rows.length;

  for (const d of rows) {
    const lat = typeof d.latitude === 'string' ? parseFloat(d.latitude) : d.latitude!;
    const lng = typeof d.longitude === 'string' ? parseFloat(d.longitude) : d.longitude!;
    const match = pickAlertForDevice(alerts, lat, lng, d.alerts_severity_min);

    const wantId = match?.id ?? null;
    const haveId = d.alerts_current_id;
    // No change — nothing to do this cycle.
    if (wantId === haveId) {
      result.unchanged += 1;
      await query(
        `UPDATE devices SET alerts_last_polled_at = NOW() WHERE id = $1`,
        [d.id],
      );
      continue;
    }

    // Either a new alert came in, an existing one expired, or the active
    // alert changed. Update DB state first (so even if VNNOX is grumpy
    // we don't busy-loop trying to republish every tick), then republish.
    const bannerText = match ? formatAlertBanner(match) : null;
    await query(
      `UPDATE devices
          SET alerts_current_id = $1,
              alerts_current_text = $2,
              alerts_last_polled_at = NOW()
        WHERE id = $3`,
      [wantId, bannerText, d.id],
    );

    try {
      await republishBaseProgram(d.id);
      if (match) result.republishedWithAlert += 1;
      else result.republishedClear += 1;
    } catch (err) {
      result.errors.push({ device_id: d.id, message: (err as Error).message });
    }
  }

  return result;
}

// ---------- cron wiring ----------

// 5 minutes. EC's feed updates whenever a forecast office issues an alert
// — typically within seconds — so polling more often gains very little
// while doubling our request volume. 5 min is the sweet spot most weather
// dashboards use.
const TICK_INTERVAL_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

/**
 * Starts the alerts polling loop. Runs one tick immediately on startup so
 * a freshly-restarted server picks up the current alert state for any
 * enabled device without waiting 5 min.
 */
export function startAlertsCron(): void {
  void runAlertsTick().then(logSummary).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[alerts-cron] initial tick failed:', e);
  });
  timer = setInterval(() => {
    void runAlertsTick().then(logSummary).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[alerts-cron] tick failed:', e);
    });
  }, TICK_INTERVAL_MS);
}

export function stopAlertsCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function logSummary(r: TickResult): void {
  // Quiet on the common case (nothing to do), chatty when state actually
  // changes — keeps logs readable during long alert-free stretches.
  if (r.republishedWithAlert + r.republishedClear + r.errors.length === 0) return;
  // eslint-disable-next-line no-console
  console.log(
    `[alerts-cron] fetched=${r.fetchedAlerts} devices=${r.devicesChecked} ` +
    `republished_with_alert=${r.republishedWithAlert} republished_clear=${r.republishedClear} ` +
    `unchanged=${r.unchanged} errors=${r.errors.length}`,
  );
  for (const err of r.errors) {
    // eslint-disable-next-line no-console
    console.warn(`[alerts-cron] device ${err.device_id} republish failed: ${err.message}`);
  }
}
