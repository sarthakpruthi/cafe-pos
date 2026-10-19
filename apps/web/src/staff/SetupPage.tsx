import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, post } from '../shared/api';
import { randomPassword } from '../shared/lib';
import { BrandMark, ErrorNote } from '../shared/ui';
import { Icon } from '../shared/icons';

const EMPTY = { key: '', name: '', managerName: '', username: '', password: '' };

/** Public: set up a cafe and its first manager. Reached without signing in. */
export default function SetupPage() {
  const [form, setForm] = useState(EMPTY);
  const [done, setDone] = useState<{ cafe: any; username: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await post('/public/setup', form);
      setDone({ cafe: r.cafe, username: form.username });
      setForm(EMPTY);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    }
    setBusy(false);
  };

  return (
    <main className="login">
      <div className="card stack">
        <BrandMark name={done?.cafe.name ?? 'Cafe setup'} subtitle="Owner setup" />
        <ErrorNote message={err} onClose={() => setErr(null)} />

        {done ? (
          <>
            <h1>{done.cafe.name} is ready</h1>
            <div className="note ok" role="status">
              <span>Sign in on the normal sign-in screen: choose <strong>{done.cafe.name}</strong>, then use the username and password you set.</span>
            </div>
            <p className="muted">Staff sign in as <strong>{done.username}@{done.cafe.emailDomain}</strong></p>
            <Link className="btn primary big" to="/login">Go to sign in</Link>
          </>
        ) : (
          <>
            <h1>Set up a cafe</h1>
            <p className="muted">Creates the cafe and its first manager. Ask whoever runs the server for the setup key.</p>
            <label className="field"><span>Setup key</span>
              <input value={form.key} autoFocus autoComplete="off" onChange={(e) => setForm({ ...form, key: e.target.value })} /></label>
            <label className="field"><span>Cafe name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Blue Bottle" /></label>
            <label className="field"><span>Manager's name</span>
              <input value={form.managerName} onChange={(e) => setForm({ ...form, managerName: e.target.value })} placeholder="Who runs this cafe?" /></label>
            <label className="field"><span>Manager username (they type this to sign in)</span>
              <input value={form.username} autoCapitalize="none" onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="manager" /></label>
            <label className="field"><span>Password (at least 8 characters)</span>
              <input value={form.password} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="new-password" onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
            <div className="row wrap gap">
              <button className="btn small" onClick={() => setForm({ ...form, password: randomPassword() })}><Icon name="sparkles" size={15} />Generate a strong password</button>
            </div>
            <p className="muted">Write the password down now — once saved it can’t be looked up again.</p>
            <button className="btn primary big" disabled={busy || !form.key || !form.name || !form.managerName || !form.username || form.password.length < 8} onClick={submit}>
              {busy ? 'Creating…' : 'Create cafe and manager'}
            </button>
            <Link className="muted" to="/login">Back to sign in</Link>
          </>
        )}
      </div>
    </main>
  );
}
