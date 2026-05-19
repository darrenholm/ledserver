import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import { ipWhitelist } from './middleware/ipWhitelist';
import { errorHandler } from './middleware/errorHandler';
import authRouter from './routes/auth';
import devicesRouter from './routes/devices';
import playlistsRouter from './routes/playlists';
import mediaRouter from './routes/media';
import logsRouter from './routes/logs';

export function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(ipWhitelist);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  app.use('/auth', authRouter);
  app.use('/devices', devicesRouter);
  app.use('/playlists', playlistsRouter);
  app.use('/media', mediaRouter);
  app.use('/logs', logsRouter);

  app.use(errorHandler);
  return app;
}
