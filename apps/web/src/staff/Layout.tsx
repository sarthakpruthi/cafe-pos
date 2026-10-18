import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { get, post } from '../shared/api';
import { beep, useLive } from '../shared/live';
import { useAuth } from './auth';
import { timeOf } from '../shared/lib';
import { BrandMark } from '../shared/ui';
import { Icon, type IconName } from '../shared/icons';

type Listener = (type: string, payload: any) => void;
interface Ctx { subscribe: (l: Listener) => () => void; resyncTick: number; live: string; }
const StaffCtx = createContext<Ctx>({ subscribe: () => () => {}, resyncTick: 0, live: 'connecting' });

/** Pages call this to refetch when something changes anywhere (and after a reconnect). */
export function useStaffEvents(onChange: (type: string, payload: any) => void, onResync?: () => void) {
  const { subscribe, resyncTick } = useContext(StaffCtx);
  const cb = useRef(onChange); cb.current = onChange;
  const rs = useRef(onResync); rs.current = onResync;
  useEffect(() => subscribe((t, p) => cb.current(t, p)), [subscribe]);
  useEffect(() => { if (resyncTick > 0) rs.current?.(); }, [resyncTick]);
}

interface Toast { orderId: string; tableId: string; message: string; }

const today = () => new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

export default function StaffLayout() {
  const { user, cafeName, logout } = useAuth();
  const nav = useNavigate();
  const manager = user!.role === 'MANAGER';
  const base = manager ? '/manager' : '/staff';
  const listeners = useRef(new Set<Listener>());
  const [tick, setTick] = useState(0);
  const [notes, setNotes] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sound, setSound] = useState(() => localStorage.getItem('sound') === 'on');
  const soundRef = useRef(sound); soundRef.current = sound;
  // Sidebar starts collapsed (icon rail). The hamburger expands it; on phones it opens as a drawer.
  const [navOpen, setNavOpen] = useState(() => localStorage.getItem('nav') === 'open');
  const toggleNav = () => setNavOpen((v) => { localStorage.setItem('nav', v ? 'closed' : 'open'); return !v; });
  // On phones the nav is an overlay, so close it after picking a page.
  const closeNavOnPhone = () => { if (window.matchMedia('(max-width: 620px)').matches) setNavOpen(false); };

  const loadNotes = useCallback(() => { get('/notifications?unread=true').then((r) => setNotes(r.notifications)).catch(() => {}); }, []);
  useEffect(loadNotes, [loadNotes]);

  const live = useLive('/api/v1/events', (type, payload) => {
    listeners.current.forEach((l) => l(type, payload));
    if (type === 'order.created') {
      setToasts((t) => t.some((x) => x.orderId === payload.orderId) ? t
        : [...t, { orderId: payload.orderId, tableId: payload.tableId, message: `New order for Table ${payload.tableNumber} — Order ${payload.orderNumber}, ${payload.itemCount} ${payload.itemCount === 1 ? 'item' : 'items'}` }]);
      if (soundRef.current) beep();
    }
    if (type === 'notification.created') loadNotes();
  }, () => { setTick((n) => n + 1); loadNotes(); });

  const ctx: Ctx = { subscribe: useCallback((l: Listener) => { listeners.current.add(l); return () => { listeners.current.delete(l); }; }, []), resyncTick: tick, live };

  const openTable = (tableId: string, noteId?: string) => {
    if (noteId) post(`/notifications/${noteId}/read`).then(loadNotes);
    setOpen(false); nav(`${base}/tables/${tableId}`);
  };

  const links: { to: string; label: string; icon: IconName }[] = [
    { to: `${base}/tables`, label: 'Tables', icon: 'grid' },
    ...(manager ? [
      { to: '/manager/menu', label: 'Menu', icon: 'menu' as IconName },
      { to: '/manager/reports', label: 'Payments and reports', icon: 'wallet' as IconName },
      { to: '/manager/staff', label: 'Staff logins', icon: 'users' as IconName },
      { to: '/manager/qr-codes', label: 'QR codes', icon: 'qr' as IconName },
      { to: '/manager/audit', label: 'History', icon: 'clock' as IconName },
    ] : []),
  ];
  const initials = user!.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <StaffCtx.Provider value={ctx}>
      <div className={`app-shell ${navOpen ? 'nav-open' : ''}`}>
        <button className="nav-backdrop" aria-hidden="true" tabIndex={-1} onClick={() => setNavOpen(false)} />
        <aside className="app-sidebar" id="app-sidebar">
          <div className="sidebar-top">
            <button className="nav-toggle" aria-expanded={navOpen} aria-controls="app-sidebar" aria-label={navOpen ? 'Collapse menu' : 'Expand menu'} title={navOpen ? 'Collapse menu' : 'Expand menu'} onClick={toggleNav}>
              <Icon name={navOpen ? 'arrowLeft' : 'menu'} size={20} />
            </button>
            <div className="role-label"><span className="role-dot" />{manager ? 'Manager workspace' : 'Staff workspace'}</div>
          </div>
          <nav className="side-nav" aria-label="Main">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} className="side-nav-item" onClick={closeNavOnPhone} title={l.label}>
                <Icon name={l.icon} /><span>{l.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="help-card"><strong>Need a hand?</strong><span>Ask your shift lead if you are unsure about anything.</span></div>
            <button className="side-nav-item logout" onClick={() => { closeNavOnPhone(); logout(); }} title="Sign out"><Icon name="arrowLeft" /><span>Sign out</span></button>
          </div>
        </aside>

        <div className="app-main">
          <header className="app-topbar">
            <div className="topbar-left">
              <BrandMark name={cafeName} subtitle={manager ? 'Manager desk' : 'Staff desk'} />
              <div className="topbar-context"><strong>{today()}</strong></div>
            </div>
            <div className="topbar-actions">
              <span className={`live ${live}`} role="status">{live === 'live' ? 'Live' : 'Reconnecting…'}</span>
              <button className="btn small" aria-pressed={sound} title="Sound alerts" onClick={() => { const v = !sound; setSound(v); localStorage.setItem('sound', v ? 'on' : 'off'); if (v) beep(); }}>
                <Icon name="volume" />Sound: {sound ? 'on' : 'off'}
              </button>
              <button className="notification-button" aria-expanded={open} aria-label={`Notifications${notes.length ? `, ${notes.length} new` : ''}`} onClick={() => setOpen(!open)}>
                <Icon name="bell" size={20} />
                {notes.length > 0 && <span className="count">{notes.length}</span>}
              </button>
              <div className="row gap">
                <span className="avatar">{initials}</span>
                <span className="user-name">{user!.name}<small>{manager ? 'Manager' : 'Staff'}</small></span>
              </div>
            </div>
            {open && (
              <div className="card pad stack notes-panel">
                {notes.length === 0 ? <p className="muted">No new notifications.</p> : <>
                  {notes.map((n) => (
                    <div key={n.id} className="row between gap">
                      <span>{n.message} <span className="muted">{timeOf(n.createdAt)}</span></span>
                      <button className="btn small" onClick={() => openTable(n.tableId, n.id)}>Open table</button>
                    </div>
                  ))}
                  <button className="btn small" onClick={() => post('/notifications/read-all').then(loadNotes)}>Mark all as read</button>
                </>}
              </div>
            )}
          </header>

          {toasts.length > 0 && (
            <div className="toasts" role="alert">
              {toasts.map((t) => (
                <div key={t.orderId} className="toast">
                  <strong>{t.message}</strong>
                  <div className="row gap">
                    <button className="btn primary small" onClick={() => { setToasts((x) => x.filter((y) => y.orderId !== t.orderId)); openTable(t.tableId); }}>Open table</button>
                    <button className="btn small" onClick={() => setToasts((x) => x.filter((y) => y.orderId !== t.orderId))}>Dismiss</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <main className="content-wrap"><Outlet /></main>
        </div>
      </div>
    </StaffCtx.Provider>
  );
}
