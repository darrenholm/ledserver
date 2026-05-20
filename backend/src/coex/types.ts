export interface DeviceInfo {
  deviceKey: string;
  model: string;
  firmware: string;
  widthPx?: number;
  heightPx?: number;
}

export interface DeviceStatus {
  online: boolean;
  brightness: number;     // 0-100
  temperatureC?: number;
  currentPlaylistId?: string;
  uptimeSec?: number;
}

export interface PlaylistManifestItem {
  mediaId: string;
  url: string;            // public URL the device will pull from
  mimeType: string;
  durationMs: number;
  sizeBytes: number;
  checksumSha256?: string;
  /** Lowercase hex MD5 — required by VNNOX widget payloads. May be lazily backfilled. */
  checksumMd5?: string;
  widthPx?: number;
  heightPx?: number;
}

export interface PlaylistManifest {
  playlistId: string;
  loop: boolean;
  items: PlaylistManifestItem[];
  /** Target device dimensions, used to build a full-screen layout for cloud providers like VNNOX. */
  deviceWidthPx?: number;
  deviceHeightPx?: number;
}

/**
 * Abstract COEX transport. The real Taurus implementation talks HTTP-RPC
 * to the controller; the mock implementation lives in-process for tests.
 *
 * NOTE: Protocol details (request envelopes, auth handshake, error codes)
 * are placeholders pending a real-device test. See README "Open questions".
 */
export interface CoexTransport {
  handshake(): Promise<DeviceInfo>;
  getStatus(): Promise<DeviceStatus>;
  setBrightness(percent: number): Promise<void>;
  pushPlaylist(manifest: PlaylistManifest): Promise<void>;
  play(playlistId: string): Promise<void>;
  stop(): Promise<void>;
  reboot(): Promise<void>;
  close(): Promise<void>;
}

export class CoexError extends Error {
  constructor(
    message: string,
    public readonly code: 'TIMEOUT' | 'UNREACHABLE' | 'AUTH' | 'PROTOCOL' | 'DEVICE_ERROR',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CoexError';
  }
}
