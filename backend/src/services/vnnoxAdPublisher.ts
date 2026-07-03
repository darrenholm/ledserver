/**
 * Publishes a single approved ad to a VNNOX device as an "insertion program"
 * (NovaStar's term for a clip that plays inside the device's normal program
 * on a schedule). One ad = one insertion program. The device's regular
 * content (base_playlist_id) lives as the normal program — we don't touch it.
 *
 * Publish model: incremental. Each call adds one program; expiry tears one
 * program down. The full device rotation = normal program + N insertion
 * programs, with VNNOX's scheduler honoring each ad's date+time window.
 *
 * Asset source: public URL on this server (/files/uploads/…). The LED app
 * already serves these with CORP=cross-origin so VNNOX can fetch them.
 */
import crypto from 'crypto';
import { config } from '../config';
import { vnnoxBaseUrl, vnnoxFetch } from '../coex/vnnoxSign';
import { CoexError } from '../coex/types';
import { probeVideoFromUrl } from './videoProbe';

export interface PublishAdArgs {
  /** Device serial number (VNNOX `sn`). */
  sn: string;
  /** Stable name for the program — VNNOX uses it as the display label. */
  name: string;
  /** Public URL VNNOX should fetch the asset from. Must be reachable. */
  mediaUrl: string;
  mediaMimeType: string;
  mediaSizeBytes: number;
  /** Optional MD5 — VNNOX validates the asset against this if provided. */
  mediaMd5?: string | null;
  /** How long this clip should play per appearance (the slot length), in seconds. */
  slotSeconds: number;
  /** Run window — both inclusive. */
  startDate: string;       // YYYY-MM-DD
  endDate: string;         // YYYY-MM-DD
  /** Daily time-of-day window. */
  startTime: string;       // HH:MM:SS or HH:MM
  endTime: string;         // HH:MM:SS or HH:MM
  /**
   * 'contain' = preserve aspect, letterbox if it doesn't match the panel.
   * 'cover'   = fill the panel, crop overflow.
   * Maps to NovaStar's widget scaling mode in the publish payload.
   */
  fitMode?: 'contain' | 'cover';
}

export interface PublishAdResult {
  programId: string;
  rawResponse: unknown;
}

type WidgetType = 'PICTURE' | 'GIF' | 'VIDEO';

function widgetTypeFor(mime: string): WidgetType {
  if (mime === 'image/gif') return 'GIF';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('image/')) return 'PICTURE';
  throw new CoexError(`vnnox cannot publish unsupported mime type: ${mime}`, 'PROTOCOL');
}

function normTime(t: string): string {
  // VNNOX wants HH:MM:SS. Accept HH:MM and pad.
  return /^\d{2}:\d{2}$/.test(t) ? `${t}:00` : t;
}

/**
 * Look up the playerId (32-char hex) for a given SN. Insertion-program
 * publish targets playerIds rather than SNs.
 */
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
 * Publishes the ad and returns the VNNOX program ID.
 *
 * Uses /v2/player/program/insertion — the documented endpoint for scheduled
 * insertion clips. The exact response shape varies by VNNOX version; we
 * try a few common keys to extract the program ID and otherwise return the
 * raw response so the caller can dig into it.
 */
export async function publishAd(args: PublishAdArgs): Promise<PublishAdResult> {
  const timeoutMs = config.vnnox.timeoutMs;
  const playerId = await resolvePlayerId(args.sn, timeoutMs);

  // NovaStar's "scaling" / "stretchMode" field controls how the asset is
  // rendered into the widget rectangle. The exact field name has varied
  // across VNNOX versions; we send both common spellings and let the
  // server pick the one it understands.
  //   'cover'   → 'FILL'  (stretch/crop to fill panel)
  //   'contain' → 'FIT'   (preserve aspect, letterbox)
  const vnnoxScale = args.fitMode === 'cover' ? 'FILL' : 'FIT';

  const widget: Record<string, unknown> = {
    type: widgetTypeFor(args.mediaMimeType),
    name: args.name.slice(0, 64),
    url: args.mediaUrl,
    size: args.mediaSizeBytes,
    md5: args.mediaMd5 ?? undefined,
    // Duration is per-play, in milliseconds.
    duration: Math.max(1, args.slotSeconds) * 1000,
    zIndex: 0,
    layout: { x: '0%', y: '0%', width: '100%', height: '100%' },
    // Belt-and-suspenders: include both naming conventions VNNOX has used.
    scaling: vnnoxScale,
    stretchMode: vnnoxScale,
  };

  // VIDEO widgets need codec/fps/dimensions or the Taurus shows a frozen frame
  // (images don't). Probe the asset and attach; skip if the probe fails.
  if (args.mediaMimeType.startsWith('video/')) {
    const meta = await probeVideoFromUrl(args.mediaUrl, args.mediaMd5 ?? undefined);
    if (meta) {
      widget.width = String(meta.widthPx);
      widget.height = String(meta.heightPx);
      widget.fps = String(meta.fps);
      widget.codec = meta.codec;
      widget.postfix = meta.postfix;
      if (meta.byteRateKbps) widget.byteRate = String(meta.byteRateKbps);
    }
  }

  const schedule = {
    startDate: args.startDate,
    endDate:   args.endDate,
    startTime: normTime(args.startTime),
    endTime:   normTime(args.endTime),
    // Play every day of the week within the run window.
    weekDays: [1, 2, 3, 4, 5, 6, 7],
    // -1 = loop indefinitely within the daypart window. The slot will
    // appear once per rotation pass; with multiple ads queued, VNNOX
    // serializes them.
    repeatTimes: -1,
  };

  const body = {
    playerIds: [playerId],
    // VNNOX uses "name" as the human-visible program label in their UI.
    name: args.name.slice(0, 64),
    // Each insertion program is one full-screen page with one widget.
    pages: [{ name: 'page-1', widgets: [widget] }],
    schedule,
  };

  /**
   * Attempt the insertion POST once. Pulled out into a helper so we can
   * retry on transient socket terminations without duplicating the body.
   */
  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await vnnoxFetch(`${vnnoxBaseUrl()}/v2/player/program/insertion`, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new CoexError(`vnnox insertion-publish failed (${res.status}): ${text}`, 'DEVICE_ERROR');
      }
      const data = text ? safeJson(text) : {};
      const programId =
        (data as any)?.programId ||
        (data as any)?.id ||
        (data as any)?.data?.programId ||
        (data as any)?.data?.id ||
        // Some VNNOX responses return { success: [{playerId, programId}], fail: [] }.
        (Array.isArray((data as any)?.success) ? (data as any).success[0]?.programId : undefined) ||
        // Last-resort: synthesize a local ID so we have SOMETHING to store.
        // The cleanup path will try to call by-name if no ID was returned.
        `local-${crypto.randomBytes(8).toString('hex')}`;
      return { programId: String(programId), rawResponse: data };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Treat socket-level aborts as transient. VNNOX (or Cloudflare in between)
   * occasionally closes the connection mid-response — Node undici surfaces
   * that as Error: terminated. One automatic retry handles the common case
   * without admin clicking Republish manually.
   */
  const isTransient = (err: unknown): boolean => {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | undefined;
    if (!e) return false;
    if (e.message === 'terminated' || e.message?.includes('terminated')) return true;
    if (e.cause?.code === 'UND_ERR_SOCKET' || e.cause?.code === 'ECONNRESET') return true;
    if (e.cause?.message === 'terminated' || e.cause?.message === 'other side closed') return true;
    return false;
  };

  /**
   * Try up to 4 times (initial + 3 retries) with exponential backoff. Real-
   * world experience: NovaStar's edge (sometimes Cloudflare-fronted) drops
   * sockets in bursts — a single retry isn't enough when the network is
   * unhappy for a few seconds at a stretch. Backoff intervals were chosen
   * empirically: 1s gets us past the most common micro-blip, 3s rides over
   * Cloudflare's worst-cluster swaps, 7s catches the long-tail.
   *
   * Non-transient failures (4xx/5xx from VNNOX, validation errors) skip
   * retry — those won't fix themselves.
   */
  const backoffMs = [1000, 3000, 7000];
  let lastErr: unknown;
  for (let i = 0; i <= backoffMs.length; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      // eslint-disable-next-line no-console
      console.warn(
        `[vnnox-publish] attempt ${i + 1}/${backoffMs.length + 1} failed: ` +
        `message=${(err as Error)?.message} ` +
        `cause=${JSON.stringify((err as { cause?: unknown })?.cause ?? null)}`,
      );
      if (!isTransient(err) || i === backoffMs.length) break;
      // eslint-disable-next-line no-console
      console.warn(`[vnnox-publish] transient — retrying in ${backoffMs[i]}ms`);
      await new Promise((r) => setTimeout(r, backoffMs[i]));
    }
  }
  throw lastErr;
}

/**
 * Remove an insertion program from a device. Used by the expiry cron.
 * Best-effort: if VNNOX doesn't recognize the program ID we log and move on
 * (the run window has already ended, so the ad isn't playing anyway).
 */
export async function unpublishAd(sn: string, programId: string): Promise<void> {
  const timeoutMs = config.vnnox.timeoutMs;
  const playerId = await resolvePlayerId(sn, timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await vnnoxFetch(`${vnnoxBaseUrl()}/v2/player/program/insertion/delete`, {
      method: 'POST',
      body: JSON.stringify({ playerIds: [playerId], programIds: [programId] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      // eslint-disable-next-line no-console
      console.warn(`vnnox unpublish ${programId} failed (${res.status}): ${text}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
