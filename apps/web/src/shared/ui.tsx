import type { ReactNode } from 'react';
import { ITEM_STATUS, ORDER_STATUS, orderTone } from './lib';

export const Badge = ({ tone, children }: { tone: string; children: ReactNode }) =>
  <span className={`badge ${tone}`}><i className="badge-dot" aria-hidden="true" />{children}</span>;
export const ItemBadge = ({ status }: { status: string }) => <Badge tone={ITEM_STATUS[status]?.tone ?? 'grey'}>{ITEM_STATUS[status]?.staff ?? status}</Badge>;
export const OrderBadge = ({ status }: { status: string }) => <Badge tone={orderTone(status)}>{ORDER_STATUS[status] ?? status}</Badge>;

/** The cafe wordmark, shared by every surface. */
export const BrandMark = ({ name, subtitle = 'Cafe order desk' }: { name: string; subtitle?: string }) => (
  <span className="brand-mark">
    <span className="brand-ring">{(name || 'C').trim().charAt(0).toUpperCase()}</span>
    <span><strong>{name}</strong><small>{subtitle}</small></span>
  </span>
);

export const PageHeader = ({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) => (
  <div className="page-header">
    <div>
      {eyebrow && <div className="eyebrow eyebrow-small">{eyebrow}</div>}
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
    {action}
  </div>
);

export const ErrorNote = ({ message, onClose }: { message: string | null; onClose?: () => void }) =>
  message ? (
    <div className="note error" role="alert">
      <span>{message}</span>
      {onClose && <button className="btn small" onClick={onClose}>Close</button>}
    </div>
  ) : null;

export const Loading = ({ text = 'Loading…' }: { text?: string }) => <p className="muted pad">{text}</p>;

export function Stepper({ value, onChange, min = 0, label }: { value: number; onChange: (n: number) => void; min?: number; label: string }) {
  return (
    <span className="stepper">
      <button className="btn" aria-label={`Less ${label}`} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <strong aria-live="polite">{value}</strong>
      <button className="btn" aria-label={`More ${label}`} onClick={() => onChange(Math.min(50, value + 1))}>+</button>
    </span>
  );
}
