/**
 * Host stand service — waitlist, reservations and guest alerts.
 *
 * Seating a waitlist party is a single transaction: the party is marked seated,
 * the table walks available -> seated, and a ticket is opened, so the floor plan
 * and the POS can never disagree about who is sitting where.
 */
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, notFound } from "@/server/router";
import { audit } from "@/server/audit";
import { requireTable, seatParty, suggestTable } from "@/server/floor";
import { createOrder } from "@/server/orders";
import { businessDateNow, elapsedMinutes, nowStamp, shiftDate, today, formatClock } from "@/domain/time";
import type { GuestAlert, Reservation, SessionUser, WaitlistParty } from "@/types";

interface WaitlistRow {
  id: string;
  guest_name: string;
  phone: string;
  party_size: number;
  status: string;
  quoted_minutes: number;
  notes: string;
  table_id: string | null;
  table_label: string | null;
  business_date: string | null;
  created_at: string;
  notified_at: string | null;
  seated_at: string | null;
}

const WAITLIST_SELECT = `
  SELECT w.*, t.label AS table_label FROM waitlist_parties w LEFT JOIN tables t ON t.id = w.table_id`;

export function getWaitlist(date?: string): WaitlistParty[] {
  const businessDate = date ?? businessDateNow();
  const rows = all<WaitlistRow>(
    `${WAITLIST_SELECT} WHERE w.business_date = ? ORDER BY
       CASE w.status WHEN 'notified' THEN 0 WHEN 'waiting' THEN 1 WHEN 'seated' THEN 2 ELSE 3 END,
       w.created_at`,
    businessDate,
  );
  let position = 0;
  return rows.map((row) => {
    if (row.status === "waiting") position += 1;
    return {
      id: row.id,
      guestName: row.guest_name,
      phone: row.phone,
      partySize: row.party_size,
      status: row.status as WaitlistParty["status"],
      quotedMinutes: row.quoted_minutes,
      notes: row.notes,
      tableId: row.table_id,
      tableLabel: row.table_label ?? "",
      createdAt: row.created_at,
      notifiedAt: row.notified_at,
      seatedAt: row.seated_at,
      waitedMinutes: elapsedMinutes(row.created_at),
      position: row.status === "waiting" ? position : 0,
    };
  });
}

export interface WaitlistInput {
  guestName: string;
  phone?: string;
  partySize: number;
  quotedMinutes?: number;
  notes?: string;
}

export function addToWaitlist(input: WaitlistInput, actor: SessionUser | null): WaitlistParty {
  const guestName = String(input.guestName ?? "").trim();
  if (!guestName) throw badRequest("Guest name is required");
  const partySize = Math.max(1, Math.round(Number(input.partySize ?? 2)));
  const id = uuid();
  run(
    `INSERT INTO waitlist_parties (id, guest_name, phone, party_size, status, quoted_minutes, notes, business_date, created_at)
     VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?)`,
    id,
    guestName,
    String(input.phone ?? "").trim(),
    partySize,
    Math.max(5, Math.round(Number(input.quotedMinutes ?? estimateWait(partySize)))),
    String(input.notes ?? "").slice(0, 280),
    businessDateNow(),
    nowStamp(),
  );
  audit(actor, "host.waitlist.add", "waitlist", id, `${guestName}, party of ${partySize}`);
  return getWaitlistParty(id)!;
}

/** Rough quote based on how many parties are already ahead in the queue. */
export function estimateWait(partySize: number): number {
  const ahead = Number(
    get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM waitlist_parties WHERE status IN ('waiting','notified') AND business_date = ?",
      businessDateNow(),
    )?.n ?? 0,
  );
  const seatsNeeded = partySize > 4 ? 18 : 12;
  return Math.min(90, 10 + ahead * seatsNeeded * 0.6);
}

export function getWaitlistParty(id: string): WaitlistParty | null {
  return getWaitlist().find((party) => party.id === id) ?? null;
}

/** Send the "your table is ready" SMS and move the party to notified. */
export function notifyParty(id: string, actor: SessionUser | null): { partyId: string; message: string } {
  const party = get<{ id: string; guest_name: string; party_size: number; status: string; phone: string }>(
    "SELECT * FROM waitlist_parties WHERE id = ?",
    id,
  );
  if (!party) throw notFound("Waitlist party not found");
  if (party.status !== "waiting" && party.status !== "notified") throw badRequest(`That party is already ${party.status}`);
  const settings = get<{ value: string }>("SELECT value FROM settings WHERE key = 'restaurant_name'");
  const message = `${settings?.value ?? "Terai Kitchen"}: your table for ${party.party_size} is ready. Please see the host stand within 10 minutes.`;
  tx(() => {
    run("UPDATE waitlist_parties SET status = 'notified', notified_at = ? WHERE id = ?", nowStamp(), id);
    run(
      "INSERT INTO guest_alerts (id, party_id, channel, message, status, created_at) VALUES (?, ?, 'sms', ?, 'sent', ?)",
      uuid(),
      id,
      message,
      nowStamp(),
    );
  });
  audit(actor, "host.waitlist.notify", "waitlist", id, party.phone ? `SMS to ${party.phone}` : "no phone on file");
  return { partyId: id, message };
}

/** Seat a waitlist party: party seated + table seated + ticket opened. */
export function seatFromWaitlist(id: string, tableId: string, actor: SessionUser | null): { tableLabel: string; orderId: string | null } {
  const party = get<{ id: string; guest_name: string; party_size: number; status: string }>(
    "SELECT * FROM waitlist_parties WHERE id = ?",
    id,
  );
  if (!party) throw notFound("Waitlist party not found");
  if (party.status === "seated") throw badRequest("That party is already seated");
  const table = requireTable(tableId);

  let orderId: string | null = null;
  tx(() => {
    const seated = seatParty(tableId, { guests: party.party_size, serverId: actor?.id ?? null, createOrder: false }, actor);
    run("UPDATE waitlist_parties SET status = 'seated', table_id = ?, seated_at = ? WHERE id = ?", tableId, nowStamp(), id);
    orderId = createOrder(
      { tableId, guests: party.party_size, channel: "dine_in", serverId: actor?.id ?? null, guestName: party.guest_name },
      actor,
    ).id;
    void seated;
  });
  audit(actor, "host.seat", "waitlist", id, `${party.guest_name} seated at ${table.label}`);
  return { tableLabel: table.label, orderId };
}

export function setWaitlistStatus(id: string, status: WaitlistParty["status"], actor: SessionUser | null): WaitlistParty {
  const allowed = ["waiting", "notified", "seated", "no_show", "cancelled"] as const;
  if (!(allowed as readonly string[]).includes(status)) throw badRequest("Unknown waitlist status");
  const changed = run("UPDATE waitlist_parties SET status = ? WHERE id = ?", status, id).changes;
  if (!changed) throw notFound("Waitlist party not found");
  audit(actor, "host.waitlist.status", "waitlist", id, status);
  return getWaitlistParty(id)!;
}

export function removeFromWaitlist(id: string): void {
  tx(() => {
    run("DELETE FROM guest_alerts WHERE party_id = ?", id);
    run("DELETE FROM waitlist_parties WHERE id = ?", id);
  });
}

// ------------------------------------------------------------------ reservations
interface ReservationRow {
  id: string;
  guest_name: string;
  phone: string;
  party_size: number;
  reservation_at: string;
  status: string;
  table_id: string | null;
  table_label: string | null;
  source: string;
  notes: string;
  created_at: string;
}

export function getReservations(from?: string, to?: string): Reservation[] {
  const start = from ?? today();
  const end = to ?? shiftDate(today(), 7);
  const rows = all<ReservationRow>(
    `SELECT r.*, t.label AS table_label FROM reservations r LEFT JOIN tables t ON t.id = r.table_id
      WHERE date(r.reservation_at) BETWEEN ? AND ? ORDER BY r.reservation_at`,
    start,
    end,
  );
  const now = nowStamp();
  return rows.map((row) => ({
    id: row.id,
    guestName: row.guest_name,
    phone: row.phone,
    partySize: row.party_size,
    reservationAt: row.reservation_at,
    status: row.status as Reservation["status"],
    tableId: row.table_id,
    tableLabel: row.table_label ?? "Unassigned",
    source: row.source,
    notes: row.notes,
    minutesUntil: Math.round((Date.parse(row.reservation_at.replace(" ", "T") + "Z") - Date.parse(now.replace(" ", "T") + "Z")) / 60000),
  }));
}

export interface ReservationInput {
  guestName: string;
  phone?: string;
  partySize: number;
  /** "YYYY-MM-DD HH:MM" or a full stamp */
  reservationAt: string;
  tableId?: string | null;
  source?: string;
  notes?: string;
}

export function createReservation(input: ReservationInput, actor: SessionUser | null): Reservation {
  const guestName = String(input.guestName ?? "").trim();
  if (!guestName) throw badRequest("Guest name is required");
  const when = normalizeWhen(input.reservationAt);
  const partySize = Math.max(1, Math.round(Number(input.partySize ?? 2)));
  const id = uuid();

  const clash = get<{ id: string; guest_name: string }>(
    `SELECT id, guest_name FROM reservations
      WHERE status = 'confirmed' AND table_id IS NOT NULL AND table_id = ?
        AND ABS(CAST((julianday(reservation_at) - julianday(?)) * 1440 AS INTEGER)) < 120`,
    input.tableId ?? "",
    when,
  );
  if (clash && input.tableId) throw badRequest(`That table is already booked near this time for ${clash.guest_name}`);

  run(
    `INSERT INTO reservations (id, guest_name, phone, party_size, reservation_at, status, table_id, source, notes, created_at)
     VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`,
    id,
    guestName,
    String(input.phone ?? "").trim(),
    partySize,
    when,
    input.tableId ?? suggestTable(partySize)?.id ?? null,
    input.source ?? "phone",
    String(input.notes ?? "").slice(0, 280),
    nowStamp(),
  );
  audit(actor, "host.reservation.add", "reservation", id, `${guestName}, party of ${partySize} at ${when}`);
  return getReservations(shiftDate(when.slice(0, 10), -1), shiftDate(when.slice(0, 10), 8)).find((row) => row.id === id)!;
}

export function updateReservation(id: string, patch: Partial<ReservationInput>, actor: SessionUser | null): Reservation {
  const row = get<ReservationRow>("SELECT * FROM reservations WHERE id = ?", id);
  if (!row) throw notFound("Reservation not found");
  run(
    `UPDATE reservations SET guest_name = ?, phone = ?, party_size = ?, reservation_at = ?, table_id = ?, source = ?, notes = ?
      WHERE id = ?`,
    patch.guestName ?? row.guest_name,
    patch.phone ?? row.phone,
    patch.partySize !== undefined ? Math.max(1, Math.round(Number(patch.partySize))) : row.party_size,
    patch.reservationAt ? normalizeWhen(patch.reservationAt) : row.reservation_at,
    patch.tableId !== undefined ? patch.tableId : row.table_id,
    patch.source ?? row.source,
    patch.notes ?? row.notes,
    id,
  );
  audit(actor, "host.reservation.update", "reservation", id, patch.guestName ?? row.guest_name);
  return getReservations(shiftDate(today(), -30), shiftDate(today(), 60)).find((entry) => entry.id === id)!;
}

export function setReservationStatus(id: string, status: Reservation["status"], tableId?: string | null, actor: SessionUser | null = null): Reservation {
  const row = get<ReservationRow>("SELECT * FROM reservations WHERE id = ?", id);
  if (!row) throw notFound("Reservation not found");
  tx(() => {
    run("UPDATE reservations SET status = ?, table_id = COALESCE(?, table_id) WHERE id = ?", status, tableId ?? null, id);
    if (status === "seated") {
      const target = tableId ?? row.table_id;
      if (target) {
        const table = requireTable(target);
        if (table.status === "available") {
          seatParty(target, { guests: row.party_size, serverId: actor?.id ?? null, createOrder: true }, actor);
        }
      }
    }
  });
  audit(actor, "host.reservation.status", "reservation", id, status);
  return getReservations(shiftDate(today(), -30), shiftDate(today(), 60)).find((entry) => entry.id === id)!;
}

function normalizeWhen(value: string): string {
  const trimmed = String(value ?? "").trim().replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed} 19:00:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(trimmed)) return `${trimmed}:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  throw badRequest("Reservation time must be YYYY-MM-DD HH:MM");
}

// ------------------------------------------------------------------------ alerts
export function getAlerts(limit = 30): GuestAlert[] {
  return all<{ id: string; party_id: string; channel: string; message: string; status: string; created_at: string }>(
    "SELECT * FROM guest_alerts ORDER BY created_at DESC LIMIT ?",
    limit,
  ).map((row) => ({
    id: row.id,
    partyId: row.party_id,
    channel: row.channel,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
  }));
}

/** Headline numbers for the host stand header. */
export function hostSummary() {
  const waitlist = getWaitlist();
  const waiting = waitlist.filter((party) => party.status === "waiting");
  const notified = waitlist.filter((party) => party.status === "notified");
  const reservations = getReservations(today(), today());
  const upcoming = reservations.filter((row) => row.status === "confirmed");
  const covers = waiting.reduce((total, party) => total + party.partySize, 0);
  return {
    waiting: waiting.length,
    notified: notified.length,
    coversWaiting: covers,
    averageWait: waiting.length ? Math.round(waiting.reduce((total, party) => total + party.waitedMinutes, 0) / waiting.length) : 0,
    longestWait: waiting.reduce((max, party) => Math.max(max, party.waitedMinutes), 0),
    reservationsToday: reservations.length,
    upcomingToday: upcoming.length,
    seatedToday: waitlist.filter((party) => party.status === "seated").length,
    noShows: reservations.filter((row) => row.status === "no_show").length + waitlist.filter((party) => party.status === "no_show").length,
    nextReservation: upcoming[0] ? `${formatClock(upcoming[0].reservationAt)} · ${upcoming[0].guestName}` : null,
    queue: waiting.slice(0, 6),
  };
}

export { suggestTable };
