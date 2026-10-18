import type { Q } from './db.js';

export interface AuditInput {
  actor?: string | null; action: string; entityType: string; entityId: string;
  oldValue?: unknown; newValue?: unknown; reason?: string | null; requestId?: string;
}
export async function audit(c: Q, a: AuditInput) {
  await c.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, old_value, new_value, reason, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.actor ?? null, a.action, a.entityType, a.entityId,
     a.oldValue === undefined ? null : JSON.stringify(a.oldValue),
     a.newValue === undefined ? null : JSON.stringify(a.newValue),
     a.reason ?? null, a.requestId ?? null]);
}
