import { useState } from 'react';
import { ApiError } from '../shared/api';
import { randomPassword } from '../shared/lib';
import { supabase } from '../shared/supabase';
import { ErrorNote, PageHeader } from '../shared/ui';
import { Icon } from '../shared/icons';
import { useAuth } from './auth';

export default function AccountPage() {
  const { user, cafeName } = useAuth();
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = again.length > 0 && pw !== again;

  const save = async () => {
    if (!supabase) { setErr('Sign-in is not set up yet. Whoever installed this app needs to add the Supabase settings.'); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw new ApiError(error.code ?? 'ERROR', error.message);
      setPw(''); setAgain('');
      setMsg('Your password has been changed. Use the new one the next time you sign in.');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not change the password. Please try again.');
    }
    setBusy(false);
  };

  const generate = () => { const g = randomPassword(); setPw(g); setAgain(g); setErr(null); setMsg(null); };

  return (
    <div>
      <PageHeader eyebrow="Account" title="My account" description="Your sign-in details." />
      <ErrorNote message={err} onClose={() => setErr(null)} />

      <section className="card pad stack">
        <div className="row between wrap gap">
          <div>
            <strong>{user!.name}</strong>
            <div className="muted">{cafeName} · {user!.role === 'MANAGER' ? 'Manager' : 'Staff'}</div>
          </div>
        </div>
        <p className="muted">Your manager can also reset this password from the Staff logins page if you are locked out.</p>
      </section>

      <section className="card pad stack">
        <h2>Change my password</h2>
        {msg && <div className="note ok" role="status"><span>{msg}</span></div>}
        <label className="field"><span>New password (at least 8 characters)</span>
          <input type="password" value={pw} autoComplete="new-password" onChange={(e) => setPw(e.target.value)} /></label>
        <div className="row wrap gap">
          <button className="btn small" onClick={generate}><Icon name="sparkles" size={15} />Generate a strong password</button>
        </div>
        <label className="field"><span>Type it again</span>
          <input type="password" value={again} autoComplete="new-password" onChange={(e) => setAgain(e.target.value)} /></label>
        {mismatch && <p className="muted">The two passwords do not match.</p>}
        <button className="btn primary" disabled={busy || pw.length < 8 || pw !== again} onClick={save}>{busy ? 'Saving…' : 'Change my password'}</button>
        <p className="muted">Once changed it cannot be looked up again — write it down somewhere safe.</p>
      </section>
    </div>
  );
}
