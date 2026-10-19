import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, get, patch } from '../shared/api';
import { ErrorNote, Loading, PageHeader } from '../shared/ui';

interface Cafe {
  id: string; name: string; slug: string; emailDomain: string;
  isActive: boolean; createdAt: string; staffCount: number; managerCount: number;
}

/** The signed-in manager's own cafe. There is deliberately no list of other cafes. */
export default function CafePage() {
  const [cafe, setCafe] = useState<Cafe | null>(null);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    get('/cafe')
      .then((r) => { setCafe(r.cafe); setName(r.cafe.name); })
      .catch((e: ApiError) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  if (!cafe) return err ? <ErrorNote message={err} /> : <Loading />;

  const dirty = name.trim() !== cafe.name && name.trim().length > 0;

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    try {
      const r = await patch('/cafe', { name });
      setCafe({ ...cafe, name: r.cafe.name });
      setName(r.cafe.name);
      setSaved(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    }
    setBusy(false);
  };

  const others = cafe.staffCount - 1;

  return (
    <div>
      <PageHeader
        eyebrow="Your cafe"
        title={cafe.name}
        description="These details apply to this cafe only."
      />
      <ErrorNote message={err} onClose={() => setErr(null)} />

      <section className="card pad stack">
        <h2>Cafe details</h2>
        {saved && <div className="note ok" role="status"><span>Saved.</span></div>}
        <label className="field"><span>Cafe name (shown to your staff and to customers)</span>
          <input value={name} maxLength={120} onChange={(e) => { setName(e.target.value); setSaved(false); }} /></label>
        <p className="muted">Changing the name does not change anyone’s sign-in. The sign-in address stays <strong>{cafe.emailDomain}</strong>.</p>
        <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
      </section>

      <section className="card pad stack">
        <h2>Team</h2>
        <p className="muted">
          {others > 0
            ? `You and ${others} other login${others === 1 ? '' : 's'} belong to this cafe.`
            : 'You are the only login at this cafe so far.'}
        </p>
        <p className="muted">Add, rename or switch off logins on the <Link to="/manager/staff">Staff logins</Link> page.</p>
      </section>

      <section className="card pad stack">
        <h2>About this page</h2>
        <p className="muted">
          You can change your own cafe here. New cafes are set up for you by whoever runs the system, so
          there is no way — and no need — for you to see or edit anyone else’s cafe.
        </p>
      </section>
    </div>
  );
}
