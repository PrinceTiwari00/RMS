/**
 * Labour routes — the shift scheduler, availability, swaps and the time clock.
 *
 * Building the rota needs `admin.schedule`; editing somebody's punches needs
 * `admin.timeclock`, because that is a payroll-affecting act and every override
 * stores the editor and the reason on the row.
 */
import { route, created, badRequest } from "@/server/router";
import {
  approveOvertime,
  clockInByEmployee,
  clockOutByEmployee,
  closeTimeEntry,
  copyPreviousWeek,
  coverageForDate,
  createShift,
  decideSwap,
  deleteShift,
  editTimeEntry,
  getAvailability,
  getClockedIn,
  getSchedule,
  getShift,
  getSwaps,
  getTimeEntries,
  laborSummary,
  logBreak,
  moveShift,
  publishWeek,
  requestSwap,
  setAvailability,
  updateShift,
} from "@/server/labor";
import { getStaff } from "@/server/staff";
import { getSettings } from "@/server/settings";
import { bool, has, int, nullableStr, oneOf, optStr, q, qBool, qInt, required, str } from "@/server/coerce";
import { businessDateNow, shiftDate, startOfWeek, today, weekDates } from "@/domain/time";
import { LABOR_TARGET } from "@/domain/labor";

const SWAP_DECISIONS = ["approved", "denied"] as const;

// -------------------------------------------------------------------- schedule
route("GET", "schedule", "admin.schedule", ({ query }) => {
  const weekStart = q(query, "week", startOfWeek(today()));
  const settings = getSettings();
  return {
    ...getSchedule(weekStart),
    staff: getStaff(),
    swaps: getSwaps({ status: q(query, "swaps", "all") }),
    availability: getAvailability(),
    target: { min: settings.laborTargetMin, max: settings.laborTargetMax },
    fallbackTarget: LABOR_TARGET,
    coverage: weekDates(weekStart).map((date) => coverageForDate(date)),
  };
});

route("POST", "schedule/shifts", "admin.schedule", ({ body, user }) =>
  created(
    createShift(
      {
        employeeId: required(body, "employeeId", "An employee"),
        date: optStr(body, "date"),
        starts: optStr(body, "starts"),
        ends: optStr(body, "ends"),
        breakMinutes: has(body, "breakMinutes") ? int(body, "breakMinutes") : undefined,
        station: optStr(body, "station"),
        note: optStr(body, "note"),
      },
      user,
    ),
  ),
);

route("PATCH", "schedule/shifts/:id", "admin.schedule", ({ params, body, user }) => ({
  shift: updateShift(
    params.id,
    {
      employeeId: optStr(body, "employeeId"),
      date: optStr(body, "date"),
      starts: optStr(body, "starts"),
      ends: optStr(body, "ends"),
      breakMinutes: has(body, "breakMinutes") ? int(body, "breakMinutes") : undefined,
      station: optStr(body, "station"),
      note: optStr(body, "note"),
      status: optStr(body, "status"),
    },
    user,
  ),
}));

/** Drag-and-drop move: a new date plus a start clock, duration preserved. */
route("POST", "schedule/shifts/:id/move", "admin.schedule", ({ params, body, user }) => ({
  shift: moveShift(params.id, required(body, "date", "A date"), required(body, "starts", "A start time"), user),
}));

route("DELETE", "schedule/shifts/:id", "admin.schedule", ({ params, user }) => {
  deleteShift(params.id, user);
  return { ok: true };
});

route("GET", "schedule/shifts/:id", "admin.schedule", ({ params }) => {
  const shift = getShift(params.id);
  if (!shift) throw badRequest("Shift not found");
  return { shift };
});

route("POST", "schedule/publish", "admin.schedule", ({ body, user }) => publishWeek(str(body, "week", startOfWeek(today())), user));

route("POST", "schedule/copy-week", "admin.schedule", ({ body, user }) => copyPreviousWeek(str(body, "week", startOfWeek(today())), user));

// ------------------------------------------------------------------ availability
route("GET", "availability", "admin.schedule", ({ query }) => ({
  windows: getAvailability(q(query, "employeeId") || undefined),
  staff: getStaff(),
}));

route("PUT", "availability/:employeeId/:weekday", "admin.schedule", ({ params, body, user }) => ({
  window: setAvailability(
    params.employeeId,
    int({ weekday: params.weekday }, "weekday", 0),
    { starts: optStr(body, "starts"), ends: optStr(body, "ends"), unavailable: has(body, "unavailable") ? bool(body, "unavailable") : undefined },
    user,
  ),
  windows: getAvailability(params.employeeId),
}));

// ------------------------------------------------------------------------ swaps
route("GET", "swaps", "admin.schedule", ({ query }) => ({
  swaps: getSwaps({ status: q(query, "status", "all") }),
  pending: getSwaps({ status: "pending" }).length,
}));

route("POST", "swaps", "admin.schedule", ({ body, user }) =>
  created(
    requestSwap(
      required(body, "shiftId", "A shift"),
      { requestedTo: nullableStr(body, "requestedTo") ?? undefined, reason: optStr(body, "reason") },
      user,
    ),
  ),
);

route("POST", "swaps/:id/decide", "admin.schedule", ({ params, body, user }) => {
  const decision = oneOf(str(body, "decision"), SWAP_DECISIONS, "denied");
  if (!str(body, "decision")) throw badRequest("A decision is required");
  return { swap: decideSwap(params.id, decision, user), swaps: getSwaps() };
});

// ------------------------------------------------------------------- time clock
route("GET", "timeclock", "admin.timeclock", ({ query }) => {
  const date = q(query, "date", businessDateNow());
  const settings = getSettings();
  return {
    date,
    clockedIn: getClockedIn(),
    entries: getTimeEntries({
      from: q(query, "from", date),
      to: q(query, "to", date),
      employeeId: q(query, "employeeId") || undefined,
      editedOnly: qBool(query, "editedOnly"),
      limit: qInt(query, "limit", 500),
    }),
    summary: laborSummary(q(query, "from", date), q(query, "to", date), {
      min: settings.laborTargetMin,
      max: settings.laborTargetMax,
    }),
    staff: getStaff(),
  };
});

/** Clock in from the terminal on behalf of an employee who forgot their PIN pad. */
route("POST", "timeclock/clock-in", null, ({ body, user }) => {
  const employeeId = str(body, "employeeId") || user.id;
  const entry = clockInByEmployee(employeeId, user);
  return { entry, clockedIn: getClockedIn() };
});

route("POST", "timeclock/clock-out", null, ({ body, user }) => {
  const employeeId = str(body, "employeeId") || user.id;
  const entry = clockOutByEmployee(employeeId, user);
  return { entry, clockedIn: getClockedIn() };
});

route("POST", "timeclock/entries/:id/close", "admin.timeclock", ({ params, body, user }) => ({
  entry: closeTimeEntry(params.id, user, optStr(body, "at")),
}));

/** Manager override of a punch — always stores the reason and the editor. */
route("PATCH", "timeclock/entries/:id", "admin.timeclock", ({ params, body, user }) => ({
  entry: editTimeEntry(
    params.id,
    {
      clockIn: optStr(body, "clockIn"),
      clockOut: has(body, "clockOut") ? nullableStr(body, "clockOut") ?? undefined : undefined,
      breakMinutes: has(body, "breakMinutes") ? int(body, "breakMinutes") : undefined,
      otApproved: has(body, "otApproved") ? bool(body, "otApproved") : undefined,
    },
    required(body, "reason", "A reason for the edit"),
    user,
  ),
}));

route("POST", "timeclock/entries/:id/break", "admin.timeclock", ({ params, body, user }) => ({
  entry: logBreak(params.id, int(body, "minutes", 15), user),
}));

route("POST", "timeclock/entries/:id/overtime", "admin.timeclock", ({ params, user }) => ({
  entry: approveOvertime(params.id, user),
}));

// --------------------------------------------------------------------- reports
route("GET", "labor/summary", "reports.executive", ({ query }) => {
  const settings = getSettings();
  const to = q(query, "to", today());
  const from = q(query, "from", shiftDate(to, -6));
  return { from, to, summary: laborSummary(from, to, { min: settings.laborTargetMin, max: settings.laborTargetMax }) };
});

route("GET", "labor/coverage", "admin.schedule", ({ query }) => ({ coverage: coverageForDate(q(query, "date", today())) }));
