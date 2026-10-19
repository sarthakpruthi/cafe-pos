import express, { type RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { authenticate, originCheck } from './auth.js';
import { router, errorHandler } from './routes.js';
import { jsonBody } from './body.js';

export interface AppOptions {
  /** Serve the built React app from disk. Off on Workers, where the assets binding does that. */
  serveStatic?: boolean;
  /** Mounted under /api before the routes. The Workers build passes its Hyperdrive middleware here. */
  dbMiddleware?: RequestHandler;
}

export function createApp(opts: AppOptions = {}) {
  const app = express();
  if (config.isProd) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => { req.id = randomUUID(); res.setHeader('X-Request-Id', req.id); next(); });
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(cors({ origin: [config.frontendUrl, config.apiBaseUrl], credentials: true }));
  app.use(jsonBody);
  app.use(cookieParser());
  if (opts.dbMiddleware) app.use('/api', opts.dbMiddleware);
  app.use('/api/v1', originCheck, authenticate, router);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.', details: {} } }));

  if (opts.serveStatic !== false) {
    const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
    if (fs.existsSync(web)) {
      app.use(express.static(web, { index: false, maxAge: '1h' }));
      app.get('*', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(web, 'index.html')); });
    }
  }
  app.use(errorHandler);
  return app;
}
