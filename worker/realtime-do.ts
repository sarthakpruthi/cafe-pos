// Holds every open SSE stream and fans events out to them.
//
// A Worker isolate's in-memory set would not work: requests land on different isolates, so a stream
// opened on one isolate would miss events published from another. A single Durable Object is the
// natural home for the fan-out, and it also outlives isolate restarts.
import { DurableObject } from 'cloudflare:workers';
import { formatEvent, matches, type AppEvent, type Audience, type Listener } from '../apps/api/src/realtime.js';

type Conn = {
  listener: Listener;
  write: (chunk: string) => Promise<void>;
  close: () => void;
};

export class RealtimeHub extends DurableObject {
  #conns = new Set<Conn>();
  #ping: ReturnType<typeof setInterval> | null = null;

  /** Subscribe a client. The audience is decided by the Worker after it has authorized the request. */
  async fetch(request: Request): Promise<Response> {
    const listener: Listener = request.headers.get('x-aud-kind') === 'staff'
      ? { kind: 'staff', managerOnly: request.headers.get('x-aud-manager-only') === '1' }
      : { kind: 'public', sessionId: request.headers.get('x-aud-session') ?? '' };

    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const conn: Conn = {
      listener,
      write: (chunk) => writer.write(encoder.encode(chunk)),
      close: () => { try { void writer.close(); } catch { /* already closed */ } },
    };
    this.#conns.add(conn);
    this.#startPing();
    request.signal.addEventListener('abort', () => void this.#drop(conn));
    void conn.write('retry: 3000\n\n').catch(() => void this.#drop(conn));

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      },
    });
  }

  /** Called by the API once a transaction has committed. */
  async publish(ev: AppEvent, aud: Audience): Promise<void> {
    const msg = formatEvent(ev);
    for (const conn of [...this.#conns]) {
      if (matches(aud, conn.listener)) await conn.write(msg).catch(() => void this.#drop(conn));
    }
  }

  async #drop(conn: Conn) {
    if (!this.#conns.delete(conn)) return;
    conn.close();
    if (this.#conns.size === 0 && this.#ping !== null) { clearInterval(this.#ping); this.#ping = null; }
  }

  #startPing() {
    this.#ping ??= setInterval(() => {
      for (const conn of [...this.#conns]) void conn.write(': ping\n\n').catch(() => void this.#drop(conn));
    }, 25_000);
  }
}
