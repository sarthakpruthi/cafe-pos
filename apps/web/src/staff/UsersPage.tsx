import { useCallback, useEffect, useState } from 'react';
import { ApiError, get, patch, post } from '../shared/api';
import { ErrorNote, Loading, PageHeader } from '../shared/ui';
import { Icon } from '../shared/icons';
import { useAuth } from './auth';

export default function UsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', username: '', password: '', role: 'STAFF' });
  const [reset, setReset] = useState<{ id: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { get('/users').then((r) => setUsers(r.users)).catch((e: ApiError) => setErr(e.message)); }, []);
  useEffect(load, [load]);
  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true); setErr(null);
    try { await fn(); after?.(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Something went wrong.'); }
    setBusy(false); load();
  }
  if (!users) return err ? <ErrorNote message={err} /> : <Loading />;
  const initials = (name: string) => name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div>
      <PageHeader
        eyebrow="Access"
        title="Staff logins"
        description="Add people who can use the app, and control who can do what."
      />
      <ErrorNote message={err} onClose={() => setErr(null)} />

      <section className="card pad stack">
        <h2>Add a person</h2>
        <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>Username (they type this to sign in)</span><input value={form.username} autoCapitalize="none" onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label className="field"><span>Password (at least 8 characters)</span><input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <div className="row gap" role="group" aria-label="Role">
          <button className={`btn small ${form.role === 'STAFF' ? 'primary' : ''}`} aria-pressed={form.role === 'STAFF'} onClick={() => setForm({ ...form, role: 'STAFF' })}>Staff</button>
          <button className={`btn small ${form.role === 'MANAGER' ? 'primary' : ''}`} aria-pressed={form.role === 'MANAGER'} onClick={() => setForm({ ...form, role: 'MANAGER' })}>Manager</button>
        </div>
        <p className="muted">Staff can see tables, add orders and mark items served. Managers can do everything.</p>
        <button className="btn primary" disabled={busy || !form.name || !form.username || !form.password} onClick={() => run(() => post('/users', form), () => setForm({ name: '', username: '', password: '', role: 'STAFF' }))}>Add this person</button>
      </section>

      <div className="stack">
        {users.map((u) => (
          <div key={u.id} className={`card pad stack ${u.isActive ? '' : 'faded'}`}>
            <div className="row between wrap gap">
              <div className="row gap">
                <span className="avatar">{initials(u.name)}</span>
                <div>
                  <strong>{u.name}</strong> <span className="tag">{u.role === 'MANAGER' ? 'Manager' : 'Staff'}</span> {!u.isActive && <span className="tag red">Switched off</span>}
                  <div className="muted">Username: {u.username}</div>
                </div>
              </div>
              <div className="row wrap gap">
                <button className="btn small" onClick={() => setReset(reset?.id === u.id ? null : { id: u.id, password: '' })}><Icon name="users" size={15} />Set a new password</button>
                {u.id !== user!.id && <button className="btn small" disabled={busy} onClick={() => run(() => patch(`/users/${u.id}`, { isActive: !u.isActive }))}>{u.isActive ? 'Switch off login' : 'Switch on login'}</button>}
              </div>
            </div>
            {reset && reset.id === u.id && (
              <div className="panel stack">
                <label className="field"><span>New password (at least 8 characters)</span><input value={reset.password} onChange={(e) => setReset({ id: u.id, password: e.target.value })} /></label>
                <button className="btn primary" disabled={busy || reset.password.length < 8} onClick={() => run(() => patch(`/users/${u.id}`, { password: reset.password }), () => setReset(null))}>Save new password</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
