/**
 * Floor plan routes — the live room view and the interactive layout builder.
 *
 * Reads are open to any signed-in employee. Seating and status changes need
 * `host.seat`; editing the room's geometry needs `admin.floorplan`, because a
 * careless drag can hide a table from the floor for the rest of the night.
 */
import { route, created, badRequest } from "@/server/router";
import {
  cleanTable,
  createSection,
  createTable,
  deleteSection,
  deleteTable,
  floorStats,
  getSections,
  getServers,
  getTable,
  getTables,
  releaseTable,
  saveLayout,
  seatParty,
  setTableStatus,
  suggestTable,
  updateSection,
  updateTableLayout,
} from "@/server/floor";
import { bool, has, int, num, nullableStr, optStr, q, qInt, str } from "@/server/coerce";
import { ALLOWED_TRANSITIONS, TABLE_STATUSES, type TableStatus } from "@/domain/tables";
import { acknowledgeServiceRequest, getActiveServiceRequests, resolveServiceRequest } from "@/server/engagement";
import { getActiveOrders } from "@/server/orders";

route("GET", "floor", null, ({ query }) => {
  const section = q(query, "section");
  const tables = getTables();
  const pendingQrOrders = getActiveOrders().filter((order) => order.approvalStatus === "pending_staff");
  return {
    sections: getSections(),
    tables: section ? tables.filter((table) => table.sectionId === section || table.sectionName === section) : tables,
    stats: floorStats(),
    servers: getServers(),
    transitions: ALLOWED_TRANSITIONS,
    statuses: TABLE_STATUSES,
    serviceRequests: getActiveServiceRequests(),
    pendingQrOrders,
  };
});

route("POST", "floor/requests/:id/acknowledge", "host.seat", ({ params, user }) => ({
  request: acknowledgeServiceRequest(params.id, user),
}));

route("POST", "floor/requests/:id/resolve", "host.seat", ({ params, user }) => ({
  request: resolveServiceRequest(params.id, user),
}));

route("GET", "floor/tables/:id", null, ({ params }) => {
  const table = getTable(params.id);
  if (!table) throw badRequest("Table not found");
  return { table };
});

/** Best available table for a party size — used by the host stand queue. */
route("GET", "floor/suggest", "host.seat", ({ query }) => ({
  table: suggestTable(qInt(query, "party", 2)),
}));

route("POST", "floor/tables/:id/seat", "host.seat", ({ params, body, user }) =>
  seatParty(
    params.id,
    {
      guests: int(body, "guests", 2),
      serverId: nullableStr(body, "serverId") ?? user.id,
      createOrder: bool(body, "createOrder", true),
    },
    user,
  ),
);

/** Walk a table through its state machine (seated -> ordered -> billed -> dirty). */
route("POST", "floor/tables/:id/status", "host.seat", ({ params, body, user }) => {
  const to = str(body, "status") as TableStatus;
  if (!TABLE_STATUSES.includes(to)) throw badRequest(`"${to}" is not a valid table status`);
  return { table: setTableStatus(params.id, to, user) };
});

route("POST", "floor/tables/:id/clean", "host.seat", ({ params, user }) => ({ table: cleanTable(params.id, user) }));

route("POST", "floor/tables/:id/release", "host.seat", ({ params, user }) => ({ table: releaseTable(params.id, user) }));

// ---------------------------------------------------------------- layout editor
route("POST", "floor/sections", "admin.floorplan", ({ body, user }) =>
  created(createSection({ name: str(body, "name"), color: optStr(body, "color") }, user)),
);

route("PATCH", "floor/sections/:id", "admin.floorplan", ({ params, body, user }) => ({
  section: updateSection(params.id, { name: optStr(body, "name"), color: optStr(body, "color") }, user),
}));

route("DELETE", "floor/sections/:id", "admin.floorplan", ({ params, user }) => {
  deleteSection(params.id, user);
  return { ok: true };
});

route("POST", "floor/tables", "admin.floorplan", ({ body }) =>
  created(
    createTable({
      label: str(body, "label"),
      sectionId: nullableStr(body, "sectionId"),
      capacity: int(body, "capacity", 4),
      shape: optStr(body, "shape"),
      x: num(body, "x", 0),
      y: num(body, "y", 0),
      w: num(body, "w", 90),
      h: num(body, "h", 90),
      rotation: num(body, "rotation", 0),
    }),
  ),
);

route("PATCH", "floor/tables/:id", "admin.floorplan", ({ params, body }) => ({
  table: updateTableLayout(params.id, {
    label: optStr(body, "label"),
    sectionId: nullableStr(body, "sectionId"),
    capacity: has(body, "capacity") ? int(body, "capacity") : undefined,
    shape: optStr(body, "shape"),
    x: has(body, "x") ? num(body, "x") : undefined,
    y: has(body, "y") ? num(body, "y") : undefined,
    w: has(body, "w") ? num(body, "w") : undefined,
    h: has(body, "h") ? num(body, "h") : undefined,
    rotation: has(body, "rotation") ? num(body, "rotation") : undefined,
  }),
}));

route("DELETE", "floor/tables/:id", "admin.floorplan", ({ params }) => {
  deleteTable(params.id);
  return { ok: true };
});

/** Bulk save from the drag-and-drop canvas: positions, sizes, rotations, groups. */
route("PUT", "floor/layout", "admin.floorplan", ({ body }) => {
  if (!Array.isArray(body.tables)) throw badRequest("Send the layout as { tables: [...] }");
  const tables = (body.tables as Record<string, unknown>[]).map((entry) => ({
    id: String(entry.id ?? ""),
    label: entry.label === undefined ? undefined : String(entry.label),
    shape: entry.shape === undefined ? undefined : String(entry.shape),
    capacity: entry.capacity === undefined ? undefined : Number(entry.capacity),
    sectionId: entry.sectionId === undefined || entry.sectionId === "" ? null : (entry.sectionId as string | null),
    x: Number(entry.x ?? 0),
    y: Number(entry.y ?? 0),
    w: Number(entry.w ?? 90),
    h: Number(entry.h ?? 90),
    rotation: Number(entry.rotation ?? 0),
  }));
  saveLayout(tables);
  return { sections: getSections(), tables: getTables(), stats: floorStats() };
});
