// Realtime via Server-Sent Events (SSE). The database stays the source of truth:
// clients refetch from the API on reconnect, and events are only hints.
import type { Response } from 'express';

export interface AppEvent { eventId: string; type: string; occurredAt: string; payload: Record<string, unknown>; }
export interface Audience { staff?: boolean; managerOnly?: boolean; sessionId?: string; publicMenu?: boolean; }

type Client =
  | { kind: 'staff'; role: 'MANAGER' | 'STAFF'; res: Response }
  | { kind: 'public'; sessionId: string; res: Response };

const clients = new Set<Client>();

export function addClient(c: Client) {
  clients.add(c);
  c.res.on('close', () => clients.delete(c));
}

export function openStream(res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
}

export function broadcast(ev: AppEvent, aud: Audience) {
  const msg = `id: ${ev.eventId}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) {
    let ok = false;
    if (c.kind === 'staff') ok = !!aud.staff && (!aud.managerOnly || c.role === 'MANAGER');
    else ok = (aud.sessionId === c.sessionId) || !!aud.publicMenu;
    if (ok) c.res.write(msg);
  }
}

setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000).unref();
