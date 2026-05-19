import { MockCoexController } from '../src/coex/mock';
import { CoexError } from '../src/coex/types';

describe('MockCoexController', () => {
  it('handshakes with default info', async () => {
    const m = new MockCoexController();
    const info = await m.handshake();
    expect(info.model).toContain('Taurus');
    expect(info.deviceKey).toBe('MOCK-DEVICE-KEY');
  });

  it('rejects out-of-range brightness', async () => {
    const m = new MockCoexController();
    await expect(m.setBrightness(150)).rejects.toBeInstanceOf(CoexError);
  });

  it('records brightness changes', async () => {
    const m = new MockCoexController();
    await m.setBrightness(42);
    const status = await m.getStatus();
    expect(status.brightness).toBe(42);
  });

  it('pushes a playlist and plays it', async () => {
    const m = new MockCoexController();
    await m.pushPlaylist({
      playlistId: 'pl-1',
      loop: true,
      items: [{ mediaId: 'm1', url: 'http://x/u1.mp4', mimeType: 'video/mp4', durationMs: 5000 }],
    });
    await m.play('pl-1');
    expect(m.state.currentPlaylistId).toBe('pl-1');
    expect(m.state.playing).toBe(true);
  });

  it('refuses to play unknown playlist', async () => {
    const m = new MockCoexController();
    await expect(m.play('nope')).rejects.toBeInstanceOf(CoexError);
  });

  it('reboot resets state and increments counter', async () => {
    const m = new MockCoexController();
    await m.pushPlaylist({ playlistId: 'pl-1', loop: false, items: [] });
    await m.play('pl-1');
    await m.reboot();
    expect(m.state.rebootCount).toBe(1);
    expect(m.state.playing).toBe(false);
    expect(m.state.currentPlaylistId).toBeUndefined();
  });

  it('simulates injected failures', async () => {
    const m = new MockCoexController();
    m.state.failNext = 'timeout';
    await expect(m.handshake()).rejects.toMatchObject({ code: 'TIMEOUT' });
    // failure is one-shot
    await expect(m.handshake()).resolves.toBeDefined();
  });
});
