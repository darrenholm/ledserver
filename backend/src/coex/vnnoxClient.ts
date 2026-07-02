import { config } from '../config';
import {
  CoexError,
  CoexTransport,
  DeviceInfo,
  DeviceStatus,
  PlaylistManifest,
  PlaylistManifestItem,
} from './types';
import { vnnoxBaseUrl, vnnoxFetch } from './vnnoxSign';

type VnnoxMediaWidgetType = 'PICTURE' | 'GIF' | 'VIDEO';

function widgetTypeFor(mimeType: string): VnnoxMediaWidgetType {
  if (mimeType === 'image/gif') return 'GIF';
  if (mimeType.startsWith('video/')) return 'VIDEO';
  if (mimeType.startsWith('image/')) return 'PICTURE';
  throw new CoexError(
    `vnnox cannot publish unsupported mime type: ${mimeType}`,
    'PROTOCOL',
  );
}

/**
 * VnnoxCloudClient — talks to NovaStar's NovaCloud Open Platform v2 REST API.
 *
 * Identifier conventions (per docs):
 *   - Monitor endpoints use the device serial number `sn` (hardware identity).
 *   - Real-time control endpoints use `playerId` (32-char hex, VNNOX-internal).
 *
 * Our `Device.device_key` column stores the `sn`. If we need playerId for a
 * control call and don't have one cached, we look it up at call time.
 *
 * Reference: https://developer-en.vnnox.com/
 */
export interface VnnoxClientOptions {
  /** Device serial number (matches Device.device_key for provider=vnnox). */
  sn: string;
  /** Cached playerId — populated lazily by the first control call. */
  playerId?: string;
  /** Override base URL (mostly for tests). */
  baseUrl?: string;
  timeoutMs?: number;
}

interface PlayerOnlineStatus {
  playerId: string;
  sn: string;
  onlineStatus: number;          // 0 offline, 1 online
  lastOnlineTime?: string;
}

interface ScreenListItem {
  sid: number;
  name: string;
  mac?: string;
  sn: string;
  address?: string;
  status: number;                // 1 normal, 2 offline, 3 risky, 4 faulty
  brightness?: number;           // 0-100
  envBrightness?: number;
  // Pixel geometry. VNNOX has used a couple of different field names across
  // API versions / tiers — `width` + `height` on the modern v2 list, and a
  // formatted `resolution` string ("1920x1080") on some older responses.
  // We probe both at runtime and let either path populate the device row.
  width?: number;
  height?: number;
  resolution?: string;
}

interface BatchResult {
  success: string[];
  fail: string[];
}

export class VnnoxCloudClient implements CoexTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly sn: string;
  private playerId: string | undefined;

  constructor(opts: VnnoxClientOptions) {
    this.baseUrl = opts.baseUrl ?? vnnoxBaseUrl();
    this.timeoutMs = opts.timeoutMs ?? config.vnnox.timeoutMs;
    this.sn = opts.sn;
    this.playerId = opts.playerId;
  }

  // ----- core request helper -----

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await vnnoxFetch(`${this.baseUrl}${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      const data = text ? safeJson(text) : undefined;
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new CoexError(`vnnox auth rejected (${res.status}): ${text}`, 'AUTH');
        }
        if (res.status === 429) {
          throw new CoexError(`vnnox rate-limited: ${text}`, 'DEVICE_ERROR');
        }
        throw new CoexError(`vnnox ${res.status}: ${text}`, 'DEVICE_ERROR');
      }
      return data as T;
    } catch (err) {
      if (err instanceof CoexError) throw err;
      const isAbort = (err as Error)?.name === 'AbortError';
      throw new CoexError(
        isAbort ? `vnnox timeout after ${this.timeoutMs}ms` : `vnnox unreachable: ${(err as Error)?.message}`,
        isAbort ? 'TIMEOUT' : 'UNREACHABLE',
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ----- identifier resolution -----

  /**
   * Look up player by SN via the documented `/v2/player/current/online-status`
   * endpoint (Player Management scope). Returns onlineStatus + playerId.
   * Caches playerId for subsequent control calls (brightness, reboot, etc.).
   */
  private async findPlayer(): Promise<PlayerOnlineStatus> {
    const result = await this.request<PlayerOnlineStatus[]>(
      'POST',
      '/v2/player/current/online-status',
      { playerSns: [this.sn] },
    );
    if (!Array.isArray(result) || result.length === 0) {
      throw new CoexError(
        `device sn=${this.sn} not found in VNNOX (player list returned empty)`,
        'DEVICE_ERROR',
      );
    }
    const hit = result.find((p) => p.sn === this.sn) ?? result[0];
    if (!this.playerId) this.playerId = hit.playerId;
    return hit;
  }

  /** Resolve playerId for control APIs. Hits the same player endpoint. */
  private async resolvePlayerId(): Promise<string> {
    if (this.playerId) return this.playerId;
    await this.findPlayer();
    if (!this.playerId) {
      throw new CoexError(`could not resolve playerId for sn=${this.sn}`, 'DEVICE_ERROR');
    }
    return this.playerId;
  }

  // ----- CoexTransport implementation -----

  async handshake(): Promise<DeviceInfo> {
    const player = await this.findPlayer();
    return {
      deviceKey: player.sn,
      model: 'Taurus / VNNOX',
      firmware: 'unknown',
      widthPx: undefined,
      heightPx: undefined,
    };
  }

  async getStatus(): Promise<DeviceStatus> {
    // online/offline comes from the player API (fast, lightweight).
    const player = await this.findPlayer();

    // brightness + MAC + screen geometry come from the screen list endpoint.
    // We tolerate failure because (a) the screen list is "advanced" and may
    // be 403 on lower tiers, and (b) we'd rather return online=true with
    // brightness=0 than fail the whole status call.
    let brightness = 0;
    let widthPx: number | undefined;
    let heightPx: number | undefined;
    // Two-step status enrichment per VNNOX docs:
    //
    //   1) screen-list (`/v2/device-status-monitor/screen/list`) returns
    //      brightness + envBrightness + status across all screens visible
    //      to the API key. On our tier this returns 0 items, so we tolerate
    //      a miss here.
    //
    //   2) operating-parameters (`/v2/device-status-monitor/master-control/
    //      running/{sn}`) returns the per-device detail including
    //      basic.resolutionRatio ("1920*1080" format). This is per-SN and
    //      works on tiers where the broad list doesn't.
    //
    // Both calls are best-effort; either or both may fail, and we still
    // return a valid DeviceStatus.
    let hit: ScreenListItem | undefined;
    try {
      const screens = await this.request<{ items: ScreenListItem[] }>(
        'GET',
        '/v2/device-status-monitor/screen/list?pageNumber=0&pageSize=1000',
      );
      hit = screens.items?.find((s) => s.sn === this.sn);
    } catch {
      // ignore — screen-list is not available on every tier
    }

    // Per-device detail call. Documented at api-188113043 to return
    // basic.resolutionRatio in "WIDTH*HEIGHT" format. In practice on
    // Holm Graphics's VNNOX key this either errors silently (auth/scope)
    // or returns an unexpected shape, so the call stays best-effort and
    // admin can always type dimensions manually on DeviceDetail.
    try {
      const detail = await this.request<{ basic?: { resolutionRatio?: string } }>(
        'GET',
        `/v2/device-status-monitor/master-control/running/${encodeURIComponent(this.sn)}`,
      );
      const ratio = detail.basic?.resolutionRatio;
      if (typeof ratio === 'string') {
        const m = ratio.match(/(\d+)\s*[x×*]\s*(\d+)/i);
        if (m) {
          widthPx = parseInt(m[1], 10);
          heightPx = parseInt(m[2], 10);
        }
      }
    } catch {
      // ignore — manual entry on DeviceDetail is the fallback
    }

    try {
      if (hit) {
        if (typeof hit.brightness === 'number') brightness = hit.brightness;
        // VNNOX's field names for screen geometry have varied across API
        // versions and tiers. Try every shape we've seen:
        //   - flat width/height ints (modern v2)
        //   - "WIDTHxHEIGHT" resolution string (older response)
        //   - screenWidth / screenHeight / pixelWidth / pixelHeight (alt naming)
        //   - nested inside screenInfo / size / specs (deep tiers)
        // Use a loose Record cast so we can probe field names that aren't
        // in the typed interface without a TypeScript fight.
        const raw = hit as unknown as Record<string, unknown>;
        const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        const w =
          num(raw.width) ?? num(raw.screenWidth) ?? num(raw.pixelWidth) ??
          num((raw.screenInfo as Record<string, unknown> | undefined)?.width) ??
          num((raw.size as Record<string, unknown> | undefined)?.width) ??
          num((raw.specs as Record<string, unknown> | undefined)?.width);
        const h =
          num(raw.height) ?? num(raw.screenHeight) ?? num(raw.pixelHeight) ??
          num((raw.screenInfo as Record<string, unknown> | undefined)?.height) ??
          num((raw.size as Record<string, unknown> | undefined)?.height) ??
          num((raw.specs as Record<string, unknown> | undefined)?.height);
        if (w && h) {
          widthPx = w;
          heightPx = h;
        } else {
          // No structured fields — try every string field that might
          // carry the resolution. VNNOX uses `*` as the separator
          // ("240*120"), and other vendors use 'x' or '×', so the regex
          // accepts all three.
          const stringSources: unknown[] = [
            raw.resolution,
            raw.screenResolution,
            raw.size,
            raw.screenSize,
            raw.pixels,
          ];
          for (const src of stringSources) {
            if (typeof src === 'string') {
              const m = src.match(/(\d+)\s*[x×*]\s*(\d+)/i);
              if (m) {
                widthPx = parseInt(m[1], 10);
                heightPx = parseInt(m[2], 10);
                break;
              }
            }
          }
        }
        if (!widthPx || !heightPx) {
          // Diagnostic: dump every key on the screen-list item so we can
          // see what VNNOX actually returns for this tier. After one
          // Pull-from-VNNOX click, the Railway log shows the answer.
          // eslint-disable-next-line no-console
          console.warn(
            `[vnnox] no resolution for sn=${this.sn}; screen-list keys=` +
            JSON.stringify(Object.keys(raw)) +
            ` raw=` + JSON.stringify(raw),
          );
        }
      }
    } catch {
      // swallow — best-effort enrichment
    }

    return {
      online: player.onlineStatus === 1,
      brightness,
      widthPx,
      heightPx,
    };
  }

  async setBrightness(percent: number): Promise<void> {
    if (percent < 0 || percent > 100) throw new CoexError('brightness must be 0..100', 'PROTOCOL');
    const playerId = await this.resolvePlayerId();
    // NovaStar rejected { brightness: percent } with "json key 【value】is required",
    // so the field is `value`. Keep this in sync with similar real-time-control
    // endpoints (volume, etc.) if we add them.
    await this.request<BatchResult>(
      'POST',
      '/v2/player/real-time-control/brightness',
      { playerIds: [playerId], value: percent },
    );
  }

  async pushPlaylist(manifest: PlaylistManifest): Promise<void> {
    if (manifest.items.length === 0) {
      throw new CoexError('vnnox pushPlaylist requires at least one media item', 'PROTOCOL');
    }
    const playerId = await this.resolvePlayerId();

    // One page per media item → sequential playback. Each page holds a single
    // full-screen widget. Without a `schedule` field the program loops 24/7,
    // which matches the playlist.loop=true contract; we treat loop=false as
    // a single pass by setting repeatCount=1 (default) — VNNOX still cycles
    // through pages, so true no-loop isn't achievable without a schedule.
    const pages = manifest.items.map((item, i) => ({
      name: `page-${i + 1}`,
      widgets: [buildMediaWidget(item)],
    }));

    // /v2/player/program/normal both creates the program and publishes it to
    // the target players in a single call. Response: { success: [...], fail: [...] }.
    const result = await this.request<BatchResult>(
      'POST',
      '/v2/player/program/normal',
      { playerIds: [playerId], pages },
    );
    if (result?.fail && result.fail.includes(playerId)) {
      throw new CoexError(
        `vnnox rejected publish for playerId=${playerId} (fail list returned)`,
        'DEVICE_ERROR',
      );
    }
  }

  async play(_playlistId: string): Promise<void> {
    // VNNOX's /v2/player/program/normal both publishes and activates the program,
    // so there's nothing to do here — pushPlaylist has already started playback.
    // Re-issuing a control call could fight with the publish. No-op.
  }

  async stop(): Promise<void> {
    // Documented as the "screen-status" endpoint (CLOSE = black screen).
    const playerId = await this.resolvePlayerId();
    await this.request<BatchResult>(
      'POST',
      '/v2/player/real-time-control/screen-status',
      { playerIds: [playerId], status: 'CLOSE' },
    );
  }

  async reboot(): Promise<void> {
    const playerId = await this.resolvePlayerId();
    await this.request<BatchResult>(
      'POST',
      '/v2/player/real-time-control/reboot',
      { playerIds: [playerId] },
    );
  }

  async close(): Promise<void> {
    // No persistent state; HTTP is stateless.
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildMediaWidget(item: PlaylistManifestItem) {
  if (!item.checksumMd5) {
    throw new CoexError(
      `vnnox widget for media ${item.mediaId} is missing checksumMd5 — backfill before deploy`,
      'PROTOCOL',
    );
  }
  if (!item.sizeBytes || item.sizeBytes <= 0) {
    throw new CoexError(
      `vnnox widget for media ${item.mediaId} is missing sizeBytes`,
      'PROTOCOL',
    );
  }
  const widget: Record<string, unknown> = {
    type: widgetTypeFor(item.mimeType),
    name: item.mediaId,
    md5: item.checksumMd5,
    size: item.sizeBytes,
    duration: item.durationMs,
    url: item.url,
    zIndex: 0,
    // VNNOX layout dimensions are percentages, not pixels (their validator
    // rejects raw numbers with "must be Percentage"). Full-screen = 100%.
    layout: { x: '0%', y: '0%', width: '100%', height: '100%' },
  };

  // VIDEO widgets need codec/fps/dimensions/byteRate or the Taurus accepts the
  // program but shows a frozen first frame (images don't carry these, which is
  // why images always worked and video never did). NovaStar expects these as
  // STRINGS. Only emit them when ffprobe actually gave us real metadata —
  // otherwise fall back to the bare widget (same as legacy behaviour) rather
  // than send empty/zero fields.
  if (item.mimeType.startsWith('video/') && item.widthPx && item.heightPx && item.fps && item.codec) {
    widget.width = String(item.widthPx);
    widget.height = String(item.heightPx);
    widget.fps = String(item.fps);
    widget.codec = item.codec;
    widget.postfix = (item.url.split('.').pop() || 'mp4').toLowerCase();
    if (item.byteRateKbps) widget.byteRate = String(item.byteRateKbps);
  }

  return widget;
}
