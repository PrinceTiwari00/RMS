/**
 * Floor-plan state machine.
 *
 *   available ─seat→ seated ─send→ ordered ─bill→ billed ─pay→ dirty ─clean→ available
 *
 * Reverse edges exist for the real-world cases (a party walks out, a bill is
 * reopened after a payment error). Every transition is validated server-side so
 * two terminals cannot both seat the same table.
 */

export type TableStatus = "available" | "seated" | "ordered" | "billed" | "dirty";

export const TABLE_STATUSES: TableStatus[] = ["available", "seated", "ordered", "billed", "dirty"];

export const ALLOWED_TRANSITIONS: Record<TableStatus, TableStatus[]> = {
  available: ["seated"],
  seated: ["ordered", "available"],
  ordered: ["billed", "seated"],
  billed: ["dirty", "ordered"],
  dirty: ["available"],
};

export const TABLE_STATUS_LABEL: Record<TableStatus, string> = {
  available: "Available",
  seated: "Seated",
  ordered: "Ordered",
  billed: "Billed",
  dirty: "Dirty",
};

/** Token colours consumed by both the floor plan and the POS table picker. */
export const TABLE_STATUS_COLOR: Record<TableStatus, string> = {
  available: "var(--table-available)",
  seated: "var(--table-seated)",
  ordered: "var(--table-ordered)",
  billed: "var(--table-billed)",
  dirty: "var(--table-dirty)",
};

export function canTransition(from: TableStatus, to: TableStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: TableStatus, to: TableStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal table transition: ${from} → ${to}`);
  }
}

/** Tables that can seat a party of `size` right now. */
export function seatableCapacity(capacity: number, size: number): boolean {
  return capacity >= size;
}

/** Minutes a table has been occupied — drives the live timer on the floor plan. */
export function turnLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Occupancy percentage across a floor plan snapshot. */
export function occupancy(stats: { total: number; occupied: number }): number {
  if (!stats.total) return 0;
  return Math.round((stats.occupied / stats.total) * 100);
}

export const SHAPES = ["round", "square", "rect", "booth", "bar"] as const;
export type TableShape = (typeof SHAPES)[number];
