export const rupees = (v: string | number | null | undefined) =>
  '₹' + Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
export const dateTimeOf = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const minutesAgo = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

export const FOOD: Record<string, string> = { VEG: 'Veg', NON_VEG: 'Non-veg', EGG: 'Egg' };

/** Words people understand. Never colour alone. */
export const ITEM_STATUS: Record<string, { staff: string; customer: string; tone: string }> = {
  PENDING: { staff: 'Waiting', customer: 'Waiting for the cafe to confirm', tone: 'amber' },
  ACCEPTED: { staff: 'Accepted', customer: 'Confirmed', tone: 'blue' },
  SERVED: { staff: 'Served', customer: 'Served', tone: 'green' },
  REJECTED: { staff: 'Rejected', customer: 'Not available', tone: 'red' },
  CANCELLED: { staff: 'Cancelled', customer: 'Cancelled', tone: 'grey' },
};
export const ORDER_STATUS: Record<string, string> = {
  PENDING: 'Waiting', PARTIALLY_ACCEPTED: 'Partly accepted', ACCEPTED: 'Accepted', PARTIALLY_SERVED: 'Partly served',
  SERVED: 'Served', REJECTED: 'Rejected', PARTIALLY_REJECTED: 'Some rejected', CANCELLED: 'Cancelled',
};
export const orderTone = (s: string) =>
  ({ PENDING: 'amber', PARTIALLY_ACCEPTED: 'amber', PARTIALLY_REJECTED: 'amber', ACCEPTED: 'blue', PARTIALLY_SERVED: 'blue', SERVED: 'green', REJECTED: 'red', CANCELLED: 'grey' } as any)[s] ?? 'grey';

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-key`);

/**
 * A random, reasonably strong password. Look-alike characters (0/O, 1/l/I) are excluded so it
 * stays easy to read aloud or retype on a phone.
 */
export function randomPassword(len = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(len));
  return Array.from(bytes, (n) => chars[n % chars.length]).join('');
}

/** Estimated totals for a cart (the server always recalculates the real ones). */
export function estimate(lines: Array<{ price: string; taxRate: string | number; qty: number }>) {
  let sub = 0, tax = 0;
  for (const l of lines) {
    const s = Math.round(Number(l.price) * 100) * l.qty;
    sub += s; tax += Math.round((s * Number(l.taxRate)) / 100);
  }
  return { subtotal: sub / 100, tax: tax / 100, total: (sub + tax) / 100 };
}

export const AUDIT_WORDS: Record<string, string> = {
  ORDER_CREATED: 'Customer sent an order', ORDER_CREATED_BY_STAFF: 'Staff added an order', ORDER_ACCEPTED: 'Order accepted',
  ORDER_REJECTED: 'Order rejected', ORDER_CANCELLED: 'Order cancelled', ORDER_SERVED: 'Order marked served',
  ITEM_ACCEPTED: 'Item accepted', ITEM_REJECTED: 'Item rejected', ITEM_CANCELLED: 'Item cancelled', ITEM_SERVED: 'Item marked served',
  ITEM_EDITED: 'Item changed', PAYMENT_RECORDED: 'Payment recorded', PAYMENT_VOIDED: 'Payment cancelled', SESSION_STARTED: 'Table started',
  SESSION_CLOSED: 'Table closed and bill finished', MENU_SECTION_CREATED: 'Menu section added', MENU_SECTION_UPDATED: 'Menu section changed',
  MENU_SECTION_HIDDEN: 'Menu section hidden', MENU_ITEM_CREATED: 'Menu item added', MENU_ITEM_UPDATED: 'Menu item changed',
  MENU_ITEM_PRICE_CHANGED: 'Menu item price changed', MENU_ITEM_HIDDEN: 'Menu item hidden', MENU_REORDERED: 'Menu order changed',
  USER_CREATED: 'Login created', USER_UPDATED: 'Login changed', USER_PASSWORD_RESET: 'Password reset', QR_REGENERATED: 'QR code replaced',
  CAFE_CREATED: 'Cafe created', CAFE_UPDATED: 'Cafe details changed',
};
