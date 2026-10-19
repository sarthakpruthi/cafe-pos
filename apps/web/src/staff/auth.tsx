import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError, get, setAuthToken } from '../shared/api';
import { staffEmail, supabase, supabaseConfigured } from '../shared/supabase';
import { BrandMark, ErrorNote, Loading } from '../shared/ui';

export interface User { id: string; name: string; role: 'MANAGER' | 'STAFF'; username?: string; }
/** A cafe/shop a person can sign in to. `emailDomain` is the address suffix Supabase Auth uses. */
export interface Cafe { id: string; name: string; slug: string; emailDomain: string; }

interface Ctx {
  user: User | null; token: string | null; cafeName: string; loading: boolean; configured: boolean;
  login: (cafe: Cafe, username: string, password: string) => Promise<void>; logout: () => Promise<void>;
}
const AuthCtx = createContext<Ctx>(null as any);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [cafeName, setCafe] = useState('Cafe');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    let cancelled = false;
    // Supabase holds the session (and refreshes it); we mirror the token into the API client and
    // fetch the matching profile from our own API.
    const apply = async (accessToken: string | null) => {
      if (cancelled) return;
      setAuthToken(accessToken); setToken(accessToken);
      if (!accessToken) { setUser(null); return; }
      try {
        const r = await get('/auth/me');
        if (!cancelled) { setUser(r.user); setCafe(r.cafeName); }
      } catch { /* token would not verify; leave the user signed out */ }
    };
    supabase.auth.getSession()
      .then(({ data }) => apply(data.session?.access_token ?? null))
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => { void apply(session?.access_token ?? null); });
    return () => { cancelled = true; data.subscription.unsubscribe(); };
  }, []);

  const login = async (cafe: Cafe, username: string, password: string) => {
    if (!supabase) throw new ApiError('NOT_CONFIGURED', 'Sign-in is not set up yet. Whoever installed this app needs to add the Supabase settings.');
    const { data, error } = await supabase.auth.signInWithPassword({ email: staffEmail(username, cafe.emailDomain), password });
    if (error || !data.session) throw new ApiError(error?.code ?? 'LOGIN_FAILED', 'That username or password is not correct.');
    setAuthToken(data.session.access_token); setToken(data.session.access_token);
    try {
      const r = await get('/auth/me');
      setUser(r.user); setCafe(r.cafeName);
    } catch {
      // The sign-in worked at Supabase but there is no matching person in this cafe.
      await supabase.auth.signOut().catch(() => {});
      setAuthToken(null); setToken(null);
      throw new ApiError('NO_PROFILE', 'This sign-in is not linked to a person in this cafe. Please ask the manager.');
    }
  };

  const logout = async () => {
    await supabase?.auth.signOut().catch(() => {});
    setAuthToken(null); setToken(null); setUser(null);
  };

  return <AuthCtx.Provider value={{ user, token, cafeName, loading, configured: supabaseConfigured, login, logout }}>{children}</AuthCtx.Provider>;
}

export function RequireRole({ role, children }: { role: 'MANAGER' | 'STAFF'; children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (user.role !== role) return <Navigate to={user.role === 'MANAGER' ? '/manager/tables' : '/staff/tables'} replace />;
  return <>{children}</>;
}

export function LoginPage() {
  const { user, login, cafeName, configured } = useAuth();
  const loc = useLocation();
  const [cafes, setCafes] = useState<Cafe[] | null>(null);
  const [q, setQ] = useState('');
  const [cafe, setCafe] = useState<Cafe | null>(null);
  const [u, setU] = useState(''); const [p, setP] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  // The login screen needs a cafe before it can build the Supabase address, so it reads the list.
  useEffect(() => {
    if (!configured) { setCafes([]); return; }
    get<{ cafes: Cafe[] }>('/public/cafes').then((r) => setCafes(r.cafes)).catch(() => setCafes([]));
  }, [configured]);

  if (user) return <Navigate to={(loc.state as any)?.from ?? (user.role === 'MANAGER' ? '/manager/tables' : '/staff/tables')} replace />;

  const go = async () => {
    if (!cafe) return;
    setBusy(true); setErr(null);
    try { await login(cafe, u, p); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Something went wrong.'); }
    setBusy(false);
  };
  const shown = (cafes ?? []).filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <main className="login">
      <div className="card stack">
        <BrandMark name={cafe?.name ?? cafeName} subtitle="Staff sign in" />
        {!configured && <div className="note error" role="alert"><span>Sign-in is not set up yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then rebuild the app.</span></div>}
        <ErrorNote message={err} />

        {!cafe ? (
          <>
            <h1>Which cafe are you at?</h1>
            <p className="muted">Find your cafe, then sign in.</p>
            <label className="field"><span>Search for your cafe</span>
              <input value={q} autoFocus autoCapitalize="none" onChange={(e) => setQ(e.target.value)} placeholder="Start typing the cafe name" />
            </label>
            {cafes === null && <Loading text="Looking for cafes…" />}
            {cafes !== null && shown.length === 0 && <p className="muted">No cafe matches “{q}”. Check the spelling, or ask your manager.</p>}
            <div className="stack">
              {shown.map((c) => <button key={c.id} className="btn big" onClick={() => { setCafe(c); setErr(null); }}>{c.name}</button>)}
            </div>
            <p className="muted">Not sure which cafe you are at? Ask your manager — they set up your login.</p>
          </>
        ) : (
          <>
            <h1>Sign in</h1>
            <div className="row between wrap gap">
              <span className="muted">Signing in to <strong>{cafe.name}</strong></span>
              <button className="btn small" onClick={() => { setCafe(null); setErr(null); }}>Change cafe</button>
            </div>
            <label className="field"><span>Username</span><input value={u} autoFocus autoCapitalize="none" autoComplete="username" onChange={(e) => setU(e.target.value)} /></label>
            <label className="field"><span>Password</span><input type="password" value={p} autoComplete="current-password" onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} /></label>
            <button className="btn primary big" disabled={busy || !u || !p} onClick={go}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </>
        )}
      </div>
    </main>
  );
}
