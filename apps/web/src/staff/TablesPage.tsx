import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, get } from '../shared/api';
import { ErrorNote, Loading, PageHeader } from '../shared/ui';
import { minutesAgo, rupees } from '../shared/lib';
import { useDebounced } from '../shared/live';
import { Icon } from '../shared/icons';
import { useAuth } from './auth';
import { useStaffEvents } from './Layout';

export default function TablesPage() {
  const { user } = useAuth();
  const base = user!.role === 'MANAGER' ? '/manager' : '/staff';
  const [tables, setTables] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { get('/tables').then((r) => { setTables(r.tables); setErr(null); }).catch((e: ApiError) => setErr(e.message)); }, []);
  useEffect(load, [load]);
  const later = useDebounced(load);
  useStaffEvents(() => later(), load);
  useEffect(() => { const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  if (!tables) return err ? <ErrorNote message={err} /> : <Loading />;
  const occupied = tables.filter((t) => t.occupied).length;
  const free = tables.length - occupied;
  const waiting = tables.filter((t) => t.pendingItems > 0).length;

  return (
    <div>
      <PageHeader
        eyebrow="Today’s floor"
        title="Tables"
        description="Tap a table to see its orders and bill."
        action={
          <div className="overview-strip">
            <div>
              <span className="overview-icon"><Icon name="grid" /></span>
              <div><strong>{occupied} of {tables.length}</strong><span>tables in use</span></div>
            </div>
            <div>
              <span className="overview-icon orange"><Icon name="bell" /></span>
              <div><strong>{waiting}</strong><span>tables need review</span></div>
            </div>
            <div>
              <span className="overview-icon green"><Icon name="checkCircle" /></span>
              <div><strong>{free}</strong><span>tables free</span></div>
            </div>
          </div>
        }
      />
      <ErrorNote message={err} />

      <div className="section-heading">
        <div><h2>All tables</h2><p>New orders appear here on their own.</p></div>
        <span className="legend">
          <span className="legend-item"><i className="legend-dot orange-dot" />Needs attention</span>
          <span className="legend-item"><i className="legend-dot green-dot" />In progress</span>
        </span>
      </div>

      <div className="table-grid">
        {tables.map((t) => (
          <Link key={t.id} to={`${base}/tables/${t.id}`} className={`table-card ${t.occupied ? 'busy' : 'free'} ${t.pendingItems ? 'has-pending attention' : ''}`}>
            <div className="table-card-top">
              <span className="table-number">{t.tableNumber}</span>
              <span className={`table-state ${t.occupied ? 'occupied' : 'available'}`}>
                <span className="state-dot" />{t.occupied ? 'In use' : 'Free'}
              </span>
            </div>
            <div className="table-card-body">
              {t.occupied ? <>
                <strong>{rupees(t.total ?? 0)}</strong>
                <span>
                  {t.pendingItems > 0
                    ? `${t.pendingItems} ${t.pendingItems === 1 ? 'item' : 'items'} waiting for review`
                    : t.toServe > 0 ? `${t.toServe} to serve` : 'Nothing waiting'}
                </span>
              </> : <>
                <strong className="available-title">Ready for guests</strong>
                <span>Tap to open table</span>
              </>}
            </div>
            <div className="table-card-bottom">
              {t.occupied ? <span>Seated {minutesAgo(t.openedAt)} ago</span> : <span>Table {t.tableNumber}</span>}
              <Icon name="chevronRight" size={17} />
            </div>
          </Link>
        ))}
      </div>

      <div className="tip-banner">
        <Icon name="alert" size={20} />
        <div><strong>Tables stay simple</strong><span>Open a table to accept orders, mark items served, or collect payment.</span></div>
      </div>
    </div>
  );
}
