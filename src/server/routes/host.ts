/**
 * Host stand routes — waitlist, reservations and SMS alerts.
 *
 * The host screen polls `host` every couple of seconds, so that one endpoint
 * returns the queue, the day's bookings and the headline numbers together
 * instead of making the client stitch three calls.
 */
import { route, created, badRequest } from "@/server/router";
import {
  addToWaitlist,
  createReservation,
  estimateWait,
  getAlerts,
  getReservations,
  getWaitlist,
  getWaitlistParty,
  hostSummary,
  notifyParty,
  removeFromWaitlist,
  seatFromWaitlist,
  setReservationStatus,
  setWaitlistStatus,
  updateReservation,
} from "@/server/hosting";
import { suggestTable } from "@/server/floor";
import { has, int, nullableStr, optStr, q, qInt, required, str } from "@/server/coerce";
import { shiftDate, today } from "@/domain/time";
import type { Reservation } from "@/types";

const WAITLIST_STATUSES = ["waiting", "notified", "seated", "no_show", "cancelled"] as const;
const RESERVATION_STATUSES = ["confirmed", "seated", "cancelled", "no_show"] as const;

route("GET", "host", "host.waitlist", ({ query }) => {
  const date = q(query, "date", today());
  return {
    date,
    summary: hostSummary(),
    waitlist: getWaitlist(date),
    reservations: getReservations(q(query, "from", date), q(query, "to", shiftDate(date, 7))),
    alerts: getAlerts(qInt(query, "alerts", 12)),
    suggestedTable: qInt(query, "party", 0) > 0 ? suggestTable(qInt(query, "party", 2)) : null,
  };
});

// -------------------------------------------------------------------- waitlist
route("POST", "host/waitlist", "host.waitlist", ({ body, user }) =>
  created(
    addToWaitlist(
      {
        guestName: required(body, "guestName", "Guest name"),
        phone: optStr(body, "phone"),
        partySize: int(body, "partySize", 2),
        quotedMinutes: has(body, "quotedMinutes") ? int(body, "quotedMinutes") : undefined,
        notes: optStr(body, "notes"),
      },
      user,
    ),
  ),
);

/** What the quote would be right now, so the host can answer before committing. */
route("GET", "host/waitlist/estimate", "host.waitlist", ({ query }) => ({
  partySize: qInt(query, "party", 2),
  quotedMinutes: estimateWait(qInt(query, "party", 2)),
}));

route("POST", "host/waitlist/:id/notify", "host.waitlist", ({ params, user }) => notifyParty(params.id, user));

route("POST", "host/waitlist/:id/seat", "host.seat", ({ params, body, user }) =>
  seatFromWaitlist(params.id, required(body, "tableId", "A table"), user),
);

route("PATCH", "host/waitlist/:id", "host.waitlist", ({ params, body, user }) => {
  const status = str(body, "status") as (typeof WAITLIST_STATUSES)[number];
  if (!status) throw badRequest("A status is required");
  if (!WAITLIST_STATUSES.includes(status)) throw badRequest(`"${status}" is not a valid waitlist status`);
  return { party: setWaitlistStatus(params.id, status, user) };
});

route("GET", "host/waitlist/:id", "host.waitlist", ({ params }) => {
  const party = getWaitlistParty(params.id);
  if (!party) throw badRequest("Waitlist party not found");
  return { party };
});

route("DELETE", "host/waitlist/:id", "host.waitlist", ({ params }) => {
  removeFromWaitlist(params.id);
  return { ok: true };
});

// ----------------------------------------------------------------- reservations
route("GET", "host/reservations", "host.waitlist", ({ query }) => ({
  reservations: getReservations(q(query, "from", today()), q(query, "to", shiftDate(today(), 7))),
}));

route("POST", "host/reservations", "host.waitlist", ({ body, user }) =>
  created(
    createReservation(
      {
        guestName: required(body, "guestName", "Guest name"),
        phone: optStr(body, "phone"),
        partySize: int(body, "partySize", 2),
        reservationAt: required(body, "reservationAt", "Reservation time"),
        tableId: nullableStr(body, "tableId"),
        source: optStr(body, "source"),
        notes: optStr(body, "notes"),
      },
      user,
    ),
  ),
);

route("PATCH", "host/reservations/:id", "host.waitlist", ({ params, body, user }) => ({
  reservation: updateReservation(
    params.id,
    {
      guestName: optStr(body, "guestName"),
      phone: optStr(body, "phone"),
      partySize: has(body, "partySize") ? int(body, "partySize") : undefined,
      reservationAt: optStr(body, "reservationAt"),
      tableId: nullableStr(body, "tableId"),
      source: optStr(body, "source"),
      notes: optStr(body, "notes"),
    },
    user,
  ),
}));

/** Confirm / seat / cancel / mark no-show — seating also opens the ticket. */
route("POST", "host/reservations/:id/status", "host.waitlist", ({ params, body, user }) => {
  const status = str(body, "status") as Reservation["status"];
  if (!RESERVATION_STATUSES.includes(status)) throw badRequest(`"${status}" is not a valid reservation status`);
  return { reservation: setReservationStatus(params.id, status, nullableStr(body, "tableId") ?? undefined, user) };
});

route("GET", "host/alerts", "host.waitlist", ({ query }) => ({ alerts: getAlerts(qInt(query, "limit", 30)) }));
