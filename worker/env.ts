import type { AppEvent, Audience } from '../apps/api/src/realtime.js';
import type { RealtimeHub } from './realtime-do.js';

// Bindings the Worker entry receives. Secrets/vars are also spread in by Cloudflare.
export interface Env {
  ASSETS: Fetcher;
  HYPERDRIVE: { connectionString: string };
  REALTIME: DurableObjectNamespace<RealtimeHub>;
  [key: string]: unknown;
}

export type { AppEvent, Audience };
