import { HttpCoexClient } from '../src/coex/httpClient';
import { CoexError } from '../src/coex/types';

describe('HttpCoexClient', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends X-Device-Key on requests', async () => {
    let received: Headers | undefined;
    global.fetch = (async (_url: any, init: any) => {
      received = new Headers(init?.headers);
      return new Response(JSON.stringify({ deviceKey: 'k', model: 'm', firmware: 'f' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const c = new HttpCoexClient({ host: '10.0.0.1', port: 5000, deviceKey: 'abc', retries: 0 });
    await c.handshake();
    expect(received?.get('x-device-key')).toBe('abc');
  });

  it('maps 401 to AUTH error and does not retry', async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return new Response('nope', { status: 401 });
    }) as typeof fetch;

    const c = new HttpCoexClient({ host: '10.0.0.1', deviceKey: 'k', retries: 3, timeoutMs: 100 });
    await expect(c.handshake()).rejects.toMatchObject({ code: 'AUTH' });
    expect(calls).toBe(1);
  });

  it('retries on transient failure then throws UNREACHABLE', async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      throw new Error('econnrefused');
    }) as typeof fetch;

    const c = new HttpCoexClient({ host: '10.0.0.1', deviceKey: 'k', retries: 2, timeoutMs: 100 });
    await expect(c.handshake()).rejects.toBeInstanceOf(CoexError);
    expect(calls).toBe(3); // initial + 2 retries
  });
});
