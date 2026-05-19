import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { ipWhitelist } from './middleware/ipWhitelist';
import { errorHandler } from './middleware/errorHandler';
import { config } from './config';
import authRouter from './routes/auth';
import devicesRouter from './routes/devices';
import playlistsRouter from './routes/playlists';
import mediaRouter from './routes/media';
import logsRouter from './routes/logs';

const MEDIA_FILES_DIR = path.join(process.cwd(), 'media', 'uploads');

export function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(
    helmet({
      // /files static responses don't need a CSP and we set our own headers via Caddy.
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

  // Static media: Taurus controllers HTTP-pull from this path.
  // In docker-compose dev, nginx serves /media/uploads/* and this route is unused.
  // On Railway, the API itself serves files from a mounted volume.
  app.use(
    '/files/uploads',
    express.static(MEDIA_FILES_DIR, {
      maxAge: '1h',
      fallthrough: false,
    }),
  );

  app.use('/auth', authRouter);
  app.use('/devices', devicesRouter);
  app.use('/playlists', playlistsRouter);
  app.use('/media', mediaRouter);
  app.use('/logs', logsRouter);

  app.use(errorHandler);
  return app;
}
