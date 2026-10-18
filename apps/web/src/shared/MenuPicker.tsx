import { useMemo, useState } from 'react';
import { FOOD, rupees } from './lib';
import { Stepper } from './ui';
import { Icon } from './icons';

export type Cart = Record<string, { qty: number; notes: string }>;
export interface MenuItem { id: string; name: string; description: string | null; foodType: string; price: string; taxRate: string; isAvailable: boolean; }
export interface MenuSection { id: string; name: string; items: MenuItem[]; }

const FILTERS: [string, string][] = [['ALL', 'Everything'], ['VEG', 'Veg'], ['NON_VEG', 'Non-veg'], ['EGG', 'Egg']];

/** Shared by the customer page and the staff "add an order" panel. */
export function MenuPicker({ sections, cart, setCart }: { sections: MenuSection[]; cart: Cart; setCart: (c: Cart) => void }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('ALL');
  const set = (id: string, qty: number) => {
    const next = { ...cart };
    if (qty <= 0) delete next[id]; else next[id] = { qty, notes: next[id]?.notes ?? '' };
    setCart(next);
  };
  const shown = useMemo(() => sections.map((s) => ({
    ...s,
    items: s.items.filter((i) => (type === 'ALL' || i.foodType === type) && (!q.trim() || (i.name + ' ' + (i.description ?? '')).toLowerCase().includes(q.trim().toLowerCase()))),
  })).filter((s) => s.items.length), [sections, q, type]);

  return (
    <div>
      <div className="customer-search">
        <Icon name="search" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the menu" aria-label="Search the menu" />
      </div>
      <div className="filter-row" role="group" aria-label="Show only">
        <span>Show</span>
        {FILTERS.map(([v, l]) => (
          <button key={v} className={`filter-chip ${type === v ? 'selected' : ''}`} aria-pressed={type === v} onClick={() => setType(v)}>{l}</button>
        ))}
      </div>

      {shown.length === 0 && <p className="muted pad">Nothing matches. Try a different word.</p>}
      {shown.map((s) => (
        <section key={s.id} className="menu-section">
          <div className="section-heading"><div><h2>{s.name}</h2><p>{s.items.length} {s.items.length === 1 ? 'item' : 'items'}</p></div><span className="section-line" /></div>
          <div className="customer-menu-list">
            {s.items.map((i) => (
              <article key={i.id} className={`customer-item ${i.isAvailable ? '' : 'customer-item-disabled'}`}>
                <span className="customer-item-mark"><Icon name="coffee" size={21} /></span>
                <div className="customer-item-main">
                  <div className="customer-item-title">
                    <h3>{i.name}</h3>
                    <span className={`food-tag ${i.foodType.toLowerCase()}`}>{FOOD[i.foodType]}</span>
                  </div>
                  {i.description && <p>{i.description}</p>}
                  <strong>{rupees(i.price)} <small>+ taxes</small></strong>
                  {!i.isAvailable && <span className="sold-out">Not available today</span>}
                </div>
                {i.isAvailable && (
                  <span className="customer-item-control">
                    {cart[i.id]
                      ? <Stepper value={cart[i.id].qty} onChange={(n) => set(i.id, n)} label={i.name} />
                      : <button className="btn primary small" onClick={() => set(i.id, 1)} aria-label={`Add ${i.name}`}><Icon name="plus" size={16} /> Add</button>}
                  </span>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
