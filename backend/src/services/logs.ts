import { query } from '../db';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSource = 'api' | 'coex' | 'device' | 'system';

export async function writeLog(
  level: LogLevel,
  source: LogSource,
  message: string,
  deviceId?: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      `INSERT INTO logs (level, source, message, device_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [level, source, message, deviceId ?? null, details ? JSON.stringify(details) : null],
    );
  } catch (err) {
    // Logging failure must never break the calling request.
    // eslint-disable-next-line no-console
    console.error('writeLog failed:', err);
  }
}
