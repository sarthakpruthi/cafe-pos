// Cloudflare Worker entry (Workers Free plan).
//
//   /api/v1/events, /api/v1/public/events  -> SSE, served by the RealtimeHub Durable Object
//   /api/*                                 -> the Express API (cloudflare:node), Postgres via Hyperdrive
//   /*                                     -> the built React app from static assets
//
// Express runs unchanged on Workers; only the database connection (driver) and the SSE fan-out
// (Durable Object) differ from the Node build. See docs/DEPLOY_CLOUDFLARE.md.
import { handleAsNodeRequest } from 'cloudflare:node';
import { createApp } from '../apps/api/src/app.js';
import { hyperdriveMiddleware } from '../apps/api/src/drivers/worker.js';
import { setPublisher } from '../apps/api/src/realtime.js';
import type { Env } from './env.js';
import { RealtimeHub } from './realtime-do.js';
import { handleStream } from './stream.js';

const PORT = 3000;

let prepared = false;
function prepare(env: Env) {
  if (prepared) return;
  prepared = true;
  // Every committed event is delivered through the Durable Object that holds the SSE connections.
  setPublisher((ev, aud) => env.REALTIME.getByName('hub').publish(ev, aud));
}

let app: ReturnType<typeof createApp> | null = null;
function expressApp(env: Env) {
  if (!app) {
    app = createApp({
      serveStatic: false, // the assets binding serves the React app
      dbMiddleware: hyperdriveMiddleware(env.HYPERDRIVE.connectionString),
    });
    app.listen(PORT);
  }
  return app;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    prepare(env);
    const { pathname } = new URL(request.url);

    if (pathname === '/api/v1/events' || pathname === '/api/v1/public/events') {
      return handleStream(request, env);
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      expressApp(env);
      return handleAsNodeRequest(PORT, request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export { RealtimeHub };
