import { LanDirectClient } from './lanDirectClient';
import { CoexTransport } from './types';
import { VnnoxCloudClient } from './vnnoxClient';

export type DeviceProvider = 'vnnox' | 'lan_direct' | 'mock';

export interface DeviceConnInfo {
  id: string;
  provider: DeviceProvider;
  /**
   * For vnnox: the device SN. For lan_direct: any local identifier.
   * Stored in the devices.device_key column.
   */
  deviceKey: string;
  /** For lan_direct only — LAN address of the controller. */
  ipAddress?: string;
  /** For lan_direct only — port (default 5200). */
  port?: number;
}

type Factory = (d: DeviceConnInfo) => CoexTransport;

const defaultFactory: Factory = (d) => {
  switch (d.provider) {
    case 'vnnox':
      return new VnnoxCloudClient({ sn: d.deviceKey });
    case 'lan_direct':
      if (!d.ipAddress) throw new Error('lan_direct device is missing ipAddress');
      return new LanDirectClient({ host: d.ipAddress, port: d.port, deviceKey: d.deviceKey });
    case 'mock': {
      // Lazy require so tests don't pull in network deps unnecessarily.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MockCoexController } = require('./mock');
      return new MockCoexController();
    }
    default:
      throw new Error(`unknown device provider: ${(d as DeviceConnInfo).provider}`);
  }
};

/**
 * Per-process registry of CoexTransport instances, keyed by device id.
 * The factory is injectable so tests can substitute MockCoexController.
 */
export class CoexRegistry {
  private clients = new Map<string, CoexTransport>();

  constructor(private factory: Factory = defaultFactory) {}

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
