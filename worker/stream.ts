// Authorizes the two SSE endpoints and hands the connection to the RealtimeHub Durable Object.
//
// These routes are handled here rather than by Express so that no database connection is held open
// for the lifetime of the stream: the profile is loaded on a short-lived connection and closed
// before the stream starts.
import { readToken } from '../apps/api/src/auth.js';
import { withPg } from '../apps/api/src/drivers/worker.js';
import { staffAuth } from '../apps/api/src/supabase.js';
import type { Env } from './env.js';

function bearer(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
}

function deny(code: 'UNAUTHENTICATED' | 'FORBIDDEN', message: string): Response {
  return Response.json({ error: { code, message, details: {} } }, { status: code === 'FORBIDDEN' ? 403 : 401 });
}

export async function handleStream(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = bearer(request) ?? url.searchParams.get('token') ?? '';
  const headers = new Headers();

  if (url.pathname.endsWith('/public/events')) {
    // Customer stream: bound to one table session by the signed token issued at QR scan.
    const t = readToken<{ sid: string }>(token);
    if (!t) return deny('FORBIDDEN', 'Please scan the QR code on your table again to continue.');
    headers.set('x-aud-kind', 'public');
    headers.set('x-aud-session', t.sid);
  } else {
    const claims = await staffAuth.verify(token);
    if (!claims) return deny('UNAUTHENTICATED', 'Please sign in to continue.');
    // Re-read the profile so switching a login off takes effect at once, exactly as the API does.
    const role = await withPg(env, async (c) => {
      const r = await c.query<{ role: string; is_active: boolean }>(
        'SELECT role, is_active FROM users WHERE id = $1', [claims.id]);
      const row = r.rows[0];
      return row?.is_active ? row.role : null;
    });
    if (!role) return deny('UNAUTHENTICATED', 'Please sign in to continue.');
    headers.set('x-aud-kind', 'staff');
    headers.set('x-aud-manager-only', role === 'MANAGER' ? '1' : '0');
  }

  return env.REALTIME.getByName('hub').fetch(
    new Request('https://realtime/subscribe', { headers, signal: request.signal }));
}
