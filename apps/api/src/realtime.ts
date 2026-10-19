// Realtime. The database stays the source of truth: clients refetch from the API on reconnect, and
// events are only hints.
//
// Delivery is pluggable so the same event code works in both runtimes:
//   * local (Node / tests): an in-process set of open SSE responses
//   * Workers: a Durable Object that holds the SSE connections (see worker/realtime-do.ts)
import type { Response } from 'express';

export interface AppEvent { eventId: string; type: string; occurredAt: string; payload: Record<string, unknown>; }
export interface Audience { staff?: boolean; managerOnly?: boolean; sessionId?: string; publicMenu?: boolean; }

/** Who a stream belongs to. */
export type Listener = { kind: 'staff'; managerOnly: boolean } | { kind: 'public'; sessionId: string };

/** Whether an event aimed at `aud` should reach a listener. Shared by both transports. */
export function matches(aud: Audience, l: Listener): boolean {
  if (l.kind === 'staff') return !!aud.staff && (!aud.managerOnly || l.managerOnly);
  return aud.sessionId === l.sessionId || !!aud.publicMenu;
}

export function formatEvent(ev: AppEvent): string {
  return `id: ${ev.eventId}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

// ---------------------------------------------------------------- local transport (Node)

type Client = { listener: Listener; res: Response };
const clients = new Set<Client>();

export function openStream(res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
}

export function addClient(c:
  | { kind: 'staff'; role: 'MANAGER' | 'STAFF'; res: Response }
  | { kind: 'public'; sessionId: string; res: Response }) {
  const listener: Listener = c.kind === 'staff'
    ? { kind: 'staff', managerOnly: c.role === 'MANAGER' }
    : { kind: 'public', sessionId: c.sessionId };
  const client: Client = { listener, res: c.res };
  clients.add(client);
  c.res.on('close', () => clients.delete(client));
  ensurePing();
}

// Keepalive comments, started only once a client is attached. Starting a timer at module scope is
// not allowed on Workers (global scope may not do I/O), and this path is never used there.
let ping: ReturnType<typeof setInterval> | null = null;
function ensurePing() {
  if (ping) return;
  ping = setInterval(() => {
    if (clients.size === 0) { clearInterval(ping!); ping = null; return; }
    for (const c of clients) c.res.write(': ping\n\n');
  }, 25000);
  (ping as unknown as { unref?: () => void }).unref?.();
}

const localPublisher: Publisher = (ev, aud) => {
  const msg = formatEvent(ev);
  for (const c of clients) if (matches(aud, c.listener)) c.res.write(msg);
};

// ---------------------------------------------------------------- pluggable publisher

export type Publisher = (ev: AppEvent, aud: Audience) => void | Promise<void>;

let publisher: Publisher = localPublisher;

/** Swap the delivery mechanism. The Workers entry points this at the Durable Object. */
export function setPublisher(p: Publisher | null) { publisher = p ?? localPublisher; }

export function broadcast(ev: AppEvent, aud: Audience) { return publisher(ev, aud); }
