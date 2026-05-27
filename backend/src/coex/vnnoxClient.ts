import { config } from '../config';
import {
  CoexError,
  CoexTransport,
  DeviceInfo,
  DeviceStatus,
  PlaylistManifest,
  PlaylistManifestItem,
} from './types';
import { signRequest, vnnoxBaseUrl } from './vnnoxSign';

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
    const headers: Record<string, string> = { ...signRequest() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
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
    try {
      const screens = await this.request<{ items: ScreenListItem[] }>(
        'GET',
        '/v2/device-status-monitor/screen/list?pageNumber=0&pageSize=1000',
      );
      const hit = screens.items?.find((s) => s.sn === this.sn);
      if (hit) {
        if (typeof hit.brightness === 'number') brightness = hit.brightness;
        // Prefer the structured width/height fields if VNNOX returns them;
        // fall back to parsing the legacy "WIDTHxHEIGHT" string.
        if (typeof hit.width === 'number' && typeof hit.height === 'number') {
          widthPx = hit.width;
          heightPx = hit.height;
        } else if (typeof hit.resolution === 'string') {
          const m = hit.resolution.match(/(\d+)\s*[x×]\s*(\d+)/i);
          if (m) {
            widthPx = parseInt(m[1], 10);
            heightPx = parseInt(m[2], 10);
          }
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
  return {
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
}
