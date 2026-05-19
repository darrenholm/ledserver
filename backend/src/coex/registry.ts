import { HttpCoexClient } from './httpClient';
import { CoexTransport } from './types';

export interface DeviceConnInfo {
  id: string;
  ipAddress: string;
  port: number;
  deviceKey: string;
}

type Factory = (d: DeviceConnInfo) => CoexTransport;

/**
 * Per-process registry of CoexTransport instances, keyed by device id.
 * The factory is injectable so tests can substitute MockCoexController.
 */
export class CoexRegistry {
  private clients = new Map<string, CoexTransport>();

  constructor(private factory: Factory = (d) => new HttpCoexClient({ host: d.ipAddress, port: d.port, deviceKey: d.deviceKey })) {}

  get(device: DeviceConnInfo): CoexTransport {
    let c = this.clients.get(device.id);
    if (!c) {
      c = this.factory(device);
      this.clients.set(device.id, c);
    }
    return c;
  }

  async drop(deviceId: string): Promise<void> {
    const c = this.clients.get(deviceId);
    if (c) {
      await c.close().catch(() => undefined);
      this.clients.delete(deviceId);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => undefined)));
    this.clients.clear();
  }
}

export const coexRegistry = new CoexRegistry();
