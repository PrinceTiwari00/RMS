/**
 * Kitchen display and prep-sheet routes.
 *
 * The BOH screens poll these every couple of seconds, so the reads are kept
 * deliberately narrow: a station only ever asks for its own lines, and expo asks
 * for the assembled view. Line taps need `kds.ready`; bumping needs `kds.bump`.
 */
import { route, badRequest } from "@/server/router";
import {
  bumpTicket,
  getExpoView,
  getPrepSheetForItem,
  getPrepSheets,
  getStationView,
  itemsMissingPrepSheets,
  markReady,
  markUnready,
  metrics,
  recallTicket,
  savePrepSheet,
} from "@/server/kitchen";
import { getStations } from "@/server/settings";
import { arr, oneOf, optStr, q, qInt } from "@/server/coerce";
import { COURSES, KDS_STATUSES, urgency } from "@/domain/kds";

route("GET", "kds/stations", null, () => ({ stations: getStations() }));

/** Board-wide counters. Registered before `kds/:station` so the literal wins. */
route("GET", "kds/metrics", "kds.view", () => metrics());

/** Colour band for a given elapsed time — used by the timer legends. */
route("GET", "kds/urgency", "kds.view", ({ query }) => {
  const status = oneOf(q(query, "status", "PENDING"), KDS_STATUSES, "PENDING");
  const course = oneOf(q(query, "course", "entree"), COURSES, "entree");
  const minutes = qInt(query, "minutes", 0);
  return { status, course, minutes, urgency: urgency(status, course, minutes) };
});

/** One station's live board. */
route("GET", "kds/:station", "kds.view", ({ params, query }) => {
  const view = getStationView(params.station);
  if (!view) throw badRequest(`Unknown station "${params.station}"`);
  return {
    ...view,
    metrics: metrics(),
    // Let the screen render immediately without waiting for the first poll.
    serverTime: q(query, "t") || new Date().toISOString(),
  };
});

route("GET", "kds-expo/board", "kds.view", () => {
  const view = getExpoView();
  return { ...view, metrics: metrics() };
});

/** Single-tap item completion at a station. */
route("POST", "kds/lines/:lineId/ready", "kds.ready", ({ params, user }) => markReady(params.lineId, user));

/** Undo a mistap — allowed until the ticket is bumped. */
route("POST", "kds/lines/:lineId/unready", "kds.ready", ({ params, user }) => markUnready(params.lineId, user));

/** Mark every line ready on a ticket (station-level "all done"). */
route("POST", "kds/orders/:orderId/ready-all", "kds.ready", ({ params, user }) => {
  const view = getExpoView();
  const ticket = view.tickets.find((entry) => entry.orderId === params.orderId);
  if (!ticket) throw badRequest("Ticket not found on the board");
  const results = ticket.lines
    .filter((line) => line.kdsStatus !== "READY")
    .map((line) => markReady(line.id, user));
  return { marked: results.length, allReady: results.every((result) => result.allReady) };
});

route("POST", "kds/orders/:orderId/bump", "kds.bump", ({ params, user }) => bumpTicket(params.orderId, user));

route("POST", "kds/orders/:orderId/recall", "kds.bump", ({ params, user }) => recallTicket(params.orderId, user));

// ------------------------------------------------------------------ prep sheets
route("GET", "prep", "kds.prep", ({ query }) => ({
  sheets: getPrepSheets(),
  station: q(query, "station"),
  missing: itemsMissingPrepSheets(),
}));

route("GET", "prep/:menuItemId", "kds.prep", ({ params }) => {
  const sheet = getPrepSheetForItem(params.menuItemId);
  if (!sheet) throw badRequest("No prep sheet for that item yet");
  return { sheet };
});

route("POST", "prep/:menuItemId", "admin.menu", ({ params, body }) =>
  savePrepSheet(params.menuItemId, {
    station: optStr(body, "station"),
    allergens: optStr(body, "allergens"),
    plating: optStr(body, "plating"),
    steps: arr(body, "steps").map((entry) => {
      const step = entry as Record<string, unknown>;
      return {
        text: String(step.text ?? ""),
        seconds: step.seconds === undefined ? undefined : Number(step.seconds),
      };
    }),
  }),
);

