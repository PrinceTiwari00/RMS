/**
 * Kitchen service — station queues, the expo master view and prep sheets.
 *
 * A station screen shows only the lines routed to it, oldest first, with an
 * elapsed-time urgency so a cook can read the pass at a glance. Expo sees whole
 * tickets across every station and can only bump once all lines are READY.
 */
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, notFound } from "@/server/router";
import { audit } from "@/server/audit";
import { getStations, stationName } from "@/server/settings";
import { getOrder, requireOrder } from "@/server/orders";
import { DEFAULT_STATIONS, stationMeta, urgency } from "@/domain/kds";
import { elapsedMinutes, nowStamp } from "@/domain/time";
import { emitEvent } from "@/server/events";
import type { ExpoStationBreakdown, ExpoTicket, KdsMetrics, KdsStationView, KdsTicket, PrepSheet, SessionUser } from "@/types";
import type { OrderSnapshot } from "@/types";

function ticketFrom(order: OrderSnapshot, lines = order.activeItems, bumped = false): KdsTicket {
  const minutesElapsed = order.sentAt ? elapsedMinutes(order.sentAt) : order.minutesOpen;
  const worst = lines.reduce<KdsTicket["urgency"]>((current, line) => {
    const rank = { hold: 0, ready: 0, ok: 1, warn: 2, late: 3 } as const;
    return rank[line.urgency] > rank[current] ? line.urgency : current;
  }, "ok");
  return {
    orderId: order.id,
    checkNumber: order.checkNumber,
    tableLabel: order.tableLabel,
    tableId: order.tableId,
    guests: order.guests,
    serverName: order.serverName,
    channel: order.channel,
    note: order.note,
    sentAt: order.sentAt,
    firedAt: order.firedAt,
    minutesElapsed,
    urgency: lines.length && lines.every((line) => line.kdsStatus === "READY") ? "ready" : worst,
    lines,
    allReady: lines.length > 0 && lines.every((line) => line.kdsStatus === "READY"),
    bumped,
  };
}

function liveSentOrders(): OrderSnapshot[] {
  return all<{ id: string }>("SELECT id FROM orders WHERE status = 'sent' ORDER BY sent_at, created_at")
    .map((row) => getOrder(row.id))
    .filter((order): order is OrderSnapshot => order !== null);
}

function isBumped(orderId: string): boolean {
  return Boolean(get<{ n: number }>("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ? AND bumped_at IS NOT NULL", orderId)?.n);
}

/** One station's queue: only lines routed to it, oldest ticket first. */
export function getStationView(stationId: string): KdsStationView {
  const station = getStations().find((entry) => entry.id === stationId) ?? stationMeta(stationId);
  const orders = liveSentOrders();
  const tickets: KdsTicket[] = [];

  for (const order of orders) {
    const lines = order.activeItems.filter((line) => line.station === stationId);
    if (!lines.length) continue;
    tickets.push(ticketFrom(order, lines, isBumped(order.id)));
  }

  // Un-ready work first, then oldest-first inside each bucket.
  tickets.sort((a, b) => {
    if (a.allReady !== b.allReady) return a.allReady ? 1 : -1;
    return b.minutesElapsed - a.minutesElapsed;
  });

  const working = tickets.flatMap((ticket) => ticket.lines);
  return {
    station,
    tickets,
    pendingCount: working.filter((line) => line.kdsStatus === "PENDING").length,
    holdCount: working.filter((line) => line.kdsStatus === "HOLD").length,
    readyCount: working.filter((line) => line.kdsStatus === "READY").length,
    oldestMinutes: working.filter((line) => line.kdsStatus === "PENDING").reduce((max, line) => Math.max(max, line.minutesElapsed), 0),
    itemCount: working.length,
  };
}

/** Multi-column KDS board: every station lane side-by-side in one payload. */
export function getAllStationsBoard(): { stations: KdsStationView[]; metrics: KdsMetrics } {
  const configured = getStations().length ? getStations() : DEFAULT_STATIONS.map((station) => ({ ...station }));
  const views = configured.map((station) => getStationView(station.id));
  return { stations: views, metrics: metrics() };
}

/** The expeditor's master screen: whole tickets with per-station completion. */
export function getExpoView(): { tickets: ExpoTicket[]; stations: KdsMetrics["byStation"] } {
  const orders = liveSentOrders();
  const tickets: ExpoTicket[] = orders.map((order) => {
    const lines = order.activeItems;
    const breakdown: ExpoStationBreakdown[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      if (seen.has(line.station)) continue;
      seen.add(line.station);
      const stationLines = lines.filter((entry) => entry.station === line.station);
      const ready = stationLines.filter((entry) => entry.kdsStatus === "READY").length;
      const meta = stationMeta(line.station);
      breakdown.push({
        station: line.station,
        name: meta.name,
        color: meta.color,
        ready,
        total: stationLines.length,
        complete: ready === stationLines.length,
      });
    }
    const base = ticketFrom(order, lines, isBumped(order.id));
    return {
      ...base,
      stationBreakdown: breakdown,
      canBump: order.canBump && !base.bumped,
      seats: [...new Set(lines.map((line) => line.seat).filter((seat) => seat > 0))].sort((a, b) => a - b),
    };
  });

  tickets.sort((a, b) => {
    if (a.canBump !== b.canBump) return a.canBump ? -1 : 1;
    return b.minutesElapsed - a.minutesElapsed;
  });

  return { tickets, stations: metrics().byStation };
}

/** Cross-station load, used by the KDS header strip and the exec dashboard. */
export function metrics(): KdsMetrics {
  const orders = liveSentOrders();
  const stations = getStations().length ? getStations() : DEFAULT_STATIONS.map((station) => ({ ...station }));
  const byStation = stations.map((station) => {
    let pending = 0;
    let hold = 0;
    let ready = 0;
    let oldestMinutes = 0;
    for (const order of orders) {
      for (const line of order.activeItems) {
        if (line.station !== station.id) continue;
        if (line.kdsStatus === "HOLD") hold += 1;
        else if (line.kdsStatus === "READY") ready += 1;
        else {
          pending += 1;
          oldestMinutes = Math.max(oldestMinutes, line.minutesElapsed);
        }
      }
    }
    return { station, pending, hold, ready, oldestMinutes };
  });

  const ticketMinutes = orders.map((order) => (order.sentAt ? elapsedMinutes(order.sentAt) : 0));
  return {
    byStation,
    activeTickets: orders.length,
    lateTickets: orders.filter((order) => order.activeItems.some((line) => line.urgency === "late")).length,
    readyToBump: orders.filter((order) => order.canBump && !isBumped(order.id)).length,
    averageTicketMinutes: ticketMinutes.length ? Math.round(ticketMinutes.reduce((a, b) => a + b, 0) / ticketMinutes.length) : 0,
  };
}

// ------------------------------------------------------------------- line taps
export function markReady(lineId: string, actor: SessionUser | null): { lineId: string; orderId: string; allReady: boolean } {
  const line = get<{ id: string; order_id: string; kds_status: string; name_snapshot: string }>(
    "SELECT id, order_id, kds_status, name_snapshot FROM order_items WHERE id = ?",
    lineId,
  );
  if (!line) throw notFound("Kitchen line not found");
  if (line.kds_status === "READY") return { lineId, orderId: line.order_id, allReady: orderAllReady(line.order_id) };
  if (line.kds_status === "HOLD") throw badRequest(`${line.name_snapshot} is on hold — fire the ticket first`);

  const changed = run("UPDATE order_items SET kds_status = 'READY', ready_at = ? WHERE id = ? AND kds_status = 'PENDING'", nowStamp(), lineId).changes;
  if (!changed) throw badRequest("That item is no longer pending");
  const ord = get<{ table_id: string | null }>("SELECT table_id FROM orders WHERE id = ?", line.order_id);
  emitEvent("kds.updated", { orderId: line.order_id, tableId: ord?.table_id ?? null });
  return { lineId, orderId: line.order_id, allReady: orderAllReady(line.order_id) };
}

/** Undo a mis-tap before expo bumps the ticket. */
export function markUnready(lineId: string, actor: SessionUser | null): { lineId: string; orderId: string } {
  const line = get<{ id: string; order_id: string; kds_status: string; bumped_at: string | null }>(
    "SELECT id, order_id, kds_status, bumped_at FROM order_items WHERE id = ?",
    lineId,
  );
  if (!line) throw notFound("Kitchen line not found");
  if (line.bumped_at) throw badRequest("That ticket has already been bumped");
  run("UPDATE order_items SET kds_status = 'PENDING', ready_at = NULL WHERE id = ? AND kds_status = 'READY'", lineId);
  void actor;
  const ord = get<{ table_id: string | null }>("SELECT table_id FROM orders WHERE id = ?", line.order_id);
  emitEvent("kds.updated", { orderId: line.order_id, tableId: ord?.table_id ?? null });
  return { lineId, orderId: line.order_id };
}

function orderAllReady(orderId: string): boolean {
  const rows = all<{ kds_status: string; is_void: number }>(
    "SELECT kds_status, is_void FROM order_items WHERE order_id = ? AND is_void = 0",
    orderId,
  );
  return rows.length > 0 && rows.every((row) => row.kds_status === "READY");
}

/** Expo bumps an assembled ticket: it leaves the pass and clears every screen. */
export function bumpTicket(orderId: string, actor: SessionUser | null): { orderId: string; bumped: number } {
  const order = requireOrder(orderId);
  if (order.status !== "sent") throw badRequest("Only a ticket on the pass can be bumped");
  const outstanding = order.activeItems.filter((line) => line.kdsStatus !== "READY");
  if (outstanding.length) {
    throw badRequest(`${outstanding.length} item(s) are not ready yet: ${outstanding.map((line) => line.name).join(", ")}`);
  }
  const stamp = nowStamp();
  const bumped = run("UPDATE order_items SET bumped_at = ? WHERE order_id = ? AND bumped_at IS NULL", stamp, orderId).changes;
  audit(actor, "kds.bump", "order", orderId, `ticket ${order.checkNumber ?? ""} bumped at expo`);
  emitEvent("kds.updated", { orderId, tableId: order.tableId });
  return { orderId, bumped };
}

/** Recall a bumped ticket (runner brought it back). */
export function recallTicket(orderId: string, actor: SessionUser | null): { orderId: string } {
  const order = requireOrder(orderId);
  if (order.status !== "sent") throw badRequest("Only a live ticket can be recalled");
  run("UPDATE order_items SET bumped_at = NULL WHERE order_id = ?", orderId);
  audit(actor, "kds.recall", "order", orderId, `ticket ${order.checkNumber ?? ""} recalled`);
  emitEvent("kds.updated", { orderId, tableId: order.tableId });
  return { orderId };
}

/** Everything currently on the pass, flattened — used by the customer display. */
export function liveLinesForStation(stationId: string) {
  return getStationView(stationId).tickets.flatMap((ticket) =>
    ticket.lines.map((line) => ({ ...line, tableLabel: ticket.tableLabel, checkNumber: ticket.checkNumber })),
  );
}

// ------------------------------------------------------------------ prep sheets
export function getPrepSheets(): (PrepSheet & { price: number; course: string; categoryName: string })[] {
  const rows = all<{
    id: string;
    menu_item_id: string;
    station: string;
    allergens: string;
    plating: string;
    steps: string;
    updated_at: string;
    item_name: string;
    emoji: string;
    price: number;
    course: string;
    category_name: string | null;
  }>(
    `SELECT ps.*, mi.name AS item_name, mi.emoji, mi.price, mi.course, c.name AS category_name
       FROM prep_sheets ps JOIN menu_items mi ON mi.id = ps.menu_item_id
       LEFT JOIN categories c ON c.id = mi.category_id
      ORDER BY mi.name`,
  );
  return rows.map((row) => ({
    id: row.id,
    menuItemId: row.menu_item_id,
    itemName: row.item_name,
    emoji: row.emoji,
    station: row.station,
    allergens: row.allergens,
    plating: row.plating,
    steps: parseSteps(row.steps),
    updatedAt: row.updated_at,
    price: row.price,
    course: row.course,
    categoryName: row.category_name ?? "Uncategorised",
  }));
}

export function getPrepSheetForItem(menuItemId: string): PrepSheet | null {
  const row = get<{ id: string; menu_item_id: string; station: string; allergens: string; plating: string; steps: string; updated_at: string; item_name: string; emoji: string }>(
    `SELECT ps.*, mi.name AS item_name, mi.emoji FROM prep_sheets ps JOIN menu_items mi ON mi.id = ps.menu_item_id
      WHERE ps.menu_item_id = ?`,
    menuItemId,
  );
  if (!row) return null;
  return {
    id: row.id,
    menuItemId: row.menu_item_id,
    itemName: row.item_name,
    emoji: row.emoji,
    station: row.station,
    allergens: row.allergens,
    plating: row.plating,
    steps: parseSteps(row.steps),
    updatedAt: row.updated_at,
  };
}

export function savePrepSheet(
  menuItemId: string,
  input: { station?: string; allergens?: string; plating?: string; steps?: { text: string; seconds?: number }[] },
): PrepSheet {
  const item = get<{ id: string; name: string; station: string }>("SELECT id, name, station FROM menu_items WHERE id = ?", menuItemId);
  if (!item) throw notFound("Menu item not found");
  const steps = (input.steps ?? []).filter((step) => String(step.text ?? "").trim()).map((step) => ({
    text: String(step.text).trim(),
    seconds: step.seconds ? Math.max(0, Math.round(Number(step.seconds))) : undefined,
  }));
  const existing = get<{ id: string }>("SELECT id FROM prep_sheets WHERE menu_item_id = ?", menuItemId);
  tx(() => {
    if (existing) {
      run(
        "UPDATE prep_sheets SET station = ?, allergens = ?, plating = ?, steps = ?, updated_at = ? WHERE id = ?",
        input.station ?? item.station,
        input.allergens ?? "",
        input.plating ?? "",
        JSON.stringify(steps),
        nowStamp(),
        existing.id,
      );
    } else {
      run(
        `INSERT INTO prep_sheets (id, menu_item_id, station, allergens, plating, steps, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        uuid(),
        menuItemId,
        input.station ?? item.station,
        input.allergens ?? "",
        input.plating ?? "",
        JSON.stringify(steps),
        nowStamp(),
      );
    }
  });
  return getPrepSheetForItem(menuItemId)!;
}

/** Menu items with no prep sheet yet — the gap list on the prep viewer. */
export function itemsMissingPrepSheets(): { id: string; name: string; emoji: string; station: string }[] {
  return all<{ id: string; name: string; emoji: string; station: string }>(
    `SELECT mi.id, mi.name, mi.emoji, mi.station FROM menu_items mi
      LEFT JOIN prep_sheets ps ON ps.menu_item_id = mi.id
      WHERE ps.id IS NULL ORDER BY mi.name`,
  );
}

function parseSteps(raw: string): { text: string; seconds?: number }[] {
  try {
    const parsed = JSON.parse(raw) as { text: string; seconds?: number }[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export { urgency, stationName };
