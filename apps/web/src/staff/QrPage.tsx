import { useCallback, useEffect, useState } from 'react';
import { ApiError, get, post } from '../shared/api';
import { ErrorNote, Loading, PageHeader } from '../shared/ui';
import { Icon } from '../shared/icons';

export default function QrPage() {
  const [codes, setCodes] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = useCallback(() => { get('/qr-codes').then((r) => setCodes(r.codes)).catch((e: ApiError) => setErr(e.message)); }, []);
  useEffect(load, [load]);
  if (!codes) return err ? <ErrorNote message={err} /> : <Loading />;
  // QR codes are built from FRONTEND_URL. Localhost addresses can never be opened by a customer's
  // phone, so warn before anything is printed.
  const localOnly = codes.some((c) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(c.url ?? ''));
  return (
    <div>
      <PageHeader
        eyebrow="Print at the door"
        title="QR codes"
        description="Print these and stick one on each table. Each table has its own code."
        action={<button className="btn primary no-print" onClick={() => window.print()}><Icon name="printer" size={17} />Print all QR codes</button>}
      />
      <ErrorNote message={err} onClose={() => setErr(null)} />
      {localOnly && (
        <div className="note error no-print" role="alert">
          <span>These codes point at <strong>localhost</strong>, so no phone can open them. Set <strong>FRONTEND_URL</strong> in <code>.env</code> to the public web address (<code>https://…</code>) and restart before printing.</span>
        </div>
      )}
      <div className="qr-grid">
        {codes.map((c) => (
          <div key={c.tableId} className="card qr-card">
            <h2>Table {c.tableNumber}</h2>
            <div className="qr" dangerouslySetInnerHTML={{ __html: c.svg }} />
            <p className="muted">Scan to see the menu and order</p>
            <span className="qr-url no-print">{c.url}</span>
            <div className="no-print">
              {confirm === c.tableId ? (
                <div className="stack">
                  <p className="muted">The old printed code for this table will stop working. Continue?</p>
                  <div className="row gap">
                    <button className="btn danger small" onClick={() => post(`/tables/${c.tableId}/regenerate-qr`).then(() => { setConfirm(null); load(); }).catch((e: ApiError) => setErr(e.message))}>Yes, make a new code</button>
                    <button className="btn small" onClick={() => setConfirm(null)}>No</button>
                  </div>
                </div>
              ) : <button className="btn small" onClick={() => setConfirm(c.tableId)}>Replace this code</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
