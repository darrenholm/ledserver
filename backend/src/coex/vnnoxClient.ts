import { config } from '../config';
import {
  CoexError,
  CoexTransport,
  DeviceInfo,
  DeviceStatus,
  PlaylistManifest,
} from './types';
import { signRequest, vnnoxBaseUrl } from './vnnoxSign';

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

interface ScreenListItem {
  sid: number;
  name: string;
  mac: string;
  sn: string;
  address?: string;
  status: number; // 1 normal, 2 offline, 3 risky, 4 faulty
  brightness: number;
  envBrightness?: number;
}

interface MasterControlBasics {
  status: boolean;
  signalSource: string;
  networkPortsNum?: number;
  version: string;
  sn: string;
  mac: string;
  timeZone: string;
  reportTime: string;
}

interface BatchResult {
  success: string[];
  fail: string[];
}

const SCREEN_STATUS = { ONLINE: 1, OFFLINE: 2, RISKY: 3, FAULTY: 4 } as const;

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

  /** Look up playerId for this device's SN by scanning the screen list. Caches the result. */
  private async resolvePlayerId(): Promise<string> {
    if (this.playerId) return this.playerId;
    // Scan up to 1000 screens at once (API max); for >1000 devices we'd page.
    const result = await this.request<{ total: number; items: ScreenListItem[] }>(
      'GET',
      '/v2/device-status-monitor/screen/list?pageNumber=0&pageSize=1000',
    );
    const hit = result.items.find((s) => s.sn === this.sn);
    if (!hit) {
      throw new CoexError(`device sn=${this.sn} not found in VNNOX screen list`, 'DEVICE_ERROR');
    }
    // The "playerId" in real-time-control APIs isn't directly returned by screen list.
    // It typically matches `sid` formatted as hex or is fetched from a separate endpoint.
    // For now we use `sid` as a string — TODO: confirm against a real call and add a
    // dedicated `/v2/player/...` lookup if needed.
    this.playerId = String(hit.sid);
    return this.playerId;
  }

  // ----- CoexTransport implementation -----

  async handshake(): Promise<DeviceInfo> {
    const basics = await this.request<MasterControlBasics>(
      'GET',
      `/v2/device-status-monitor/master-control/basics/${encodeURIComponent(this.sn)}`,
    );
    return {
      deviceKey: basics.sn,
      model: 'Taurus / VNNOX',
      firmware: basics.version,
    };
  }

  async getStatus(): Promise<DeviceStatus> {
    // Pull from the screen list which carries brightness, status, etc.
    const result = await this.request<{ items: ScreenListItem[] }>(
      'GET',
      `/v2/device-status-monitor/screen/list?pageNumber=0&pageSize=1000`,
    );
    const hit = result.items.find((s) => s.sn === this.sn);
    if (!hit) throw new CoexError(`device sn=${this.sn} not found`, 'DEVICE_ERROR');
    return {
      online: hit.status === SCREEN_STATUS.ONLINE,
      brightness: hit.brightness,
    };
  }

  async setBrightness(percent: number): Promise<void> {
    if (percent < 0 || percent > 100) throw new CoexError('brightness must be 0..100', 'PROTOCOL');
    const playerId = await this.resolvePlayerId();
    // TODO: validate the exact endpoint shape against a live API call.
    // Best candidate based on docs: POST /v2/player/real-time-control/brightness
    //   body: { playerIds: [id], brightness: percent }
    await this.request<BatchResult>(
      'POST',
      '/v2/player/real-time-control/brightness',
      { playerIds: [playerId], brightness: percent },
    );
  }

  async pushPlaylist(_manifest: PlaylistManifest): Promise<void> {
    // VNNOX content publishing is a multi-step process (create solution → schedule → publish).
    // Implementation deferred until we exercise the Media APIs against the real account.
    throw new CoexError(
      'pushPlaylist not yet implemented for vnnox provider — use the VNNOX console for now, or implement via the Media APIs',
      'PROTOCOL',
    );
  }

  async play(_playlistId: string): Promise<void> {
    throw new CoexError('play() not yet wired up for vnnox provider', 'PROTOCOL');
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
