/**
 * Audit trail.
 *
 * Every sensitive or money-touching action — voids, discounts, price edits,
 * timesheet overrides, permission changes, stock adjustments, drawer counts —
 * writes a row here. Reports read it; nobody can quietly delete it.
 */
import { all, run, uuid } from "@/db/client";
import { nowStamp } from "@/domain/time";
import type { AuditEntry, SessionUser } from "@/types";

export function audit(
  actor: Pick<SessionUser, "id" | "name"> | null,
  action: string,
  entityType?: string | null,
  entityId?: string | null,
  detail?: string | null,
): string {
  const id = uuid();
  run(
    `INSERT INTO audit_log (id, actor_id, actor_name, action, entity_type, entity_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    actor?.id ?? null,
    actor?.name ?? "system",
    action,
    entityType ?? null,
    entityId ?? null,
    detail ?? null,
    nowStamp(),
  );
  return id;
}

interface AuditRow {
  id: string;
  actor_name: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: string | null;
  created_at: string;
}

export function recentAudit(limit = 50, actionPrefix?: string): AuditEntry[] {
  const rows = actionPrefix
    ? all<AuditRow>("SELECT * FROM audit_log WHERE action LIKE ? ORDER BY created_at DESC LIMIT ?", `${actionPrefix}%`, limit)
    : all<AuditRow>("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?", limit);
  return rows.map((row) => ({
    id: row.id,
    actorName: row.actor_name,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}
