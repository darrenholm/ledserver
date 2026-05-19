import {
  CoexError,
  CoexTransport,
  DeviceInfo,
  DeviceStatus,
  PlaylistManifest,
} from './types';

export interface MockState {
  info: DeviceInfo;
  status: DeviceStatus;
  pushedPlaylists: PlaylistManifest[];
  currentPlaylistId?: string;
  playing: boolean;
  rebootCount: number;
  failNext?: 'timeout' | 'unreachable' | 'auth';
}

export class MockCoexController implements CoexTransport {
  public state: MockState;

  constructor(initial?: Partial<MockState>) {
    this.state = {
      info: {
        deviceKey: 'MOCK-DEVICE-KEY',
        model: 'Taurus T6 (mock)',
        firmware: '1.0.0-mock',
        widthPx: 1920,
        heightPx: 1080,
      },
      status: {
        online: true,
        brightness: 80,
        temperatureC: 42,
        uptimeSec: 0,
      },
      pushedPlaylists: [],
      playing: false,
      rebootCount: 0,
      ...initial,
    };
  }

  private maybeFail() {
    const f = this.state.failNext;
    if (!f) return;
    this.state.failNext = undefined;
    if (f === 'timeout') throw new CoexError('mock timeout', 'TIMEOUT');
    if (f === 'unreachable') throw new CoexError('mock unreachable', 'UNREACHABLE');
    if (f === 'auth') throw new CoexError('mock auth', 'AUTH');
  }

  async handshake(): Promise<DeviceInfo> {
    this.maybeFail();
    return { ...this.state.info };
  }

  async getStatus(): Promise<DeviceStatus> {
    this.maybeFail();
    return { ...this.state.status, currentPlaylistId: this.state.currentPlaylistId };
  }

  async setBrightness(percent: number): Promise<void> {
    this.maybeFail();
    if (percent < 0 || percent > 100) throw new CoexError('brightness must be 0..100', 'PROTOCOL');
    this.state.status.brightness = percent;
  }

  async pushPlaylist(manifest: PlaylistManifest): Promise<void> {
    this.maybeFail();
    this.state.pushedPlaylists.push(manifest);
  }

  async play(playlistId: string): Promise<void> {
    this.maybeFail();
    const known = this.state.pushedPlaylists.some((p) => p.playlistId === playlistId);
    if (!known) throw new CoexError(`unknown playlist ${playlistId}`, 'DEVICE_ERROR');
    this.state.currentPlaylistId = playlistId;
    this.state.playing = true;
  }

  async stop(): Promise<void> {
    this.maybeFail();
    this.state.playing = false;
    this.state.currentPlaylistId = undefined;
  }

  async reboot(): Promise<void> {
    this.maybeFail();
    this.state.rebootCount += 1;
    this.state.playing = false;
    this.state.currentPlaylistId = undefined;
    this.state.status.uptimeSec = 0;
  }

  async close(): Promise<void> {
    // no-op
  }
}
