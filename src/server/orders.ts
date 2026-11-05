/**
 * Order service — ticket lifecycle and price-at-time snapshots.
 *
 * Every line locks the menu price and each modifier adjustment at the moment it
 * is rung in, so a later price change can never rewrite history. Totals for a
 * live ticket are always derived (lines + discounts + current tax settings);
 * the stored money columns are the frozen snapshot written when the check closes.
 */
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, notFound } from "@/server/router";
import { getSettings, stationName } from "@/server/settings";
import { validateModifierSelection } from "@/server/menu";
import { audit } from "@/server/audit";
import { priceOrder, resolveDiscount } from "@/domain/pricing";
import { canBump, initialKdsStatus, urgency } from "@/domain/kds";
import { businessDateNow, elapsedMinutes, nowStamp } from "@/domain/time";
import type { Course, KdsStatus } from "@/domain/kds";
import type { OrderLine, OrderSnapshot, SessionUser, Tender } from "@/types";

export const ORDER_STATUSES = ["open", "sent", "closed", "voided"] as const;
export const ORDER_CHANNELS = ["dine_in", "takeout", "delivery", "qr"] as const;

interface OrderRow {
  id: string;
  check_number: number | null;
  table_id: string | null;
  terminal_id: string | null;
  server_id: string | null;
  status: string;
  channel: string;
  guests: number;
  subtotal: number;
  discount: number;
  vat: number;
  service_charge: number;
  tip: number;
  total: number;
  qr_token: string | null;
  guest_name: string;
  note: string;
  business_date: string | null;
  created_at: string;
  sent_at: string | null;
  fired_at: string | null;
  closed_at: string | null;
  table_label: string | null;
  server_name: string | null;
}

interface LineRow {
  id: string;
  order_id: string;
  menu_item_id: string | null;
  name_snapshot: string;
  quantity: number;
  price_at_time: number;
  course: string;
  station: string;
  seat: number;
  note: string;
  kds_status: string;
  is_void: number;
  void_reason: string | null;
  created_at: string;
  sent_at: string | null;
  ready_at: string | null;
  bumped_at: string | null;
}

interface LineModifierRow {
  id: string;
  order_item_id: string;
  modifier_id: string | null;
  group_name: string;
  name_snapshot: string;
  price_at_time: number;
}

const ORDER_SELECT = `
  SELECT o.*, t.label AS table_label, e.name AS server_name
    FROM orders o
    LEFT JOIN tables t ON t.id = o.table_id
    LEFT JOIN employees e ON e.id = o.server_id`;

export function nextCheckNumber(): number {
  const row = get<{ next: number }>("SELECT COALESCE(MAX(check_number), 1000) + 1 AS next FROM orders");
  return Number(row?.next ?? 1001);
}

function loadLines(orderId: string): OrderLine[] {
  const rows = all<LineRow>("SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at, rowid", orderId);
  const modifiers = all<LineModifierRow>("SELECT * FROM order_item_modifiers WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)", orderId);
  const byLine = new Map<string, LineModifierRow[]>();
  for (const modifier of modifiers) {
    const list = byLine.get(modifier.order_item_id) ?? [];
    list.push(modifier);
    byLine.set(modifier.order_item_id, list);
  }
  return rows.map((row) => mapLine(row, byLine.get(row.id) ?? []));
}

function mapLine(row: LineRow, modifiers: LineModifierRow[]): OrderLine {
  const lineModifiers = modifiers.map((modifier) => ({
    id: modifier.id,
    modifierId: modifier.modifier_id,
    groupName: modifier.group_name,
    name: modifier.name_snapshot,
    price: modifier.price_at_time,
  }));
  const modifierTotal = lineModifiers.reduce((total, modifier) => total + modifier.price, 0);
  const effectiveUnitPrice = row.price_at_time + modifierTotal;
  const isVoid = Boolean(row.is_void);
  const minutesElapsed = elapsedMinutes(row.sent_at ?? row.created_at);
  return {
    id: row.id,
    orderId: row.order_id,
    menuItemId: row.menu_item_id,
    name: row.name_snapshot,
    quantity: row.quantity,
    unitPrice: row.price_at_time,
    effectiveUnitPrice,
    lineTotal: isVoid ? 0 : effectiveUnitPrice * row.quantity,
    course: row.course as Course,
    station: row.station,
    stationName: stationName(row.station),
    seat: row.seat,
    note: row.note,
    kdsStatus: row.kds_status as KdsStatus,
    urgency: urgency(row.kds_status as KdsStatus, row.course, minutesElapsed),
    isVoid,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    readyAt: row.ready_at,
    bumpedAt: row.bumped_at,
    minutesElapsed,
    modifiers: lineModifiers,
  };
}

function loadTenders(orderId: string): Tender[] {
  return all<{ id: string; method: string; amount: number; tip: number; label: string; auth_code: string | null; last4: string | null; status: string; created_at: string }>(
    "SELECT * FROM payments WHERE order_id = ? ORDER BY created_at",
    orderId,
  ).map((row) => ({
    id: row.id,
    method: row.method as Tender["method"],
    amount: row.amount,
    tip: row.tip,
    label: row.label,
    authCode: row.auth_code,
    last4: row.last4,
    status: row.status,
    createdAt: row.created_at,
  }));
}

function loadDiscounts(orderId: string): OrderSnapshot["discounts"] {
  return all<{ id: string; kind: string; value: number; amount: number; reason: string; approved_by: string | null; created_at: string; actor: string | null }>(
    `SELECT d.*, e.name AS actor FROM order_discounts d LEFT JOIN employees e ON e.id = d.approved_by
      WHERE d.order_id = ? ORDER BY d.created_at`,
    orderId,
  ).map((row) => ({
    id: row.id,
    kind: row.kind as "amount" | "percent",
    value: row.value,
    amount: row.amount,
    reason: row.reason,
    approvedBy: row.actor ?? "—",
    createdAt: row.created_at,
  }));
}

export function buildSnapshot(row: OrderRow): OrderSnapshot {
  const items = loadLines(row.id);
  const activeItems = items.filter((line) => !line.isVoid);
  const discountRows = loadDiscounts(row.id);
  const discountTotal = discountRows.reduce((total, entry) => total + entry.amount, 0);
  const settings = getSettings();
  const pricing = priceOrder(
    items.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      modifiers: line.modifiers.map((modifier) => ({ price: modifier.price })),
      isVoid: line.isVoid,
    })),
    discountTotal,
    { vatRate: settings.vatRate, vatInclusive: settings.vatInclusive, serviceChargeRate: settings.serviceChargeRate },
  );
  const tip = row.status === "closed" ? row.tip : loadTenders(row.id).reduce((total, tender) => total + tender.tip, 0);
  const statuses = activeItems.map((line) => line.kdsStatus);
  const oldest = activeItems
    .filter((line) => line.kdsStatus !== "READY")
    .reduce((max, line) => Math.max(max, line.minutesElapsed), 0);

  return {
    id: row.id,
    checkNumber: row.check_number,
    tableId: row.table_id,
    tableLabel: row.table_label ?? (row.channel === "takeout" ? "Takeout" : row.channel === "qr" ? "QR order" : "—"),
    terminalId: row.terminal_id,
    serverId: row.server_id,
    serverName: row.server_name ?? "—",
    status: row.status as OrderSnapshot["status"],
    channel: row.channel as OrderSnapshot["channel"],
    guests: row.guests,
    qrToken: row.qr_token,
    guestName: row.guest_name,
    note: row.note,
    businessDate: row.business_date,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    firedAt: row.fired_at,
    closedAt: row.closed_at,
    items,
    activeItems,
    subtotal: pricing.subtotal,
    discount: pricing.discount,
    taxable: pricing.taxable,
    vat: pricing.vat,
    serviceCharge: pricing.serviceCharge,
    tip,
    total: pricing.total,
    grandTotal: pricing.total + tip,
    itemCount: pricing.itemCount,
    allReady: activeItems.length > 0 && activeItems.every((line) => line.kdsStatus === "READY"),
    canBump: canBump(statuses),
    hasHold: activeItems.some((line) => line.kdsStatus === "HOLD"),
    minutesOpen: elapsedMinutes(row.created_at),
    oldestItemMinutes: oldest,
    tenders: loadTenders(row.id),
    discounts: discountRows,
  };
}

export function getOrder(orderId: string): OrderSnapshot | null {
  const row = get<OrderRow>(`${ORDER_SELECT} WHERE o.id = ?`, orderId);
  return row ? buildSnapshot(row) : null;
}

export function requireOrder(orderId: string): OrderSnapshot {
  const order = getOrder(orderId);
  if (!order) throw notFound("Ticket not found");
  return order;
}

/** Every ticket that is not yet closed, newest first. */
export function getActiveOrders(): OrderSnapshot[] {
  const rows = all<OrderRow>(`${ORDER_SELECT} WHERE o.status IN ('open','sent') ORDER BY o.created_at DESC`);
  return rows.map(buildSnapshot);
}

export function getClosedOrders(businessDate: string, limit = 100): OrderSnapshot[] {
  const rows = all<OrderRow>(
    `${ORDER_SELECT} WHERE o.status = 'closed' AND o.business_date = ? ORDER BY o.closed_at DESC LIMIT ?`,
    businessDate,
    limit,
  );
  return rows.map(buildSnapshot);
}

export interface CreateOrderInput {
  tableId?: string | null;
  guests?: number;
  channel?: string;
  serverId?: string | null;
  terminalId?: string | null;
  guestName?: string;
  note?: string;
  qrToken?: string | null;
}

export function createOrder(input: CreateOrderInput, actor?: SessionUser | null): OrderSnapshot {
  const channel = (ORDER_CHANNELS as readonly string[]).includes(input.channel ?? "") ? (input.channel as string) : "dine_in";
  const guests = Math.max(1, Math.round(Number(input.guests ?? 1)));
  const id = uuid();
  run(
    `INSERT INTO orders (id, check_number, table_id, terminal_id, server_id, status, channel, guests,
       qr_token, guest_name, note, business_date, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    nextCheckNumber(),
    input.tableId ?? null,
    input.terminalId ?? "term-pos-1",
    input.serverId ?? actor?.id ?? null,
    channel,
    guests,
    input.qrToken ?? null,
    input.guestName ?? "",
    input.note ?? "",
    businessDateNow(),
    nowStamp(),
  );
  return requireOrder(id);
}

export interface AddLineInput {
  menuItemId: string;
  quantity?: number;
  /** option ids from modifier groups */
  modifiers?: string[];
  note?: string;
  seat?: number;
}

export function addLine(orderId: string, input: AddLineInput, actor?: SessionUser | null): OrderSnapshot {
  const order = requireOrder(orderId);
  if (order.status === "closed") throw badRequest("That check is already closed");

  const item = get<{ id: string; name: string; price: number; course: string; station: string; category_id: string | null; is_available: number }>(
    "SELECT id, name, price, course, station, category_id, is_available FROM menu_items WHERE id = ?",
    input.menuItemId,
  );
  if (!item) throw notFound("Menu item not found");
  if (!item.is_available) throw badRequest(`${item.name} is 86'd — it is not available right now`);

  const quantity = Math.max(1, Math.round(Number(input.quantity ?? 1)));
  if (!Number.isFinite(quantity)) throw badRequest("Quantity must be a positive number");

  const resolved = validateModifierSelection(item.id, input.modifiers ?? []);
  // Category routing is snapshotted onto the new line. Later configuration
  // changes therefore cannot move food that is already on a station screen.
  const routedStation = getSettings().kdsRouting[item.category_id ?? ""] || item.station;
  const lineId = uuid();
  const stamp = nowStamp();

  tx(() => {
    run(
      `INSERT INTO order_items (id, order_id, menu_item_id, name_snapshot, quantity, price_at_time, course,
         station, seat, note, kds_status, is_void, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
      lineId,
      orderId,
      item.id,
      item.name,
      quantity,
      item.price, // price locked at time of sale
      item.course,
      routedStation,
      Math.max(0, Math.round(Number(input.seat ?? 0))),
      String(input.note ?? "").slice(0, 280),
      stamp,
      order.sentAt ?? null,
    );
    for (const modifier of resolved) {
      run(
        `INSERT INTO order_item_modifiers (id, order_item_id, modifier_id, group_name, name_snapshot, price_at_time)
         VALUES (?, ?, ?, ?, ?, ?)`,
        uuid(),
        lineId,
        modifier.id,
        modifier.groupName,
        modifier.name,
        modifier.price,
      );
    }
    // A line added to a ticket that is already on the pass routes immediately
    // (entrees wait for the next fire so the table still lands together).
    if (order.sentAt) {
      run("UPDATE order_items SET kds_status = ? WHERE id = ?", initialKdsStatus(item.course), lineId);
    }
  });
  void actor;
  return requireOrder(orderId);
}

export function updateLine(
  orderId: string,
  lineId: string,
  patch: { quantity?: number; note?: string; seat?: number; modifiers?: string[] },
): OrderSnapshot {
  const line = get<LineRow>("SELECT * FROM order_items WHERE id = ? AND order_id = ?", lineId, orderId);
  if (!line) throw notFound("Ticket line not found");
  if (line.is_void) throw badRequest("A voided line cannot be edited");
  const order = requireOrder(orderId);
  if (order.status === "closed") throw badRequest("That check is already closed");
  if (line.sent_at && patch.modifiers) throw badRequest("Modifiers are locked once the item has gone to the kitchen");

  const quantity = patch.quantity !== undefined ? Math.max(1, Math.round(Number(patch.quantity))) : line.quantity;
  tx(() => {
    run(
      "UPDATE order_items SET quantity = ?, note = ?, seat = ? WHERE id = ?",
      quantity,
      patch.note !== undefined ? String(patch.note).slice(0, 280) : line.note,
      patch.seat !== undefined ? Math.max(0, Math.round(Number(patch.seat))) : line.seat,
      lineId,
    );
    if (patch.modifiers && line.menu_item_id) {
      const resolved = validateModifierSelection(line.menu_item_id, patch.modifiers);
      run("DELETE FROM order_item_modifiers WHERE order_item_id = ?", lineId);
      for (const modifier of resolved) {
        run(
          `INSERT INTO order_item_modifiers (id, order_item_id, modifier_id, group_name, name_snapshot, price_at_time)
           VALUES (?, ?, ?, ?, ?, ?)`,
          uuid(),
          lineId,
          modifier.id,
          modifier.groupName,
          modifier.name,
          modifier.price,
        );
      }
    }
  });
  return requireOrder(orderId);
}

/**
 * Remove a line. Before the ticket reaches the kitchen the row is deleted;
 * after that it becomes an audited void so the kitchen is told to stop and the
 * Z-report can account for the lost sale.
 */
export function removeLine(orderId: string, lineId: string, reason: string, actor: SessionUser | null, approver: SessionUser | null = null): OrderSnapshot {
  const line = get<LineRow>("SELECT * FROM order_items WHERE id = ? AND order_id = ?", lineId, orderId);
  if (!line) throw notFound("Ticket line not found");
  const order = requireOrder(orderId);
  if (order.status === "closed") throw badRequest("That check is already closed");
  if (line.is_void) return order;

  if (!line.sent_at) {
    tx(() => {
      run("DELETE FROM order_item_modifiers WHERE order_item_id = ?", lineId);
      run("DELETE FROM order_items WHERE id = ?", lineId);
    });
    return requireOrder(orderId);
  }

  const amount = lineTotalOf(lineId);
  tx(() => {
    run("UPDATE order_items SET is_void = 1, void_reason = ?, kds_status = 'READY' WHERE id = ?", reason || "Removed by staff", lineId);
    run(
      `INSERT INTO voids (id, order_id, order_item_id, item_name, amount, reason, voided_by, created_at, business_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uuid(),
      orderId,
      lineId,
      line.name_snapshot,
      amount,
      reason || "Removed by staff",
      approver?.id ?? actor?.id ?? null,
      nowStamp(),
      order.businessDate ?? businessDateNow(),
    );
  });
  audit(
    actor,
    "pos.void",
    "order_item",
    lineId,
    `${line.name_snapshot} × ${line.quantity} — ${reason || "no reason given"}${approver ? ` · approved by ${approver.name}` : ""}`,
  );
  return requireOrder(orderId);
}

export function lineTotalOf(lineId: string): number {
  const line = get<LineRow>("SELECT * FROM order_items WHERE id = ?", lineId);
  if (!line || line.is_void) return 0;
  const modifierTotal = Number(
    get<{ total: number }>("SELECT COALESCE(SUM(price_at_time), 0) AS total FROM order_item_modifiers WHERE order_item_id = ?", lineId)?.total ?? 0,
  );
  return (line.price_at_time + modifierTotal) * line.quantity;
}

/** Send the ticket to the kitchen: appetizers/drinks release, entrees hold. */
export function sendToKitchen(orderId: string, actor: SessionUser | null): OrderSnapshot {
  const order = requireOrder(orderId);
  if (order.status !== "open") throw badRequest("Only an open ticket can be sent to the kitchen");
  if (!order.activeItems.length) throw badRequest("An empty ticket cannot be sent to the kitchen");

  const stamp = nowStamp();
  tx(() => {
    const changed = run("UPDATE orders SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'open'", stamp, orderId).changes;
    if (!changed) throw badRequest("That ticket has already been sent");
    for (const line of order.activeItems) {
      run(
        "UPDATE order_items SET kds_status = ?, sent_at = COALESCE(sent_at, ?) WHERE id = ? AND kds_status = 'PENDING' AND sent_at IS NULL",
        initialKdsStatus(line.course),
        stamp,
        line.id,
      );
    }
    // Any line added before the send but already stamped keeps its status.
    run("UPDATE order_items SET sent_at = COALESCE(sent_at, ?) WHERE order_id = ?", stamp, orderId);
  });
  audit(actor, "pos.send", "order", orderId, `${order.activeItems.length} line(s) to the kitchen`);
  return requireOrder(orderId);
}

/** Fire the held entrees so the whole table lands together. */
export function fireEntrees(orderId: string, actor: SessionUser | null): OrderSnapshot {
  const order = requireOrder(orderId);
  if (order.status !== "sent") throw badRequest("Send the ticket to the kitchen before firing");
  const held = order.activeItems.filter((line) => line.kdsStatus === "HOLD");
  if (!held.length) throw badRequest("Nothing is on hold for this ticket");
  tx(() => {
    run("UPDATE order_items SET kds_status = 'PENDING' WHERE order_id = ? AND kds_status = 'HOLD'", orderId);
    run("UPDATE orders SET fired_at = COALESCE(fired_at, ?) WHERE id = ?", nowStamp(), orderId);
  });
  audit(actor, "pos.fire", "order", orderId, `${held.length} entree line(s) fired`);
  return requireOrder(orderId);
}

export interface DiscountInput {
  kind: "amount" | "percent";
  /** paisa for an amount discount, whole percent for a percent discount */
  value: number;
  reason: string;
  lineId?: string | null;
}

export function applyDiscount(orderId: string, input: DiscountInput, actor: SessionUser | null, approver: SessionUser | null = null): OrderSnapshot {
  const order = requireOrder(orderId);
  if (order.status === "closed") throw badRequest("That check is already closed");
  const base = input.lineId ? lineTotalOf(input.lineId) : order.subtotal;
  const amount = resolveDiscount(base, input.kind, input.value);
  if (amount <= 0) throw badRequest("Discount must be greater than zero");
  const reason = String(input.reason ?? "").trim() || "Not specified";

  const id = uuid();
  run(
    `INSERT INTO order_discounts (id, order_id, order_item_id, kind, value, amount, reason, approved_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    orderId,
    input.lineId ?? null,
    input.kind,
    input.kind === "percent" ? Math.round(input.value * 100) : amount,
    amount,
    reason,
    approver?.id ?? actor?.id ?? null,
    nowStamp(),
  );
  audit(
    actor,
    "pos.discount",
    "order",
    orderId,
    `${input.kind} ${input.kind === "percent" ? `${input.value}%` : `${amount / 100}`} — ${reason}${approver ? ` · approved by ${approver.name}` : ""}`,
  );
  return requireOrder(orderId);
}

export function removeDiscount(orderId: string, discountId: string, actor: SessionUser | null): OrderSnapshot {
  const changed = run("DELETE FROM order_discounts WHERE id = ? AND order_id = ?", discountId, orderId).changes;
  if (!changed) throw notFound("Discount not found");
  audit(actor, "pos.discount.remove", "order", orderId, discountId);
  return requireOrder(orderId);
}

export function updateOrderMeta(
  orderId: string,
  patch: { guests?: number; note?: string; guestName?: string; channel?: string },
): OrderSnapshot {
  const row = get<OrderRow>(`${ORDER_SELECT} WHERE o.id = ?`, orderId);
  if (!row) throw notFound("Ticket not found");
  run(
    "UPDATE orders SET guests = ?, note = ?, guest_name = ?, channel = ? WHERE id = ?",
    patch.guests !== undefined ? Math.max(1, Math.round(Number(patch.guests))) : row.guests,
    patch.note !== undefined ? String(patch.note).slice(0, 280) : row.note,
    patch.guestName !== undefined ? String(patch.guestName).slice(0, 120) : row.guest_name,
    patch.channel && (ORDER_CHANNELS as readonly string[]).includes(patch.channel) ? patch.channel : row.channel,
    orderId,
  );
  return requireOrder(orderId);
}

/** Move a ticket to another table (both must allow it). */
export function transferOrder(orderId: string, toTableId: string, actor: SessionUser | null): OrderSnapshot {
  const order = requireOrder(orderId);
  if (order.status === "closed") throw badRequest("A closed check cannot be moved");
  const target = get<{ id: string; status: string; label: string }>("SELECT id, status, label FROM tables WHERE id = ?", toTableId);
  if (!target) throw notFound("Target table not found");
  if (target.status !== "available") throw badRequest(`Table ${target.label} is ${target.status}`);
  const source = order.tableId ? get<{ id: string; status: string }>("SELECT id, status FROM tables WHERE id = ?", order.tableId) : null;

  tx(() => {
    run("UPDATE orders SET table_id = ? WHERE id = ?", toTableId, orderId);
    if (source) run("UPDATE tables SET status = 'available', guests = 0, server_id = NULL, seated_at = NULL WHERE id = ?", source.id);
    run(
      "UPDATE tables SET status = ?, guests = ?, server_id = ?, seated_at = COALESCE(seated_at, ?) WHERE id = ?",
      order.status === "sent" ? "ordered" : "seated",
      order.guests,
      order.serverId,
      nowStamp(),
      toTableId,
    );
  });
  audit(actor, "floor.transfer", "order", orderId, `moved to table ${target.label}`);
  return requireOrder(orderId);
}
