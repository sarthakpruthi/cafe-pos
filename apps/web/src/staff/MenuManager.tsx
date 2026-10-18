import { useCallback, useEffect, useState } from 'react';
import { ApiError, get, patch, post, put } from '../shared/api';
import { ErrorNote, Loading, PageHeader } from '../shared/ui';
import { FOOD, rupees } from '../shared/lib';
import { Icon } from '../shared/icons';

const blank = (sectionId: string) => ({ sectionId, name: '', description: '', foodType: 'VEG', price: '', taxRate: '5' });

export default function MenuManager() {
  const [menu, setMenu] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [secForm, setSecForm] = useState<any>(null);    // {id?, name, description}
  const [itemForm, setItemForm] = useState<any>(null);  // item fields (+id when editing)
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { get('/menu').then(setMenu).catch((e: ApiError) => setErr(e.message)); }, []);
  useEffect(load, [load]);
  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true); setErr(null);
    try { await fn(); after?.(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Something went wrong.'); }
    setBusy(false); load();
  }
  if (!menu) return err ? <ErrorNote message={err} /> : <Loading />;
  const move = (type: 'sections' | 'items', ids: string[], i: number, d: number) => {
    const next = [...ids]; [next[i], next[i + d]] = [next[i + d], next[i]];
    run(() => put('/menu/sort', { type, ids: next }));
  };
  const needle = q.trim().toLowerCase();

  return (
    <div>
      <PageHeader
        eyebrow="Catalog"
        title="Menu"
        description="Changes show to customers straight away. Items already ordered keep the price they were ordered at."
        action={<button className="btn primary" onClick={() => setSecForm({ name: '', description: '' })}><Icon name="plus" size={17} />Add a section</button>}
      />
      <ErrorNote message={err} onClose={() => setErr(null)} />

      <div className="menu-notice"><Icon name="menu" /><span>Changes here are visible to customers the next time they open the menu.</span></div>

      <label className="field"><span>Search items</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type an item name" /></label>

      {secForm && (
        <div className="card pad stack">
          <h2>{secForm.id ? 'Change section' : 'New section'}</h2>
          <label className="field"><span>Section name</span><input value={secForm.name} onChange={(e) => setSecForm({ ...secForm, name: e.target.value })} placeholder="For example: Hot drinks" /></label>
          <label className="field"><span>Short description (optional)</span><input value={secForm.description ?? ''} onChange={(e) => setSecForm({ ...secForm, description: e.target.value })} /></label>
          <div className="row gap">
            <button className="btn primary" disabled={busy || !secForm.name.trim()} onClick={() => run(() => secForm.id
              ? patch(`/menu/sections/${secForm.id}`, { name: secForm.name, description: secForm.description || null })
              : post('/menu/sections', { name: secForm.name, description: secForm.description || null }), () => setSecForm(null))}>Save section</button>
            <button className="btn" onClick={() => setSecForm(null)}>Cancel</button>
          </div>
        </div>
      )}

      {itemForm && (
        <div className="card pad stack">
          <h2>{itemForm.id ? 'Change item' : 'New item'}</h2>
          <label className="field"><span>Item name</span><input value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} /></label>
          <label className="field"><span>Short description (optional)</span><input value={itemForm.description ?? ''} onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })} /></label>
          <label className="field"><span>Section</span>
            <select value={itemForm.sectionId} onChange={(e) => setItemForm({ ...itemForm, sectionId: e.target.value })}>
              {menu.sections.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          <div className="row gap" role="group" aria-label="Food type">
            {Object.entries(FOOD).map(([v, l]) => <button key={v} className={`btn small ${itemForm.foodType === v ? 'primary' : ''}`} aria-pressed={itemForm.foodType === v} onClick={() => setItemForm({ ...itemForm, foodType: v })}>{l}</button>)}
          </div>
          <label className="field"><span>Price (₹, before tax)</span><input inputMode="decimal" value={itemForm.price} onChange={(e) => setItemForm({ ...itemForm, price: e.target.value })} /></label>
          <label className="field"><span>Tax (%)</span><input inputMode="decimal" value={itemForm.taxRate} onChange={(e) => setItemForm({ ...itemForm, taxRate: e.target.value })} /></label>
          <div className="row gap">
            <button className="btn primary" disabled={busy || !itemForm.name.trim() || itemForm.price === ''} onClick={() => {
              const body = { sectionId: itemForm.sectionId, name: itemForm.name, description: itemForm.description || null, foodType: itemForm.foodType, price: itemForm.price, taxRate: Number(itemForm.taxRate) };
              run(() => itemForm.id ? patch(`/menu/items/${itemForm.id}`, body) : post('/menu/items', body), () => setItemForm(null));
            }}>Save item</button>
            <button className="btn" onClick={() => setItemForm(null)}>Cancel</button>
          </div>
        </div>
      )}

      {menu.sections.length === 0 && <p className="muted pad">There are no sections yet. Tap "Add a section" to begin.</p>}
      {menu.sections.map((s: any, si: number) => {
        const items = s.items.filter((i: any) => !needle || i.name.toLowerCase().includes(needle));
        if (needle && items.length === 0) return null;
        return (
          <section key={s.id} className="menu-section">
            <div className="section-heading">
              <div><h2>{s.name} {!s.isActive && <span className="tag red">Hidden from customers</span>}</h2></div>
              <div className="menu-actions">
                <button className="btn small" disabled={si === 0 || busy} onClick={() => move('sections', menu.sections.map((x: any) => x.id), si, -1)}>Move up</button>
                <button className="btn small" disabled={si === menu.sections.length - 1 || busy} onClick={() => move('sections', menu.sections.map((x: any) => x.id), si, 1)}>Move down</button>
                <button className="btn small" onClick={() => setSecForm({ id: s.id, name: s.name, description: s.description })}>Change</button>
                <button className="btn small" disabled={busy} onClick={() => run(() => patch(`/menu/sections/${s.id}`, { isActive: !s.isActive }))}>{s.isActive ? 'Hide section' : 'Show section'}</button>
                <button className="btn primary small" onClick={() => setItemForm(blank(s.id))}><Icon name="plus" size={15} />Add an item</button>
              </div>
            </div>
            <div className={`menu-admin-list ${s.isActive ? '' : 'faded'}`}>
              {items.length === 0 && <p className="muted pad">No items yet.</p>}
              {items.map((i: any, ii: number) => (
                <div key={i.id} className={`menu-admin-row ${i.isActive && i.isAvailable ? '' : 'unavailable-row'}`}>
                  <span className="menu-food-icon"><Icon name="coffee" size={18} /></span>
                  <div className="menu-admin-info">
                    <strong>{i.name}</strong>
                    <span>{i.description}</span>
                  </div>
                  <span className={`food-tag ${i.foodType.toLowerCase()}`}>{FOOD[i.foodType]}</span>
                  <span className="menu-price">{rupees(i.price)} <small>+ {Number(i.taxRate)}% tax</small></span>
                  <span className={`availability ${i.isActive && i.isAvailable ? 'is-available' : 'is-unavailable'}`}>
                    {!i.isActive ? 'Hidden' : i.isAvailable ? 'Available' : 'Sold out'}
                  </span>
                  <div className="menu-actions">
                    {i.isActive && <button className={`btn small ${i.isAvailable ? '' : 'primary'}`} disabled={busy} onClick={() => run(() => patch(`/menu/items/${i.id}`, { isAvailable: !i.isAvailable }))}>{i.isAvailable ? 'Sold out' : 'Available'}</button>}
                    <button className="btn small" disabled={ii === 0 || !!needle || busy} onClick={() => move('items', s.items.map((x: any) => x.id), ii, -1)}>Up</button>
                    <button className="btn small" disabled={ii === s.items.length - 1 || !!needle || busy} onClick={() => move('items', s.items.map((x: any) => x.id), ii, 1)}>Down</button>
                    <button className="btn small" onClick={() => setItemForm({ ...i, price: String(i.price), taxRate: String(Number(i.taxRate)) })}>Change</button>
                    <button className="btn small" disabled={busy} onClick={() => run(() => patch(`/menu/items/${i.id}`, { isActive: !i.isActive }))}>{i.isActive ? 'Hide' : 'Show'}</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
