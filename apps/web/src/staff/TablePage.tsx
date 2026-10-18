import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, get, post, patch } from '../shared/api';
import { ErrorNote, ItemBadge, Loading, OrderBadge } from '../shared/ui';
import { MenuPicker, type Cart } from '../shared/MenuPicker';
import { estimate, minutesAgo, newKey, rupees, timeOf } from '../shared/lib';
import { useDebounced } from '../shared/live';
import { Icon } from '../shared/icons';
import { useAuth } from './auth';
import { useStaffEvents } from './Layout';

type Ask = { kind: 'reject-item' | 'reject-order' | 'cancel-item' | 'cancel-order'; orderId: string; itemId?: string } | null;
const REASONS = ['Out of stock', 'Kitchen is closed', 'Customer changed their mind', 'Other'];

export default function TablePage() {
  const { tableId = '' } = useParams();
  const { user } = useAuth();
  const manager = user!.role === 'MANAGER';
  const base = manager ? '/manager' : '/staff';
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Ask>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    get(`/tables/${tableId}/session`).then((d) => setData(d)).catch((e: ApiError) => setErr(e.message));
  }, [tableId]);
  useEffect(() => { setData(null); load(); }, [load]);
  const later = useDebounced(load);
  useStaffEvents((_t, p) => { if (!p?.tableId || p.tableId === tableId) later(); }, load);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); setAsk(null); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Something went wrong.'); }
    setBusy(false); load();
  }

  if (!data) return err ? <><ErrorNote message={err} /><Link to={`${base}/tables`} className="back-link"><Icon name="arrowLeft" size={17} />All tables</Link></> : <Loading />;
  const { table, session, orders, bill } = data;

  return (
    <div>
      <Link to={`${base}/tables`} className="back-link"><Icon name="arrowLeft" size={17} />All tables</Link>

      <div className="detail-header">
        <div>
          <div className="table-heading-line">
            <span className="large-table-number">{table.tableNumber}</span>
            <div>
              <div className="eyebrow eyebrow-small">{session ? 'Active table' : 'Available table'}</div>
              <h1>Table {table.tableNumber}</h1>
            </div>
            <span className={`table-state ${session ? 'occupied' : 'available'}`}><span className="state-dot" />{session ? 'In use' : 'Free'}</span>
          </div>
          <p>{session
            ? `Seated since ${timeOf(session.openedAt)} · ${minutesAgo(session.openedAt)} ago · One bill for this visit`
            : 'No active session · A new session starts with the next order'}</p>
        </div>
        {session && (
          <div className="detail-header-actions">
            <button className="btn primary" onClick={() => setAdding(!adding)}><Icon name="plus" size={17} />{adding ? 'Close' : 'Add an order'}</button>
          </div>
        )}
      </div>

      <ErrorNote message={err} onClose={() => setErr(null)} />

      {!session ? (
        <div className="card pad stack">
          <p>This table is free. Customers can start by scanning the QR code, or you can start it for them.</p>
          <button className="btn primary big" disabled={busy} onClick={() => run(() => post(`/tables/${tableId}/session`))}>Start this table</button>
        </div>
      ) : (
        <div className="detail-layout">
          <section className="orders-col">
            <div className="section-heading queue-heading">
              <div><h2>Order queue</h2><p>Oldest orders first. Each item keeps its own status.</p></div>
              <span className="live-pill"><span className="sync-dot" />Live updates on</span>
            </div>
            {adding && <AddOrder sessionId={session.id} onDone={() => { setAdding(false); load(); }} />}
            {orders.length === 0 && <div className="empty-state"><Icon name="clipboard" size={30} /><h3>No orders yet</h3><p>New orders appear here on their own.</p></div>}
            {orders.map((o: any) => {
              const pending = o.items.filter((i: any) => i.status === 'PENDING');
              const toServe = o.items.filter((i: any) => i.status === 'ACCEPTED');
              return (
                <article key={o.id} className="order-card">
                  <div className="order-card-head">
                    <div>
                      <div className="order-title-row"><h3>Order {o.orderNumber}</h3><OrderBadge status={o.status} /></div>
                      <span className="order-meta">{timeOf(o.createdAt)} · {o.source === 'STAFF' ? `added by ${o.createdByName ?? 'staff'}` : 'from customer'}</span>
                    </div>
                    <div className="order-actions">
                      {manager && pending.length > 0 && <>
                        <button className="btn primary small" disabled={busy} onClick={() => run(() => post(`/orders/${o.id}/accept`))}><Icon name="check" size={15} />Accept all waiting</button>
                        <button className="btn danger small" disabled={busy} onClick={() => setAsk({ kind: 'reject-order', orderId: o.id })}>Reject all waiting</button>
                      </>}
                      {!manager && pending.length > 0 && <span className="muted">Waiting for the manager to accept.</span>}
                      {pending.length === 0 && toServe.length > 0 && (
                        <button className="btn primary small" disabled={busy} onClick={() => run(() => post(`/orders/${o.id}/served`))}><Icon name="check" size={15} />Mark whole order served</button>
                      )}
                      {manager && o.items.some((i: any) => i.status === 'PENDING' || i.status === 'ACCEPTED') && pending.length === 0 && (
                        <button className="btn small" disabled={busy} onClick={() => setAsk({ kind: 'cancel-order', orderId: o.id })}>Cancel order</button>
                      )}
                    </div>
                  </div>
                  <div className="order-items">
                    {o.items.map((i: any) => (
                      <ItemRowImpl key={i.id} item={i} manager={manager} busy={busy} orderId={o.id} run={run} setAsk={setAsk} ask={ask} />
                    ))}
                  </div>
                  {ask && ask.orderId === o.id && !ask.itemId && <ReasonForm ask={ask} busy={busy} run={run} onBack={() => setAsk(null)} />}
                </article>
              );
            })}
          </section>
          <BillPanel bill={bill} manager={manager} busy={busy} run={run} tableNo={table.tableNumber} />
        </div>
      )}
    </div>
  );
}

function ItemRowImpl({ item: i, manager, busy, orderId, run, setAsk, ask }: any) {
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState(i.quantity);
  const [notes, setNotes] = useState(i.notes ?? '');
  const [why, setWhy] = useState('');
  const canEdit = i.status === 'PENDING' || (manager && i.status === 'ACCEPTED');
  const mine = ask && ask.itemId === i.id;
  return (
    <div>
      <div className="order-item-row">
        <div className="item-qty">{i.quantity}×</div>
        <div className="order-item-info">
          <strong>{i.name}</strong>
          {i.notes && <span>Note: {i.notes}</span>}
          {i.rejectionReason && <span className="rejection-note">Reason: {i.rejectionReason}</span>}
        </div>
        <span className={`item-line-price ${i.status === 'REJECTED' || i.status === 'CANCELLED' ? 'strike' : ''}`}>{rupees(Number(i.lineSubtotal) + Number(i.lineTax))}</span>
        <div className="item-status-area">
          <ItemBadge status={i.status} />
          <div className="item-action-row">
            {manager && i.status === 'PENDING' && <>
              <button disabled={busy} onClick={() => run(() => post(`/orders/${orderId}/items/${i.id}/accept`))}>Accept</button>
              <button className="text-danger" disabled={busy} onClick={() => setAsk({ kind: 'reject-item', orderId, itemId: i.id })}>Reject</button>
            </>}
            {i.status === 'ACCEPTED' && <button className="serve-button" disabled={busy} onClick={() => run(() => post(`/orders/${orderId}/items/${i.id}/served`))}><Icon name="check" size={14} />Mark served</button>}
            {manager && i.status === 'ACCEPTED' && <button className="text-danger" disabled={busy} onClick={() => setAsk({ kind: 'cancel-item', orderId, itemId: i.id })}>Cancel item</button>}
            {canEdit && <button onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Change'}</button>}
          </div>
        </div>
      </div>
      {editing && (
        <div className="panel stack">
          <label className="field"><span>How many</span><input type="number" min={1} max={50} value={qty} onChange={(e) => setQty(Number(e.target.value))} /></label>
          <label className="field"><span>Note</span><input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} /></label>
          {i.status === 'ACCEPTED' && <label className="field"><span>Reason for the change (required)</span><input value={why} onChange={(e) => setWhy(e.target.value)} /></label>}
          <button className="btn primary" disabled={busy} onClick={() => run(async () => { await patch(`/orders/${orderId}/items/${i.id}`, { quantity: qty, notes, reason: why || undefined }); setEditing(false); })}>Save change</button>
        </div>
      )}
      {mine && <ReasonForm ask={ask} busy={busy} run={run} onBack={() => setAsk(null)} />}
    </div>
  );
}

function ReasonForm({ ask, busy, run, onBack }: { ask: NonNullable<Ask>; busy: boolean; run: (f: () => Promise<unknown>) => void; onBack: () => void }) {
  const [reason, setReason] = useState('');
  const path = `/orders/${ask.orderId}` + (ask.itemId ? `/items/${ask.itemId}` : '') + '/' + (ask.kind.startsWith('reject') ? 'reject' : 'cancel');
  const label = ask.kind.startsWith('reject') ? 'Yes, reject' : 'Yes, cancel';
  return (
    <div className="panel stack" role="group" aria-label="Why?">
      <strong>Why? (the customer will see this)</strong>
      <div className="row wrap gap">{REASONS.map((r) => <button key={r} className="btn small" onClick={() => setReason(r === 'Other' ? '' : r)}>{r}</button>)}</div>
      <input value={reason} maxLength={300} placeholder="Type the reason" onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
      <div className="row gap">
        <button className="btn danger" disabled={busy || !reason.trim()} onClick={() => run(() => post(path, { reason }))}>{label}</button>
        <button className="btn" onClick={onBack}>Go back</button>
      </div>
    </div>
  );
}

function AddOrder({ sessionId, onDone }: { sessionId: string; onDone: () => void }) {
  const [sections, setSections] = useState<any[]>([]);
  const [cart, setCart] = useState<Cart>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  useEffect(() => { get('/public/menu').then((m) => setSections(m.sections)); }, []);
  const flat = sections.flatMap((s) => s.items);
  const lines = Object.entries(cart).map(([id, c]) => ({ id, item: flat.find((i) => i.id === id), ...c })).filter((l) => l.item);
  const est = estimate(lines.map((l) => ({ price: l.item.price, taxRate: l.item.taxRate, qty: l.qty })));
  async function send() {
    setBusy(true); setErr(null);
    try { await post(`/staff/sessions/${sessionId}/orders`, { idempotencyKey: key.current, items: lines.map((l) => ({ menuItemId: l.id, quantity: l.qty, notes: l.notes || null })) }); onDone(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Something went wrong.'); }
    setBusy(false);
  }
  return (
    <div className="card pad stack">
      <h2>Add an order</h2>
      <ErrorNote message={err} />
      <MenuPicker sections={sections} cart={cart} setCart={(c) => { key.current = newKey(); setCart(c); }} />
      <div className="sticky-send">
        <span>{lines.reduce((n, l) => n + l.qty, 0)} items · about {rupees(est.total)}</span>
        <button className="btn primary big" disabled={busy || lines.length === 0} onClick={send}>{busy ? 'Sending…' : 'Send order to this table'}</button>
      </div>
    </div>
  );
}

function BillPanel({ bill, manager, busy, run, tableNo }: any) {
  const [method, setMethod] = useState<'CASH' | 'UPI'>('CASH');
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [voidWhy, setVoidWhy] = useState('');
  const key = useRef(newKey());
  const balance = Number(bill.balanceDue ?? 0);
  useEffect(() => { setAmount(balance > 0 ? balance.toFixed(2) : ''); }, [bill.balanceDue]);

  return (
    <aside className="bill-card">
      <div className="bill-card-head">
        <div><span className="eyebrow eyebrow-small">Running bill</span><h2>Table {tableNo}</h2></div>
        <Icon name="card" size={22} />
      </div>
      <div className="bill-lines">
        <div><span>Items</span><span>{rupees(bill.subtotal)}</span></div>
        <div><span>Tax</span><span>{rupees(bill.taxTotal)}</span></div>
        <div className="bill-total"><strong>Total</strong><strong>{rupees(bill.total)}</strong></div>
        {Number(bill.pendingValue) > 0 && <p className="muted">{rupees(bill.pendingValue)} of items are still waiting for the manager and are not counted yet.</p>}
        {!manager && <p className="muted">Payments are handled by the manager.</p>}
        {manager && <>
          <div><span>Paid so far</span><span className="paid-amount">{rupees(bill.amountPaid)}</span></div>
          <div className="bill-balance"><span>Still to pay</span><strong>{rupees(bill.balanceDue)}</strong></div>
        </>}
      </div>

      {manager && <>
        {bill.payments.length > 0 && (
          <div className="payment-actions">
            <strong>Payments</strong>
            {bill.payments.map((p: any) => (
              <div key={p.id} className={`row between wrap gap ${p.status === 'VOIDED' ? 'strike muted' : ''}`}>
                <span>{p.method === 'CASH' ? 'Cash' : 'UPI'} {rupees(p.amount)}{p.referenceNumber ? ` (ref ${p.referenceNumber})` : ''}{p.status === 'VOIDED' ? ' — cancelled' : ''}</span>
                {p.status === 'RECORDED' && <button className="btn small" onClick={() => setVoiding(voiding === p.id ? null : p.id)}>Cancel payment</button>}
                {voiding === p.id && (
                  <div className="panel stack full">
                    <input value={voidWhy} onChange={(e) => setVoidWhy(e.target.value)} placeholder="Why is this payment being cancelled?" aria-label="Reason" />
                    <button className="btn danger" disabled={busy || !voidWhy.trim()} onClick={() => run(async () => { await post(`/payments/${p.id}/void`, { reason: voidWhy }); setVoiding(null); setVoidWhy(''); })}>Yes, cancel this payment</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {balance > 0 && (
          <div className="payment-actions">
            <strong>Record a payment</strong>
            <div className="payment-button-row" role="group" aria-label="Payment type">
              <button className={`btn small ${method === 'CASH' ? 'primary' : ''}`} aria-pressed={method === 'CASH'} onClick={() => setMethod('CASH')}>Cash</button>
              <button className={`btn small ${method === 'UPI' ? 'primary' : ''}`} aria-pressed={method === 'UPI'} onClick={() => setMethod('UPI')}>UPI</button>
            </div>
            {method === 'UPI' && <>
              <p className="payment-note">Open your UPI app and check that the money has arrived. Only then record it here.</p>
              <label className="field"><span>UPI reference (optional)</span><input value={ref} onChange={(e) => setRef(e.target.value)} /></label>
            </>}
            <label className="field"><span>Amount (₹)</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <p className="payment-note">Customer paying in two ways? Record the first payment, then record the second.</p>
            <button className="btn primary" disabled={busy || !amount} onClick={() => run(async () => { await post(`/bills/${bill.id}/payments`, { method, amount, referenceNumber: ref || null, idempotencyKey: key.current }); key.current = newKey(); setRef(''); })}>Record {method === 'CASH' ? 'cash' : 'UPI'} payment</button>
          </div>
        )}

        <div className="payment-actions">
          {!confirmClose
            ? <button className="btn primary big" disabled={busy} onClick={() => setConfirmClose(true)}>Finish bill and close table</button>
            : <div className="panel stack">
              <strong>Close Table {tableNo}? (the customer's bill is finished)</strong>
              <p className="muted">The bill is finished and the table becomes free for the next customers.</p>
              <div className="row gap">
                <button className="btn primary" disabled={busy} onClick={() => run(async () => { await post(`/bills/${bill.id}/close`); setConfirmClose(false); })}>Yes, close table</button>
                <button className="btn" onClick={() => setConfirmClose(false)}>Not yet</button>
              </div>
            </div>}
        </div>
      </>}

      <div className="payment-actions">
        <button className="btn small" onClick={() => window.print()}><Icon name="printer" size={16} />Print bill</button>
      </div>
    </aside>
  );
}
