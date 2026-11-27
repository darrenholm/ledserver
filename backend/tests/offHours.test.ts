jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/coex/registry', () => ({ coexRegistry: { get: jest.fn() } }));
jest.mock('../src/services/logs', () => ({ writeLog: jest.fn() }));
import { isInOffWindow } from '../src/services/screenPowerScheduler';

const d = { screen_off_enabled: true, screen_off_start: '23:30:00', screen_off_end: '06:00:00', screen_off_tz: 'America/Toronto' };

test.each([
  ['2026-11-28T04:29:00Z', false], // 23:29 EST
  ['2026-11-28T04:30:00Z', true],  // 23:30 EST
  ['2026-11-28T08:00:00Z', true],  // 03:00
  ['2026-11-28T10:59:00Z', true],  // 05:59
  ['2026-11-28T11:00:00Z', false], // 06:00
  ['2026-11-28T17:00:00Z', false], // noon
  ['2026-07-01T03:30:00Z', true],  // 23:30 EDT
])('%s -> %s', (t, expected) => {
  expect(isInOffWindow(d, new Date(t))).toBe(expected);
});

test('disabled never off', () => {
  expect(isInOffWindow({ ...d, screen_off_enabled: false }, new Date('2026-11-28T08:00:00Z'))).toBe(false);
});
