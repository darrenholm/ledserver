import {
  CoexError,
  CoexTransport,
  DeviceInfo,
  DeviceStatus,
  PlaylistManifest,
} from './types';
import { config } from '../config';

export interface HttpCoexClientOptions {
  host: string;
  port?: number;
  deviceKey: string;
  timeoutMs?: number;
  retries?: number;
}

/**
 * HTTP-based COEX client for Taurus controllers.
 *
 * Endpoints below are PLACEHOLDERS based on the public NovaStar pattern.
 * Validate against a real device and adjust paths/payload shapes accordingly:
 *   - device handshake: /api/v1/device/info
 *   - status:           /api/v1/device/status
 *   - brightness:       /api/v1/display/brightness
 *   - playlist push:    /api/v1/playlist
 *   - play/stop:        /api/v1/playlist/{id}/play|stop
 *   - reboot:           /api/v1/device/reboot
 *
 * Once @novastar/net is wired in (or replaced with a hand-rolled client),
 * implement these methods against the real wire protocol.
 */
export class HttpCoexClient implements CoexTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly deviceKey: string;

  constructor(opts: HttpCoexClientOptions) {
    const port = opts.port ?? config.coex.defaultPort;
    this.baseUrl = `http://${opts.host}:${port}`;
    this.timeoutMs = opts.timeoutMs ?? config.coex.timeoutMs;
    this.retries = opts.retries ?? config.coex.retries;
    this.deviceKey = opts.deviceKey;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Key': this.deviceKey,
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        clearTimeout(timer);
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            throw new CoexError(`auth rejected (${res.status})`, 'AUTH');
          }
          throw new CoexError(`device returned ${res.status}`, 'DEVICE_ERROR');
        }
        return (await res.json()) as T;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (err instanceof CoexError && err.code === 'AUTH') throw err;
        if (attempt === this.retries) break;
      }
    }
    if (lastErr instanceof CoexError) throw lastErr;
    const isAbort = (lastErr as Error)?.name === 'AbortError';
    throw new CoexError(
      isAbort ? `timeout after ${this.timeoutMs}ms` : `unreachable: ${(lastErr as Error)?.message}`,
      isAbort ? 'TIMEOUT' : 'UNREACHABLE',
      lastErr,
    );
  }

  handshake(): Promise<DeviceInfo> {
    return this.request<DeviceInfo>('GET', '/api/v1/device/info');
  }

  getStatus(): Promise<DeviceStatus> {
    return this.request<DeviceStatus>('GET', '/api/v1/device/status');
  }

  async setBrightness(percent: number): Promise<void> {
    if (percent < 0 || percent > 100) throw new CoexError('brightness must be 0..100', 'PROTOCOL');
    await this.request<void>('POST', '/api/v1/display/brightness', { brightness: percent });
  }

  async pushPlaylist(manifest: PlaylistManifest): Promise<void> {
    await this.request<void>('POST', '/api/v1/playlist', manifest);
  }

  async play(playlistId: string): Promise<void> {
    await this.request<void>('POST', `/api/v1/playlist/${encodeURIComponent(playlistId)}/play`);
  }

  async stop(): Promise<void> {
    await this.request<void>('POST', '/api/v1/playlist/stop');
  }

  async reboot(): Promise<void> {
    await this.request<void>('POST', '/api/v1/device/reboot');
  }

  async close(): Promise<void> {
    // HTTP is stateless; nothing to close.
  }
}
