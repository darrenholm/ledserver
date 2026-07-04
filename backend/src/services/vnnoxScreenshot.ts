/**
 * Remote screenshot of a NovaStar player ("see what's on screen"). NovaStar's
 * screen-capture is asynchronous: we POST a capture request with a noticeUrl,
 * VNNOX queues it, and later POSTs the image link back to that noticeUrl. The
 * callback (routes/publicRentals.ts POST /vnnox-screenshot) stores the URL on
 * the device row for the UI to poll. Image URLs expire ~2h after capture.
 */
import { config } from '../config';
import { vnnoxBaseUrl, vnnoxFetch } from '../coex/vnnoxSign';
import { CoexError } from '../coex/types';

async function resolvePlayerId(sn: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await vnnoxFetch(`${vnnoxBaseUrl()}/v2/player/current/online-status`, {
      method: 'POST',
      body: JSON.stringify({ playerSns: [sn] }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new CoexError(`vnnox player lookup failed (${res.status}): ${text}`, 'DEVICE_ERROR');
    }
    const data = JSON.parse(text) as Array<{ sn: string; playerId: string }>;
    const hit = data.find((p) => p.sn === sn) ?? data[0];
    if (!hit?.playerId) throw new CoexError(`vnnox returned no playerId for sn=${sn}`, 'DEVICE_ERROR');
    return hit.playerId;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask VNNOX to capture the player's current screen. Returns once the request is
 * accepted; the actual image arrives later via the noticeUrl callback. Throws if
 * the player is unreachable or VNNOX rejects the request.
 */
export async function requestScreenshot(sn: string, noticeUrl: string): Promise<void> {
  const timeoutMs = config.vnnox.timeoutMs;
  const playerId = await resolvePlayerId(sn, timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await vnnoxFetch(`${vnnoxBaseUrl()}/v2/player/real-time-control/screen-capture`, {
      method: 'POST',
      body: JSON.stringify({ playerIds: [playerId], noticeUrl }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new CoexError(`vnnox screen-capture failed (${res.status}): ${text}`, 'DEVICE_ERROR');
    }
    const data = text ? (JSON.parse(text) as { success?: string[]; fail?: string[] }) : {};
    if (Array.isArray(data.fail) && data.fail.includes(playerId)) {
      throw new CoexError('vnnox rejected the screenshot request for this player', 'DEVICE_ERROR');
    }
  } finally {
    clearTimeout(timer);
  }
}
