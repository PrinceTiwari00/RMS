/**
 * Floor plan service — the table state machine plus the geometry the builder edits.
 *
 * Status changes are guarded by the domain transition table and applied with a
 * conditional UPDATE, so two terminals tapping the same table at once cannot
 * both win: the loser sees "changed concurrently" instead of corrupting state.
 */
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, conflict, notFound } from "@/server/router";
import { assertTransition, canTransition } from "@/domain/tables";
import { elapsedMinutes, nowStamp } from "@/domain/time";
import type { TableStatus } from "@/domain/tables";
import type { Section, SessionUser, TableSnapshot } from "@/types";
import { createOrder } from "@/server/orders";
import { audit } from "@/server/audit";
import { emitEvent } from "@/server/events";
import { closeTableSession } from "@/server/engagement";

interface TableRow {
  id: string;
  label: string;
  section_id: string | null;
  capacity: number;
  shape: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  status: string;
  guests: number;
  server_id: string | null;
  seated_at: string | null;
  sort_order: number;
  section_name: string | null;
  server_name: string | null;
  order_id: string | null;
  order_status: string | null;
  check_number: number | null;
  order_total: number | null;
  item_count: number | null;
  oldest_minutes: number | null;
  active_help_count: number | null;
  pending_approval_count: number | null;
}

const TABLE_SELECT = `
  SELECT t.*, s.name AS section_name, e.name AS server_name,
         o.id AS order_id, o.status AS order_status, o.check_number,
         o.total AS order_total,
         (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.is_void = 0) AS item_count,
         (SELECT COUNT(*) FROM service_requests sr WHERE sr.table_id = t.id AND sr.status IN ('open','acknowledged')) AS active_help_count,
         (SELECT COUNT(*) FROM orders po WHERE po.table_id = t.id AND po.status IN ('open','sent') AND po.approval_status = 'pending_staff') AS pending_approval_count
    FROM tables t
    LEFT JOIN sections s ON s.id = t.section_id
    LEFT JOIN employees e ON e.id = t.server_id
    LEFT JOIN orders o ON o.table_id = t.id AND o.status IN ('open','sent')`;

export function getSections(): Section[] {
  return all<{ id: string; name: string; color: string; sort_order: number }>(
    "SELECT * FROM sections ORDER BY sort_order, name",
  ).map((row) => ({ id: row.id, name: row.name, color: row.color, sortOrder: row.sort_order }));
}

export function getTables(): TableSnapshot[] {
  return all<TableRow>(`${TABLE_SELECT} ORDER BY t.sort_order, t.label`).map((row) => {
    const minutesSeated = row.seated_at ? elapsedMinutes(row.seated_at) : 0;
    const activeHelpCount = Number(row.active_help_count ?? 0);
    const pendingApprovalCount = Number(row.pending_approval_count ?? 0);
    const status = row.status as TableStatus;
    const liveStage: TableSnapshot["liveStage"] =
      activeHelpCount > 0
        ? "HELP"
        : status === "billed"
          ? "BILL"
          : pendingApprovalCount > 0 || status === "seated"
            ? "ORDERING"
            : status === "ordered"
              ? "EATING"
              : status === "dirty"
                ? "DIRTY"
                : "IDLE";
    return {
      id: row.id,
      label: row.label,
      sectionId: row.section_id,
      sectionName: row.section_name ?? "Unassigned",
      capacity: row.capacity,
      shape: row.shape as TableSnapshot["shape"],
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      rotation: row.rotation,
      status,
      guests: row.guests,
      serverId: row.server_id,
      serverName: row.server_name ?? "",
      seatedAt: row.seated_at,
      minutesSeated,
      orderId: row.order_id,
      orderStatus: row.order_status,
      checkNumber: row.check_number,
      totalPaisa: Number(row.order_total ?? 0),
      itemCount: Number(row.item_count ?? 0),
      oldestItemMinutes: Number(row.oldest_minutes ?? 0),
      activeHelpCount,
      pendingApprovalCount,
      liveStage,
    };
  });
}

export function getTable(id: string): TableSnapshot | undefined {
  return getTables().find((table) => table.id === id);
}

export function requireTable(id: string): TableSnapshot {
  const table = getTable(id);
  if (!table) throw notFound("Table not found");
  return table;
}

/** Smallest available table that fits the party — what the host stand suggests. */
export function suggestTable(partySize: number): TableSnapshot | null {
  const candidates = getTables()
    .filter((table) => table.status === "available" && table.capacity >= partySize)
    .sort((a, b) => a.capacity - b.capacity || a.label.localeCompare(b.label));
  return candidates[0] ?? null;
}

export interface SeatInput {
  guests: number;
  serverId?: string | null;
  /** Create a ticket immediately instead of only marking the table seated. */
  createOrder?: boolean;
}

export function seatParty(tableId: string, input: SeatInput, actor: SessionUser | null): { table: TableSnapshot; orderId: string | null } {
  const table = requireTable(tableId);
  const guests = Math.max(1, Math.round(Number(input.guests ?? 1)));
  if (guests > table.capacity) {
    throw badRequest(`Table ${table.label} seats ${table.capacity} — that party of ${guests} will not fit`);
  }
  assertTransition(table.status, "seated");

  const stamp = nowStamp();
  let orderId: string | null = null;

  tx(() => {
    const changed = run(
      "UPDATE tables SET status = 'seated', guests = ?, server_id = ?, seated_at = ? WHERE id = ? AND status = ?",
      guests,
      input.serverId ?? actor?.id ?? null,
      stamp,
      tableId,
      table.status,
    ).changes;
    if (!changed) throw conflict("That table was just changed by someone else — refresh and try again");
  });

  if (input.createOrder) {
    orderId = createOrder(
      { tableId, guests, channel: "dine_in", serverId: input.serverId ?? actor?.id ?? null },
      actor,
    ).id;
  }
  return { table: requireTable(tableId), orderId };
}

/** Conditional single-step transition used by the floor plan taps. */
export function setTableStatus(tableId: string, to: TableStatus, actor: SessionUser | null): TableSnapshot {
  const table = requireTable(tableId);
  if (table.status === to) return table;
  if (!canTransition(table.status, to)) throw badRequest(`Cannot move table ${table.label} from ${table.status} to ${to}`);

  tx(() => {
    const changed = run("UPDATE tables SET status = ? WHERE id = ? AND status = ?", to, tableId, table.status).changes;
    if (!changed) throw conflict("That table was just changed by someone else — refresh and try again");
    if (to === "available") {
      run("UPDATE tables SET guests = 0, server_id = NULL, seated_at = NULL WHERE id = ?", tableId);
    }
  });
  if (to === "available") {
    closeTableSession(tableId);
    audit(actor, "floor.reset", "table", tableId, `table ${table.label} cleared`);
  }
  emitEvent("floor.updated", { tableId });
  return requireTable(tableId);
}

/** Dirty -> available: the table has been cleaned and reset. */
export function cleanTable(tableId: string, actor: SessionUser | null): TableSnapshot {
  const table = requireTable(tableId);
  if (table.status !== "dirty") throw badRequest(`Table ${table.label} is ${table.status}, not dirty`);
  return setTableStatus(tableId, "available", actor);
}

/** Seat -> billed without a check (walk-out / manager close). */
export function releaseTable(tableId: string, actor: SessionUser | null): TableSnapshot {
  const table = requireTable(tableId);
  if (table.status === "available") return table;
  tx(() => {
    run("UPDATE tables SET status = 'available', guests = 0, server_id = NULL, seated_at = NULL WHERE id = ?", tableId);
  });
  closeTableSession(tableId);
  audit(actor, "floor.release", "table", tableId, `table ${table.label} released`);
  emitEvent("floor.updated", { tableId });
  return requireTable(tableId);
}

// --------------------------------------------------------------- floor builder
/** Employees who can be assigned a table — used by the seating dialog. */
export function getServers(): { id: string; name: string; initials: string; color: string; roleTitle: string }[] {
  return all<{ id: string; name: string; initials: string; color: string; title: string | null }>(
    `SELECT e.id, e.name, e.initials, e.color, r.title FROM employees e
       LEFT JOIN roles r ON r.id = e.role_id
      WHERE e.is_active = 1 AND r.name IN ('server','manager','host','bartender')
      ORDER BY e.name`,
  ).map((row) => ({ id: row.id, name: row.name, initials: row.initials, color: row.color, roleTitle: row.title ?? "Server" }));
}

export function createSection(input: { name: string; color?: string }, actor: SessionUser | null = null): Section {
  const name = String(input.name ?? "").trim();
  if (!name) throw badRequest("Section name is required");
  const id = uuid();
  const sortOrder = Number(get<{ next: number }>("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM sections")?.next ?? 0);
  run("INSERT INTO sections (id, name, color, sort_order) VALUES (?, ?, ?, ?)", id, name, input.color ?? "#137c70", sortOrder);
  audit(actor, "floor.section.create", "section", id, name);
  return getSections().find((section) => section.id === id)!;
}

export function updateSection(id: string, patch: { name?: string; color?: string }, actor: SessionUser | null = null): Section {
  const existing = get<{ id: string; name: string; color: string }>("SELECT * FROM sections WHERE id = ?", id);
  if (!existing) throw notFound("Section not found");
  run("UPDATE sections SET name = ?, color = ? WHERE id = ?", patch.name ?? existing.name, patch.color ?? existing.color, id);
  audit(actor, "floor.section.update", "section", id, patch.name ?? existing.name);
  return getSections().find((section) => section.id === id)!;
}

export function deleteSection(id: string, actor: SessionUser | null = null): void {
  const tables = Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM tables WHERE section_id = ?", id)?.n ?? 0);
  if (tables > 0) throw badRequest(`Move the ${tables} table(s) in this section first`);
  run("DELETE FROM sections WHERE id = ?", id);
  audit(actor, "floor.section.delete", "section", id, null);
}

export interface TableLayoutInput {
  label?: string;
  sectionId?: string | null;
  capacity?: number;
  shape?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rotation?: number;
}

export function createTable(input: TableLayoutInput): TableSnapshot {
  const label = String(input.label ?? "").trim();
  if (!label) throw badRequest("Table label is required");
  if (get("SELECT id FROM tables WHERE label = ?", label)) throw badRequest(`Table ${label} already exists`);
  const id = uuid();
  const sortOrder = Number(get<{ next: number }>("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM tables")?.next ?? 0);
  run(
    `INSERT INTO tables (id, label, section_id, capacity, shape, x, y, w, h, rotation, status, guests, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 0, ?)`,
    id,
    label,
    input.sectionId ?? null,
    Math.max(1, Math.round(Number(input.capacity ?? 4))),
    input.shape ?? "round",
    clampPercent(input.x ?? 10),
    clampPercent(input.y ?? 10),
    Math.max(4, Number(input.w ?? 12)),
    Math.max(4, Number(input.h ?? 12)),
    Number(input.rotation ?? 0),
    sortOrder,
  );
  return requireTable(id);
}

/** Persist geometry/labels from the drag-and-drop builder. */
export function updateTableLayout(id: string, patch: TableLayoutInput): TableSnapshot {
  const table = requireTable(id);
  const row = get<{ label: string; section_id: string | null; capacity: number; shape: string; x: number; y: number; w: number; h: number; rotation: number }>(
    "SELECT * FROM tables WHERE id = ?",
    id,
  );
  if (!row) throw notFound("Table not found");
  if (patch.label && patch.label !== row.label && get("SELECT id FROM tables WHERE label = ? AND id != ?", patch.label, id)) {
    throw badRequest(`Table ${patch.label} already exists`);
  }
  run(
    `UPDATE tables SET label = ?, section_id = ?, capacity = ?, shape = ?, x = ?, y = ?, w = ?, h = ?, rotation = ?
      WHERE id = ?`,
    patch.label ?? row.label,
    patch.sectionId !== undefined ? patch.sectionId : row.section_id,
    patch.capacity !== undefined ? Math.max(1, Math.round(Number(patch.capacity))) : row.capacity,
    patch.shape ?? row.shape,
    patch.x !== undefined ? clampPercent(patch.x) : row.x,
    patch.y !== undefined ? clampPercent(patch.y) : row.y,
    patch.w !== undefined ? Math.max(4, Number(patch.w)) : row.w,
    patch.h !== undefined ? Math.max(4, Number(patch.h)) : row.h,
    patch.rotation !== undefined ? Number(patch.rotation) : row.rotation,
  );
  void table;
  return requireTable(id);
}

/** Bulk-save a whole layout in one transaction (drag-and-drop auto-save). */
export function saveLayout(tables: (TableLayoutInput & { id: string })[]): void {
  tx(() => {
    for (const entry of tables) updateTableLayout(entry.id, entry);
  });
}

export function deleteTable(id: string): void {
  const table = requireTable(id);
  if (table.orderId) throw badRequest(`Table ${table.label} has a live ticket — close it first`);
  tx(() => {
    run("UPDATE qr_tokens SET table_id = NULL WHERE table_id = ?", id);
    run("DELETE FROM tables WHERE id = ?", id);
  });
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

/** Occupancy snapshot for the floor plan header and the exec dashboard. */
export function floorStats(): { total: number; occupied: number; seats: number; guests: number; dirty: number; byStatus: Record<string, number> } {
  const tables = getTables();
  const byStatus: Record<string, number> = {};
  for (const table of tables) byStatus[table.status] = (byStatus[table.status] ?? 0) + 1;
  return {
    total: tables.length,
    occupied: tables.filter((table) => table.status !== "available").length,
    seats: tables.reduce((total, table) => total + table.capacity, 0),
    guests: tables.reduce((total, table) => total + table.guests, 0),
    dirty: byStatus.dirty ?? 0,
    byStatus,
  };
}
