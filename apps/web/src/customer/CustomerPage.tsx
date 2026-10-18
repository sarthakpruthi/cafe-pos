import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, get, post } from '../shared/api';
import { useLive } from '../shared/live';
import { Badge, BrandMark, ErrorNote, Loading, Stepper } from '../shared/ui';
import { Icon } from '../shared/icons';
import { MenuPicker, type Cart, type MenuSection } from '../shared/MenuPicker';
import { ITEM_STATUS, estimate, newKey, rupees } from '../shared/lib';

type Tab = 'menu' | 'cart' | 'orders';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

export default function CustomerPage() {
  const { qrToken = '' } = useParams();
  const [info, setInfo] = useState<{ sessionId: string; sessionToken: string; cafeName: string; table: { number: string } } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [tab, setTab] = useState<Tab>('menu');
  const [sections, setSections] = useState<MenuSection[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [cart, setCart] = useState<Cart>({});
  const [error, setError] = useState<string | null>(null);
  const [menuChanged, setMenuChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<number | null>(null);
  const key = useRef<string | null>(null);

  const start = useCallback(async () => {
    setFatal(null); setClosed(false);
    try {
      const s = await post(`/public/tables/${qrToken}/session`);
      setInfo(s);
      try { setCart(JSON.parse(sessionStorage.getItem('cart:' + s.sessionId) ?? '{}')); } catch { setCart({}); }
    } catch (e) { setFatal(e instanceof ApiError ? e.message : 'Something went wrong.'); }
  }, [qrToken]);
  useEffect(() => { start(); }, [start]);

  const loadMenu = useCallback(async () => {
    if (!info) return;
    try { setSections((await get(`/public/sessions/${info.sessionId}/menu`, info.sessionToken)).sections); }
    catch (e) { if (e instanceof ApiError && e.code === 'SESSION_CLOSED') setClosed(true); else if (e instanceof ApiError) setError(e.message); }
  }, [info]);
  const loadOrders = useCallback(async () => {
    if (!info) return;
    try { setOrders((await get(`/public/sessions/${info.sessionId}`, info.sessionToken)).orders); }
    catch (e) { if (e instanceof ApiError && e.code === 'SESSION_CLOSED') setClosed(true); }
  }, [info]);
  useEffect(() => { loadMenu(); loadOrders(); }, [loadMenu, loadOrders]);
  useEffect(() => { const t = setInterval(loadOrders, 30000); return () => clearInterval(t); }, [loadOrders]);
  useEffect(() => { if (info) sessionStorage.setItem('cart:' + info.sessionId, JSON.stringify(cart)); }, [cart, info]);

  useLive(info ? `/api/v1/public/events?token=${encodeURIComponent(info.sessionToken)}` : null,
    (type) => {
      if (type === 'menu.updated') { setMenuChanged(true); loadMenu(); }
      else if (type === 'session.closed') setClosed(true);
      else loadOrders();
    }, () => { loadMenu(); loadOrders(); });

  const flat = sections.flatMap((s) => s.items);
  const lines = Object.entries(cart).map(([id, c]) => ({ id, item: flat.find((i) => i.id === id), ...c }));
  const gone = lines.filter((l) => !l.item || !l.item.isAvailable);
  const good = lines.filter((l) => l.item && l.item.isAvailable);
  const count = good.reduce((n, l) => n + l.qty, 0);
  const est = estimate(good.map((l) => ({ price: l.item!.price, taxRate: l.item!.taxRate, qty: l.qty })));

  const changeCart = (c: Cart) => { key.current = null; setCart(c); };

  async function submit() {
    if (!info || busy) return;
    setBusy(true); setError(null);
    key.current ??= newKey(); // same key on retry, so a double tap never sends two orders
    try {
      const r = await post(`/public/sessions/${info.sessionId}/orders`, {
        idempotencyKey: key.current,
        items: good.map((l) => ({ menuItemId: l.id, quantity: l.qty, notes: l.notes || null })),
      }, info.sessionToken);
      setSent(r.order.orderNumber); setCart({}); key.current = null; setTab('orders'); loadOrders();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SESSION_CLOSED') setClosed(true);
      else { setError(e instanceof ApiError ? e.message : 'Something went wrong.'); loadMenu(); }
    } finally { setBusy(false); }
  }

  if (fatal) return (
    <div className="customer-page">
      <main className="customer-main">
        <div className="card pad stack">
          <h1>We could not open this table</h1>
          <p className="muted">{fatal}</p>
          <button className="btn primary" onClick={start}>Try again</button>
        </div>
      </main>
    </div>
  );
  if (!info) return <div className="customer-page"><main className="customer-main"><Loading text="Opening your table…" /></main></div>;
  if (closed) return (
    <div className="customer-page">
      <main className="customer-main">
        <div className="card pad stack">
          <h1>This table has been closed</h1>
          <p className="muted">Thank you for visiting {info.cafeName}. To order again, tap the button below.</p>
          <button className="btn primary big" onClick={() => { setOrders([]); setCart({}); setSent(null); start(); }}>Start a new order</button>
        </div>
      </main>
    </div>
  );

  return (
    <div className="customer-page">
      <header className="customer-topbar">
        <BrandMark name={info.cafeName} />
        <div className="customer-table-label">
          <span>Ordering for</span>
          <strong>Table {info.table.number}</strong>
          <span className="qr-status"><span className="sync-dot" />Session open</span>
        </div>
      </header>

      <main className="customer-main">
        <div className="customer-intro">
          <div>
            <div className="eyebrow eyebrow-small">{greeting()}</div>
            <h1>What would you like?</h1>
            <p>Choose from the menu below. You can send more than one order during your visit.</p>
          </div>
          <div className="customer-help"><Icon name="alert" size={17} /><span>Need help? Please ask a member of our team.</span></div>
        </div>

        <ErrorNote message={error} onClose={() => setError(null)} />
        {menuChanged && <div className="note info"><span>The menu was updated. You are seeing the latest items.</span><button className="btn small" onClick={() => setMenuChanged(false)}>OK</button></div>}

        {tab === 'menu' && <MenuPicker sections={sections} cart={cart} setCart={changeCart} />}

        {tab === 'cart' && (
          <section className="stack">
            <div className="section-heading"><div><h2>Your order</h2><p>{count} {count === 1 ? 'item' : 'items'} ready to send.</p></div><span className="section-line" /></div>
            {lines.length === 0 && <p className="muted pad">Your cart is empty. Go to the menu and tap Add.</p>}
            {gone.length > 0 && <div className="note error"><span>Some items are no longer available: {gone.map((g) => g.item?.name ?? 'an item').join(', ')}. Please remove them.</span></div>}
            {lines.map((l) => (
              <div key={l.id} className="card pad stack">
                <div className="row between"><strong>{l.item?.name ?? 'Item no longer on the menu'}</strong><span>{l.item ? rupees(Number(l.item.price) * l.qty) : ''}</span></div>
                <div className="row between wrap gap">
                  <Stepper value={l.qty} onChange={(n) => { const c = { ...cart }; if (n <= 0) delete c[l.id]; else c[l.id] = { ...c[l.id], qty: n }; changeCart(c); }} label={l.item?.name ?? 'item'} />
                  <button className="btn small" onClick={() => { const c = { ...cart }; delete c[l.id]; changeCart(c); }}>Remove</button>
                </div>
                <label className="field"><span>Note for this item (optional)</span>
                  <input value={l.notes} maxLength={300} placeholder="For example: less sugar" onChange={(e) => changeCart({ ...cart, [l.id]: { ...cart[l.id], notes: e.target.value } })} /></label>
              </div>
            ))}
            {good.length > 0 && (
              <div className="cart-card">
                <div className="cart-summary">
                  <div><span>Items</span><span>{rupees(est.subtotal)}</span></div>
                  <div><span>Tax</span><span>{rupees(est.tax)}</span></div>
                  <div className="cart-total"><strong>Estimated total</strong><strong>{rupees(est.total)}</strong></div>
                </div>
                <button className="btn primary big submit-order-button" disabled={busy || gone.length > 0} onClick={submit}>{busy ? 'Sending…' : 'Send order to the cafe'}</button>
                <span className="submit-note">The cafe confirms your order and the final bill.</span>
              </div>
            )}
          </section>
        )}

        {tab === 'orders' && (
          <section className="customer-orders">
            <div className="section-heading"><div><h2>Your orders</h2><p>The cafe confirms each order before it is made.</p></div></div>
            {sent && <div className="note ok"><span>Order {sent} was sent. The cafe will confirm it shortly.</span><button className="btn small" onClick={() => setSent(null)}>OK</button></div>}
            {orders.length === 0 && <p className="muted pad">You have not ordered yet.</p>}
            {orders.map((o) => (
              <div key={o.id}>
                <div className="customer-order-row"><strong>Order {o.orderNumber}</strong></div>
                {o.items.map((i: any) => (
                  <div key={i.id} className="customer-order-row">
                    <div>
                      <strong>{i.quantity} × {i.name}</strong>
                      {i.notes && <span>Note: {i.notes}</span>}
                      {i.status === 'REJECTED' && i.rejectionReason && <span>Reason: {i.rejectionReason}</span>}
                    </div>
                    <Badge tone={ITEM_STATUS[i.status]?.tone ?? 'grey'}>{ITEM_STATUS[i.status]?.customer ?? i.status}</Badge>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}
      </main>

      <nav className="bottom-bar" aria-label="Pages">
        <button className={`btn ${tab === 'menu' ? 'primary' : ''}`} onClick={() => setTab('menu')}><Icon name="coffee" size={17} />Menu</button>
        <button className={`btn ${tab === 'cart' ? 'primary' : ''}`} onClick={() => setTab('cart')}><Icon name="bag" size={17} />Cart{count > 0 ? ` (${count})` : ''}</button>
        <button className={`btn ${tab === 'orders' ? 'primary' : ''}`} onClick={() => setTab('orders')}><Icon name="clipboard" size={17} />My orders{orders.length ? ` (${orders.length})` : ''}</button>
      </nav>
    </div>
  );
}
