import { CoexError, CoexTransport, DeviceInfo, DeviceStatus, PlaylistManifest } from './types';
import { config } from '../config';

export interface LanDirectClientOptions {
  host: string;
  port?: number;        // defaults to 5200 (Taurus / NovaStar protocol port)
  deviceKey?: string;
  timeoutMs?: number;
}

/**
 * LanDirectClient — DIAGNOSTIC stub for talking directly to a Taurus on port 5200.
 *
 * The wire protocol is NovaStar's binary COEX framing (the same family `@novastar/codec`
 * and `@novastar/net` target). Decoding it for Taurus async controllers is a
 * separate reverse-engineering task — see docs/lan-protocol.md once we capture
 * real ViPlex Express traffic with Wireshark.
 *
 * Until that work lands, this client only supports a TCP reachability check (the
 * one thing we can do without knowing the framing). All higher-level operations
 * throw PROTOCOL until the wire format is decoded.
 *
 * Usage: only super-admins running on the same LAN as the controller should
 * register devices with provider='lan_direct'. Customers' production devices
 * should always use provider='vnnox'.
 */
export class LanDirectClient implements CoexTransport {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(opts: LanDirectClientOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 5200;
    this.timeoutMs = opts.timeoutMs ?? config.coex.timeoutMs;
  }

  private async tcpReach(): Promise<void> {
    const net = await import('net');
    await new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new CoexError(`tcp connect to ${this.host}:${this.port} timed out`, 'TIMEOUT'));
      }, this.timeoutMs);
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(new CoexError(`tcp connect failed: ${err.message}`, 'UNREACHABLE', err));
      });
      socket.connect(this.port, this.host, () => {
        clearTimeout(timer);
        socket.end();
        resolve();
      });
    });
  }

  async handshake(): Promise<DeviceInfo> {
    await this.tcpReach();
    return {
      deviceKey: 'LAN-DIRECT-STUB',
      model: 'Taurus (LAN, protocol not decoded)',
      firmware: 'unknown',
    };
  }

  async getStatus(): Promise<DeviceStatus> {
    await this.tcpReach();
    // We can confirm TCP is reachable but can't read brightness/etc. without
    // the protocol decoder. Report online=true based on reachability only.
    return { online: true, brightness: 0 };
  }

  async setBrightness(_percent: number): Promise<void> {
    throw new CoexError('lan_direct.setBrightness not implemented (wire protocol not decoded)', 'PROTOCOL');
  }

  async pushPlaylist(_manifest: PlaylistManifest): Promise<void> {
    throw new CoexError('lan_direct.pushPlaylist not implemented', 'PROTOCOL');
  }

  async play(_playlistId: string): Promise<void> {
    throw new CoexError('lan_direct.play not implemented', 'PROTOCOL');
  }

  async stop(): Promise<void> {
    throw new CoexError('lan_direct.stop not implemented', 'PROTOCOL');
  }

  async reboot(): Promise<void> {
    throw new CoexError('lan_direct.reboot not implemented', 'PROTOCOL');
  }

  async close(): Promise<void> {
    // no persistent socket yet
  }
}
