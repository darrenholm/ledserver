import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'fs';
import path from 'path';
import { ipWhitelist } from './middleware/ipWhitelist';
import { errorHandler } from './middleware/errorHandler';
import { config } from './config';
import authRouter from './routes/auth';
import devicesRouter from './routes/devices';
import playlistsRouter from './routes/playlists';
import mediaRouter from './routes/media';
import logsRouter from './routes/logs';
import orgsRouter from './routes/organizations';
import usersRouter from './routes/users';
import publicRentalsRouter from './routes/publicRentals';
import rentalsRouter from './routes/rentals';

const MEDIA_FILES_DIR = path.join(process.cwd(), 'media', 'uploads');
// The frontend build is copied here by the Dockerfile; absent in local dev.
const FRONTEND_DIST = path.join(process.cwd(), 'public');

export function createApp(): express.Express {
  const app = express();
  // Railway sits one proxy hop in front of us. Trust exactly that hop so X-Forwarded-For
  // reflects the real client IP but can't be spoofed past Railway's edge.
  app.set('trust proxy', 1);
  app.use(
    helmet({
      // SPA + inline scripts from Vite would need a tailored CSP; disable for now.
      contentSecurityPolicy: false,
    }),
  );

  const allowedOrigins = config.corsAllowedOrigins;
  app.use(
    cors({
      origin: allowedOrigins.length === 0 ? true : allowedOrigins,
      credentials: false,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(ipWhitelist);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // --- API routes (mounted under /api) ---
  const api = express.Router();
  api.use('/auth', authRouter);
  api.use('/organizations', orgsRouter);
  api.use('/users', usersRouter);
  api.use('/devices', devicesRouter);
  api.use('/playlists', playlistsRouter);
  api.use('/media', mediaRouter);
  api.use('/logs', logsRouter);
  api.use('/rentals', rentalsRouter);                  // super_admin + token-link approve/reject
  api.use('/public', publicRentalsRouter);             // no-auth public marketplace endpoints
  app.use('/api', api);

  // --- Public media (Taurus controllers HTTP-pull from here) ---
  app.use(
    '/files/uploads',
    express.static(MEDIA_FILES_DIR, {
      maxAge: '1h',
      fallthrough: false,
    }),
  );

  // --- Frontend SPA (only if bundled into the image) ---
  if (fs.existsSync(FRONTEND_DIST)) {
    app.use(express.static(FRONTEND_DIST, { maxAge: '1h', index: false }));
    // SPA fallback: any non-API GET that doesn't match a file → index.html
    app.get(/^\/(?!api\/|files\/|health$).*/, (_req, res) => {
      res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
