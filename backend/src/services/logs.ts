import { query } from '../db';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSource = 'api' | 'coex' | 'device' | 'system';

export async function writeLog(
  level: LogLevel,
  source: LogSource,
  message: string,
  deviceId?: string | null,
  details?: Record<string, unknown>,
  organizationId?: string | null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO logs (level, source, message, device_id, details, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        level,
        source,
        message,
        deviceId ?? null,
        details ? JSON.stringify(details) : null,
        organizationId ?? null,
      ],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('writeLog failed:', err);
  }
}
