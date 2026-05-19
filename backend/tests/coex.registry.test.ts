import { CoexRegistry } from '../src/coex/registry';
import { MockCoexController } from '../src/coex/mock';

describe('CoexRegistry', () => {
  it('returns the same instance for the same device id', () => {
    const reg = new CoexRegistry(() => new MockCoexController());
    const a = reg.get({ id: 'd1', ipAddress: '10.0.0.1', port: 5000, deviceKey: 'k' });
    const b = reg.get({ id: 'd1', ipAddress: '10.0.0.1', port: 5000, deviceKey: 'k' });
    expect(a).toBe(b);
  });

  it('drops a device and re-creates on next get', async () => {
    const reg = new CoexRegistry(() => new MockCoexController());
    const a = reg.get({ id: 'd1', ipAddress: '10.0.0.1', port: 5000, deviceKey: 'k' });
    await reg.drop('d1');
    const b = reg.get({ id: 'd1', ipAddress: '10.0.0.1', port: 5000, deviceKey: 'k' });
    expect(a).not.toBe(b);
  });
});
