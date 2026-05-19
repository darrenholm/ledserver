import { CoexRegistry } from '../src/coex/registry';
import { MockCoexController } from '../src/coex/mock';

const d1 = { id: 'd1', provider: 'mock' as const, deviceKey: 'k', ipAddress: '10.0.0.1', port: 5000 };

describe('CoexRegistry', () => {
  it('returns the same instance for the same device id', () => {
    const reg = new CoexRegistry(() => new MockCoexController());
    const a = reg.get(d1);
    const b = reg.get(d1);
    expect(a).toBe(b);
  });

  it('drops a device and re-creates on next get', async () => {
    const reg = new CoexRegistry(() => new MockCoexController());
    const a = reg.get(d1);
    await reg.drop('d1');
    const b = reg.get(d1);
    expect(a).not.toBe(b);
  });

  it('default factory picks transport based on provider', () => {
    const reg = new CoexRegistry();
    // mock provider should resolve to MockCoexController without external calls
    const c = reg.get({ id: 'd2', provider: 'mock', deviceKey: 'k' });
    expect(c.constructor.name).toBe('MockCoexController');
  });
});
