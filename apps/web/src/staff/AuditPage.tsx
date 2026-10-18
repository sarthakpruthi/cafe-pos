import { useEffect, useState } from 'react';
import { ApiError, get } from '../shared/api';
import { ErrorNote, Loading, PageHeader } from '../shared/ui';
import { AUDIT_WORDS, dateTimeOf } from '../shared/lib';
import { Icon } from '../shared/icons';

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setD(null); get(`/audit-logs?page=${page}`).then(setD).catch((e: ApiError) => setErr(e.message)); }, [page]);
  return (
    <div>
      <PageHeader
        eyebrow="Accountability"
        title="History"
        description="A record of who did what. It cannot be changed or deleted."
      />
      <ErrorNote message={err} />
      {!d ? <Loading /> : <>
        <div className="audit-card">
          <div className="audit-card-head"><span>Page {page}</span><span>Newest first</span></div>
          {d.entries.length === 0 && <p className="muted pad">Nothing has happened yet.</p>}
          {d.entries.map((e: any) => (
            <div className="audit-row" key={e.id}>
              <span className="audit-icon gray"><Icon name="clock" size={16} /></span>
              <div>
                <strong>{AUDIT_WORDS[e.action] ?? e.action}</strong>
                {e.reason && <span>{e.reason}</span>}
              </div>
              <span className="audit-actor">{e.actorName ?? 'Customer'}</span>
              <span className="audit-time">{dateTimeOf(e.createdAt)}</span>
            </div>
          ))}
        </div>
        <div className="row gap pad">
          <button className="btn" disabled={page === 1} onClick={() => setPage(page - 1)}>Newer</button>
          <button className="btn" disabled={!d.hasMore} onClick={() => setPage(page + 1)}>Older</button>
        </div>
      </>}
    </div>
  );
}
