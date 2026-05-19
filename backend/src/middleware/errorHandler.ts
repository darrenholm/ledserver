import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { CoexError } from '../coex/types';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation', issues: err.issues });
    return;
  }
  if (err instanceof CoexError) {
    const status = err.code === 'AUTH' ? 401 : err.code === 'TIMEOUT' || err.code === 'UNREACHABLE' ? 504 : 502;
    res.status(status).json({ error: 'coex', code: err.code, message: err.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('unhandled error:', err);
  res.status(500).json({ error: 'internal' });
}
