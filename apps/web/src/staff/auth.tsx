import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError, get, post } from '../shared/api';
import { BrandMark, Loading } from '../shared/ui';

export interface User { id: string; name: string; role: 'MANAGER' | 'STAFF'; }
interface Ctx { user: User | null; cafeName: string; loading: boolean; login: (u: string, p: string) => Promise<void>; logout: () => Promise<void>; }
const AuthCtx = createContext<Ctx>(null as any);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [cafeName, setCafe] = useState('Cafe');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    get('/auth/me').then((r) => { setUser(r.user); setCafe(r.cafeName); }).catch(() => {}).finally(() => setLoading(false));
  }, []);
  const login = async (username: string, password: string) => {
    const r = await post('/auth/login', { username, password });
    setUser(r.user); setCafe(r.cafeName);
  };
  const logout = async () => { await post('/auth/logout').catch(() => {}); setUser(null); };
  return <AuthCtx.Provider value={{ user, cafeName, loading, login, logout }}>{children}</AuthCtx.Provider>;
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
  const { user, login, cafeName } = useAuth();
  const loc = useLocation();
  const [u, setU] = useState(''); const [p, setP] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={(loc.state as any)?.from ?? (user.role === 'MANAGER' ? '/manager/tables' : '/staff/tables')} replace />;
  const go = async () => {
    setBusy(true); setErr(null);
    try { await login(u, p); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Something went wrong.'); }
    setBusy(false);
  };
  return (
    <main className="login">
      <div className="card stack">
        <BrandMark name={cafeName} subtitle="Staff sign in" />
        <h1>Sign in</h1>
        <p className="muted">Sign in to see your tables.</p>
        {err && <div className="note error" role="alert"><span>{err}</span></div>}
        <label className="field"><span>Username</span><input value={u} autoFocus autoCapitalize="none" autoComplete="username" onChange={(e) => setU(e.target.value)} /></label>
        <label className="field"><span>Password</span><input type="password" value={p} autoComplete="current-password" onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} /></label>
        <button className="btn primary big" disabled={busy || !u || !p} onClick={go}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </div>
    </main>
  );
}
