import { useEffect, useState } from 'react';
import { ApiError, get } from '../shared/api';
import { ErrorNote, Loading, PageHeader } from '../shared/ui';
import { rupees } from '../shared/lib';
import { Icon } from '../shared/icons';

const today = () => new Date().toLocaleDateString('en-CA');

export default function Reports() {
  const [date, setDate] = useState(today());
  const [pay, setPay] = useState<any>(null);
  const [sales, setSales] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setErr(null);
    Promise.all([get(`/reports/daily-payments?date=${date}`), get(`/reports/daily-sales?date=${date}`)])
      .then(([p, s]) => { setPay(p); setSales(s); }).catch((e: ApiError) => setErr(e.message));
  }, [date]);
  const m = (name: string) => pay?.byMethod.find((x: any) => x.method === name);
  const sold = sales ? sales.items.reduce((n: number, i: any) => n + Number(i.quantity), 0) : 0;

  return (
    <div>
      <PageHeader
        eyebrow="End of day view"
        title="Payments and reports"
        description="A quick picture of the day’s sales and collections."
        action={<label className="field"><span>Choose a day</span><input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>}
      />
      <ErrorNote message={err} />
      {!pay || !sales ? <Loading /> : <>
        <div className="report-grid">
          <div className="report-stat">
            <span className="report-icon orange"><Icon name="wallet" /></span>
            <span>Total received</span><strong>{rupees(pay.netAmount)}</strong>
            <small>{pay.paymentCount} payments · {pay.closedBills} bills finished</small>
          </div>
          <div className="report-stat">
            <span className="report-icon green"><Icon name="checkCircle" /></span>
            <span>Total billed</span><strong>{rupees(sales.bills.total)}</strong>
            <small>Items {rupees(sales.bills.subtotal)} · Tax {rupees(sales.bills.tax)}</small>
          </div>
          <div className="report-stat">
            <span className="report-icon"><Icon name="bag" /></span>
            <span>Items sold</span><strong>{sold}</strong>
            <small>Across {sales.items.length} different {sales.items.length === 1 ? 'item' : 'items'}</small>
          </div>
        </div>

        <div className="stack">
          <section className="report-card">
            <div className="section-heading">
              <div><h2>Money received</h2><p>Payments are recorded by hand after you receive them.</p></div>
              <span className="report-date">{date}</span>
            </div>
            <div className="payment-row">
              <div className="payment-method cash"><Icon name="wallet" /></div>
              <div><strong>Cash</strong><span>Received today</span></div>
              <b>{rupees(m('CASH')?.received)}</b>
            </div>
            <div className="payment-row">
              <div className="payment-method upi"><Icon name="card" /></div>
              <div><strong>UPI</strong><span>Received today</span></div>
              <b>{rupees(m('UPI')?.received)}</b>
            </div>
            {Number(pay.voidedAmount) > 0 && (
              <div className="payment-row">
                <div className="payment-method"><Icon name="x" /></div>
                <div><strong>Payments cancelled</strong><span>Removed from today’s total</span></div>
                <b>{rupees(pay.voidedAmount)}</b>
              </div>
            )}
          </section>

          <section className="report-card">
            <div className="section-heading"><div><h2>What was sold</h2><p>Every item on today’s finished bills.</p></div></div>
            {sales.items.length === 0 ? <p className="muted">Nothing sold on this day.</p> : (
              <div className="scroll"><table><thead><tr><th>Item</th><th>How many</th><th>Amount</th></tr></thead><tbody>
                {sales.items.map((i: any) => <tr key={i.name}><td>{i.name}</td><td>{i.quantity}</td><td>{rupees(Number(i.subtotal) + Number(i.tax))}</td></tr>)}
              </tbody></table></div>
            )}
          </section>
        </div>

        <div className="report-note"><Icon name="alert" size={18} /><span>UPI payments are recorded after checking your merchant UPI app. Nothing is verified automatically.</span></div>
      </>}
    </div>
  );
}
