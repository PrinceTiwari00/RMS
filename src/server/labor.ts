/**
 * Labour service — shift schedule, availability, swap approvals and the
 * time-clock audit trail.
 *
 * The hourly rate is copied from the role into each time entry at clock-in, so
 * a later pay rise never rewrites what a past shift actually cost. Every manager
 * edit is flagged with who made it and why.
 */
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, notFound } from "@/server/router";
import { audit } from "@/server/audit";
import {
  grossPay,
  laborCostPercent,
  laborHealth,
  salesPerLaborHour,
  scheduledHours,
  shiftHours,
  splitHours,
  totalLaborCost,
} from "@/domain/labor";
import { atClock, businessDateNow, elapsedMinutes, formatClock, nowStamp, shiftDate, startOfWeek, today, weekDates, zoned } from "@/domain/time";
import type { AvailabilityWindow, SessionUser, Shift, SwapRequest, TimeEntry } from "@/types";

// ------------------------------------------------------------------- time clock
/** Open a time entry (clock-in). Called by PIN sign-in and the time clock screen. */
export function openTimeEntry(employeeId: string, hourlyRate: number, at?: string): string {
  const employee = get<{ id: string; name: string }>("SELECT id, name FROM employees WHERE id = ? AND is_active = 1", employeeId);
  if (!employee) throw notFound("Employee not found");
  const existing = get<{ id: string }>("SELECT id FROM time_entries WHERE employee_id = ? AND clock_out IS NULL", employeeId);
  if (existing) throw badRequest(`${employee.name} is already clocked in`);
  const id = uuid();
  const stamp = at ?? nowStamp();
  run(
    `INSERT INTO time_entries (id, employee_id, clock_in, break_minutes, regular_hours, overtime_hours, hourly_rate, business_date)
     VALUES (?, ?, ?, 0, 0, 0, ?, ?)`,
    id,
    employeeId,
    stamp,
    Math.round(hourlyRate),
    stamp.slice(0, 10),
  );
  audit({ id: employeeId, name: employee.name }, "labor.clockin", "time_entry", id, stamp);
  return id;
}

/** Close a time entry (clock-out) and compute regular/overtime hours. */
export function closeTimeEntry(entryId: string, actor: SessionUser | null, at?: string): TimeEntry {
  const row = get<{
    id: string;
    employee_id: string;
    clock_in: string;
    clock_out: string | null;
    break_minutes: number;
    hourly_rate: number;
  }>("SELECT * FROM time_entries WHERE id = ?", entryId);
  if (!row) throw notFound("Time entry not found");
  if (row.clock_out) throw badRequest("That shift is already clocked out");
  const stamp = at ?? nowStamp();
  const hours = shiftHours(row.clock_in, stamp, row.break_minutes);
  const { regular, overtime } = splitHours(hours);
  run(
    "UPDATE time_entries SET clock_out = ?, regular_hours = ?, overtime_hours = ? WHERE id = ?",
    stamp,
    regular,
    overtime,
    entryId,
  );
  audit(actor, "labor.clockout", "time_entry", entryId, `${regular}h regular, ${overtime}h overtime`);
  return getTimeEntry(entryId)!;
}

export function clockInByEmployee(employeeId: string, actor: SessionUser | null): TimeEntry {
  const rate = Number(get<{ hourly_rate: number }>("SELECT COALESCE(r.hourly_rate, 0) AS hourly_rate FROM employees e LEFT JOIN roles r ON r.id = e.role_id WHERE e.id = ?", employeeId)?.hourly_rate ?? 0);
  const id = openTimeEntry(employeeId, rate);
  void actor;
  return getTimeEntry(id)!;
}

export function clockOutByEmployee(employeeId: string, actor: SessionUser | null): TimeEntry {
  const row = get<{ id: string }>("SELECT id FROM time_entries WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1", employeeId);
  if (!row) throw badRequest("That employee is not clocked in");
  return closeTimeEntry(row.id, actor);
}

interface TimeRow {
  id: string;
  employee_id: string;
  employee_name: string;
  initials: string;
  color: string;
  role_title: string | null;
  clock_in: string;
  clock_out: string | null;
  break_minutes: number;
  regular_hours: number;
  overtime_hours: number;
  hourly_rate: number;
  business_date: string | null;
  edited: number;
  edit_reason: string | null;
  edited_by: string | null;
  ot_approved: number;
  editor_name: string | null;
}

const TIME_SELECT = `
  SELECT t.*, e.name AS employee_name, e.initials, e.color, r.title AS role_title, ed.name AS editor_name
    FROM time_entries t
    JOIN employees e ON e.id = t.employee_id
    LEFT JOIN roles r ON r.id = e.role_id
    LEFT JOIN employees ed ON ed.id = t.edited_by`;

function mapTime(row: TimeRow): TimeEntry {
  const open = !row.clock_out;
  const liveHours = open ? shiftHours(row.clock_in, nowStamp(), row.break_minutes) : row.regular_hours + row.overtime_hours;
  const regular = open ? splitHours(liveHours).regular : row.regular_hours;
  const overtime = open ? splitHours(liveHours).overtime : row.overtime_hours;
  const gross = grossPay(regular, overtime, row.hourly_rate);
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    initials: row.initials,
    color: row.color,
    roleTitle: row.role_title ?? "—",
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    breakMinutes: row.break_minutes,
    regularHours: regular,
    overtimeHours: overtime,
    hourlyRate: row.hourly_rate,
    businessDate: row.business_date,
    edited: Boolean(row.edited),
    editReason: row.edit_reason,
    editedBy: row.editor_name,
    otApproved: Boolean(row.ot_approved),
    grossPay: gross,
    burdened: totalLaborCost(gross),
    open,
    liveHours: Math.round(liveHours * 100) / 100,
  };
}

export function getTimeEntry(id: string): TimeEntry | null {
  const row = get<TimeRow>(`${TIME_SELECT} WHERE t.id = ?`, id);
  return row ? mapTime(row) : null;
}

export function getTimeEntries(filter: { from?: string; to?: string; employeeId?: string; openOnly?: boolean; editedOnly?: boolean; limit?: number } = {}): TimeEntry[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.from) {
    clauses.push("COALESCE(t.business_date, date(t.clock_in)) >= ?");
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push("COALESCE(t.business_date, date(t.clock_in)) <= ?");
    params.push(filter.to);
  }
  if (filter.employeeId) {
    clauses.push("t.employee_id = ?");
    params.push(filter.employeeId);
  }
  if (filter.openOnly) clauses.push("t.clock_out IS NULL");
  if (filter.editedOnly) clauses.push("t.edited = 1");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return all<TimeRow>(`${TIME_SELECT} ${where} ORDER BY t.clock_in DESC LIMIT ?`, ...params, filter.limit ?? 500).map(mapTime);
}

/** Everyone currently on the clock — the live roster. */
export function getClockedIn(): TimeEntry[] {
  return getTimeEntries({ openOnly: true });
}

/**
 * Manager override. Editing a past punch is a payroll-affecting act, so the
 * reason and the editor are stored on the row and surfaced in the audit screen.
 */
export function editTimeEntry(
  entryId: string,
  patch: { clockIn?: string; clockOut?: string | null; breakMinutes?: number; otApproved?: boolean },
  reason: string,
  actor: SessionUser | null,
): TimeEntry {
  const row = get<{ id: string; clock_in: string; clock_out: string | null; break_minutes: number; ot_approved: number }>(
    "SELECT * FROM time_entries WHERE id = ?",
    entryId,
  );
  if (!row) throw notFound("Time entry not found");
  const trimmed = String(reason ?? "").trim();
  if (!trimmed) throw badRequest("A reason is required to edit a timesheet");

  const clockIn = patch.clockIn ?? row.clock_in;
  const clockOut = patch.clockOut !== undefined ? patch.clockOut : row.clock_out;
  const breakMinutes = patch.breakMinutes !== undefined ? Math.max(0, Math.round(Number(patch.breakMinutes))) : row.break_minutes;
  if (clockOut && clockOut <= clockIn) throw badRequest("Clock-out must be after clock-in");

  const hours = clockOut ? shiftHours(clockIn, clockOut, breakMinutes) : 0;
  const { regular, overtime } = splitHours(hours);
  run(
    `UPDATE time_entries SET clock_in = ?, clock_out = ?, break_minutes = ?, regular_hours = ?, overtime_hours = ?,
       edited = 1, edit_reason = ?, edited_by = ?, ot_approved = ?
      WHERE id = ?`,
    clockIn,
    clockOut,
    breakMinutes,
    regular,
    overtime,
    trimmed.slice(0, 280),
    actor?.id ?? null,
    patch.otApproved === undefined ? row.ot_approved : patch.otApproved ? 1 : 0,
    entryId,
  );
  audit(actor, "labor.override", "time_entry", entryId, `${trimmed} — in ${formatClock(clockIn)}, out ${clockOut ? formatClock(clockOut) : "open"}`);
  return getTimeEntry(entryId)!;
}

/**
 * Sign off overtime on a closed entry. Payroll needs an explicit approval flag
 * separate from the edit trail, so approving never marks the row as overridden.
 */
export function approveOvertime(entryId: string, actor: SessionUser | null): TimeEntry {
  const row = get<{ id: string; clock_out: string | null; overtime_hours: number; ot_approved: number }>(
    "SELECT * FROM time_entries WHERE id = ?",
    entryId,
  );
  if (!row) throw notFound("Time entry not found");
  if (!row.clock_out) throw badRequest("Clock the shift out before approving its overtime");
  if (row.ot_approved) throw badRequest("That overtime has already been approved");
  if (row.overtime_hours <= 0) throw badRequest("That shift has no overtime to approve");
  run("UPDATE time_entries SET ot_approved = 1 WHERE id = ?", entryId);
  audit(actor, "labor.overtime.approve", "time_entry", entryId, `${row.overtime_hours}h approved`);
  return getTimeEntry(entryId)!;
}

export function logBreak(entryId: string, minutes: number, actor: SessionUser | null): TimeEntry {
  const row = get<{ id: string; break_minutes: number; clock_out: string | null }>("SELECT * FROM time_entries WHERE id = ?", entryId);
  if (!row) throw notFound("Time entry not found");
  if (row.clock_out) throw badRequest("That shift is already closed");
  const total = Math.max(0, Math.round(Number(minutes)));
  run("UPDATE time_entries SET break_minutes = ? WHERE id = ?", total, entryId);
  audit(actor, "labor.break", "time_entry", entryId, `${total} minute break recorded`);
  return getTimeEntry(entryId)!;
}

/** Labour totals for a date range, ready for the dashboard and Z-report. */
export function laborSummary(from: string, to: string, targetBand?: { min: number; max: number }) {
  const entries = getTimeEntries({ from, to });
  const hours = entries.reduce((sum, entry) => sum + (entry.open ? entry.liveHours : entry.regularHours + entry.overtimeHours), 0);
  const overtime = entries.reduce((sum, entry) => sum + entry.overtimeHours, 0);
  const gross = entries.reduce((sum, entry) => sum + entry.grossPay, 0);
  const burdened = totalLaborCost(gross);

  const sales = Number(
    get<{ total: number }>(
      `SELECT COALESCE(SUM(total), 0) AS total FROM orders
        WHERE status = 'closed' AND business_date BETWEEN ? AND ?`,
      from,
      to,
    )?.total ?? 0,
  );

  const byRole = new Map<string, { hours: number; cost: number; headcount: number }>();
  for (const entry of entries) {
    const bucket = byRole.get(entry.roleTitle) ?? { hours: 0, cost: 0, headcount: 0 };
    bucket.hours += entry.open ? entry.liveHours : entry.regularHours + entry.overtimeHours;
    bucket.cost += entry.burdened;
    byRole.set(entry.roleTitle, bucket);
  }
  const headcountByRole = new Map<string, Set<string>>();
  for (const entry of entries) {
    const set = headcountByRole.get(entry.roleTitle) ?? new Set<string>();
    set.add(entry.employeeId);
    headcountByRole.set(entry.roleTitle, set);
  }

  const percent = laborCostPercent(burdened, sales);
  return {
    entries: entries.length,
    hours: Math.round(hours * 100) / 100,
    overtimeHours: Math.round(overtime * 100) / 100,
    grossPay: gross,
    burdenedCost: burdened,
    sales,
    laborPercent: percent,
    health: laborHealth(percent, targetBand),
    salesPerLaborHour: salesPerLaborHour(sales, hours),
    editedEntries: entries.filter((entry) => entry.edited).length,
    pendingOvertime: entries.filter((entry) => entry.overtimeHours > 0 && !entry.otApproved && !entry.open).length,
    clockedInNow: entries.filter((entry) => entry.open).length,
    byRole: [...byRole.entries()].map(([role, bucket]) => ({
      role,
      hours: Math.round(bucket.hours * 100) / 100,
      cost: bucket.cost,
      headcount: headcountByRole.get(role)?.size ?? 0,
    })),
  };
}

// --------------------------------------------------------------------- schedule
interface ShiftRow {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_color: string;
  initials: string;
  role_title: string | null;
  hourly_rate: number;
  starts_at: string;
  ends_at: string;
  break_minutes: number;
  note: string;
  station: string;
  status: string;
}

const SHIFT_SELECT = `
  SELECT s.*, e.name AS employee_name, e.color AS employee_color, e.initials, r.title AS role_title,
         COALESCE(r.hourly_rate, 0) AS hourly_rate
    FROM shifts s JOIN employees e ON e.id = s.employee_id LEFT JOIN roles r ON r.id = e.role_id`;

function mapShift(row: ShiftRow, swaps: SwapRequest[] = []): Shift {
  const hours = shiftHours(row.starts_at, row.ends_at, row.break_minutes);
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    employeeColor: row.employee_color,
    initials: row.initials,
    roleTitle: row.role_title ?? "—",
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    breakMinutes: row.break_minutes,
    note: row.note,
    station: row.station,
    status: row.status as Shift["status"],
    hours: Math.round(hours * 100) / 100,
    laborCost: totalLaborCost(grossPay(splitHours(hours).regular, splitHours(hours).overtime, row.hourly_rate)),
    swap: swaps.find((swap) => swap.shiftId === row.id) ?? null,
  };
}

export function getSwaps(filter: { status?: string } = {}): SwapRequest[] {
  const rows = all<{
    id: string;
    shift_id: string;
    requested_by: string;
    from_name: string;
    requested_to: string;
    to_name: string | null;
    reason: string;
    status: string;
    decided_by: string | null;
    decided_at: string | null;
    created_at: string;
    starts_at: string;
    ends_at: string;
  }>(
    `SELECT sw.*, ef.name AS from_name, et.name AS to_name, s.starts_at, s.ends_at
       FROM shift_swaps sw
       JOIN shifts s ON s.id = sw.shift_id
       JOIN employees ef ON ef.id = sw.requested_by
       LEFT JOIN employees et ON et.id = sw.requested_to
      ORDER BY CASE sw.status WHEN 'pending' THEN 0 ELSE 1 END, sw.created_at DESC`,
  );
  return rows
    .filter((row) => (filter.status && filter.status !== "all" ? row.status === filter.status : true))
    .map((row) => ({
      id: row.id,
      shiftId: row.shift_id,
      requestedBy: row.requested_by,
      requestedByName: row.from_name,
      requestedTo: row.requested_to,
      requestedToName: row.to_name ?? "Anyone",
      reason: row.reason,
      status: row.status as SwapRequest["status"],
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      createdAt: row.created_at,
      shiftLabel: `${row.starts_at.slice(0, 10)} · ${formatClock(row.starts_at)}–${formatClock(row.ends_at)}`,
    }));
}

/** A week of shifts, keyed for the drag-and-drop scheduler grid. */
export function getSchedule(weekStart?: string): { weekStart: string; dates: string[]; shifts: Shift[]; totalsByDate: Record<string, { hours: number; cost: number; count: number }> } {
  const from = startOfWeek(weekStart ?? today());
  const dates = weekDates(from);
  const to = dates[dates.length - 1];
  const rows = all<ShiftRow>(
    `${SHIFT_SELECT} WHERE date(s.starts_at) BETWEEN ? AND ? ORDER BY s.starts_at, e.name`,
    from,
    to,
  );
  const swaps = getSwaps();
  const shifts = rows.map((row) => mapShift(row, swaps));

  const totalsByDate: Record<string, { hours: number; cost: number; count: number }> = {};
  for (const date of dates) totalsByDate[date] = { hours: 0, cost: 0, count: 0 };
  for (const shift of shifts) {
    const date = shift.startsAt.slice(0, 10);
    const bucket = totalsByDate[date] ?? { hours: 0, cost: 0, count: 0 };
    bucket.hours += shift.hours;
    bucket.cost += shift.laborCost;
    bucket.count += 1;
    totalsByDate[date] = bucket;
  }
  return { weekStart: from, dates, shifts, totalsByDate };
}

export interface ShiftInput {
  employeeId?: string;
  date?: string;
  starts?: string;
  ends?: string;
  breakMinutes?: number;
  station?: string;
  note?: string;
}

export function createShift(input: ShiftInput, actor: SessionUser | null): Shift {
  const employee = get<{ id: string; name: string }>("SELECT id, name FROM employees WHERE id = ? AND is_active = 1", input.employeeId ?? "");
  if (!employee) throw notFound("Employee not found");
  const date = input.date ?? today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("Shift date must be YYYY-MM-DD");
  const starts = atClock(date, input.starts ?? "11:00");
  const ends = atClock(date, input.ends ?? "19:00");
  if (ends <= starts) throw badRequest("Shift end must be after its start");

  const clash = get<{ id: string; starts_at: string; ends_at: string }>(
    `SELECT id, starts_at, ends_at FROM shifts
      WHERE employee_id = ? AND status != 'cancelled' AND date(starts_at) = ?
        AND NOT (ends_at <= ? OR starts_at >= ?)`,
    employee.id,
    date,
    starts,
    ends,
  );
  if (clash) throw badRequest(`${employee.name} already has a shift overlapping ${formatClock(clash.starts_at)}–${formatClock(clash.ends_at)}`);

  const id = uuid();
  run(
    `INSERT INTO shifts (id, employee_id, starts_at, ends_at, break_minutes, note, station, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
    id,
    employee.id,
    starts,
    ends,
    Math.max(0, Math.round(Number(input.breakMinutes ?? 30))),
    String(input.note ?? ""),
    input.station ?? "",
    nowStamp(),
  );
  audit(actor, "labor.shift.create", "shift", id, `${employee.name} ${date} ${formatClock(starts)}–${formatClock(ends)}`);
  return getShift(id)!;
}

export function getShift(id: string): Shift | null {
  const row = get<ShiftRow>(`${SHIFT_SELECT} WHERE s.id = ?`, id);
  return row ? mapShift(row, getSwaps()) : null;
}

export function updateShift(id: string, patch: ShiftInput & { status?: string }, actor: SessionUser | null): Shift {
  const row = get<{ id: string; employee_id: string; starts_at: string; ends_at: string; break_minutes: number; note: string; station: string; status: string }>(
    "SELECT * FROM shifts WHERE id = ?",
    id,
  );
  if (!row) throw notFound("Shift not found");
  const starts = patch.date || patch.starts ? atClock(patch.date ?? row.starts_at.slice(0, 10), patch.starts ?? row.starts_at.slice(11, 16)) : row.starts_at;
  const ends = patch.date || patch.ends ? atClock(patch.date ?? row.ends_at.slice(0, 10), patch.ends ?? row.ends_at.slice(11, 16)) : row.ends_at;
  if (ends <= starts) throw badRequest("Shift end must be after its start");
  run(
    `UPDATE shifts SET starts_at = ?, ends_at = ?, break_minutes = ?, note = ?, station = ?, status = ? WHERE id = ?`,
    starts,
    ends,
    patch.breakMinutes !== undefined ? Math.max(0, Math.round(Number(patch.breakMinutes))) : row.break_minutes,
    patch.note !== undefined ? String(patch.note) : row.note,
    patch.station !== undefined ? String(patch.station) : row.station,
    patch.status ?? row.status,
    id,
  );
  audit(actor, "labor.shift.update", "shift", id, `${starts.slice(0, 10)} ${formatClock(starts)}–${formatClock(ends)}`);
  return getShift(id)!;
}

/** Drag-and-drop move to another day/time slot. */
export function moveShift(id: string, date: string, starts: string, actor: SessionUser | null): Shift {
  const row = get<{ id: string; starts_at: string; ends_at: string; break_minutes: number }>("SELECT * FROM shifts WHERE id = ?", id);
  if (!row) throw notFound("Shift not found");
  const durationMinutes =
    (Number(row.ends_at.slice(11, 13)) * 60 + Number(row.ends_at.slice(14, 16))) -
    (Number(row.starts_at.slice(11, 13)) * 60 + Number(row.starts_at.slice(14, 16)));
  const startMinutes = Number(starts.slice(0, 2)) * 60 + Number(starts.slice(3, 5));
  const endMinutes = startMinutes + Math.max(30, durationMinutes);
  const ends =
    endMinutes >= 1440
      ? atClock(shiftDate(date, 1), `${String(Math.floor((endMinutes - 1440) / 60)).padStart(2, "0")}:${String((endMinutes - 1440) % 60).padStart(2, "0")}`)
      : atClock(date, `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`);
  return updateShift(id, { date, starts, ends: ends.slice(11, 16), }, actor);
}

export function deleteShift(id: string, actor: SessionUser | null): void {
  const row = get<{ id: string; status: string }>("SELECT * FROM shifts WHERE id = ?", id);
  if (!row) throw notFound("Shift not found");
  if (row.status === "completed") throw badRequest("A completed shift cannot be deleted — edit it instead");
  tx(() => {
    run("DELETE FROM shift_swaps WHERE shift_id = ?", id);
    run("DELETE FROM shifts WHERE id = ?", id);
  });
  audit(actor, "labor.shift.delete", "shift", id, null);
}

/** Publish the whole week so staff can see it. */
export function publishWeek(weekStart: string, actor: SessionUser | null): { published: number } {
  const dates = weekDates(weekStart);
  const published = run(
    `UPDATE shifts SET status = 'published' WHERE status = 'scheduled' AND date(starts_at) BETWEEN ? AND ?`,
    dates[0],
    dates[dates.length - 1],
  ).changes;
  audit(actor, "labor.schedule.publish", "schedule", weekStart, `${published} shift(s) published`);
  return { published };
}

/** Copy last week's pattern forward — the fastest way to build a rota. */
export function copyPreviousWeek(weekStart: string, actor: SessionUser | null): { copied: number } {
  const dates = weekDates(weekStart);
  const previous = weekDates(shiftDate(weekStart, -7));
  const rows = all<{ employee_id: string; starts_at: string; ends_at: string; break_minutes: number; station: string }>(
    "SELECT employee_id, starts_at, ends_at, break_minutes, station FROM shifts WHERE date(starts_at) BETWEEN ? AND ? AND status != 'cancelled'",
    previous[0],
    previous[6],
  );
  const copied = tx(() => {
    let count = 0;
    for (const row of rows) {
      const targetDate = dates[previous.indexOf(row.starts_at.slice(0, 10))];
      if (!targetDate) continue;
      const exists = get<{ id: string }>(
        "SELECT id FROM shifts WHERE employee_id = ? AND date(starts_at) = ? AND status != 'cancelled'",
        row.employee_id,
        targetDate,
      );
      if (exists) continue;
      run(
        `INSERT INTO shifts (id, employee_id, starts_at, ends_at, break_minutes, note, station, status, created_at)
         VALUES (?, ?, ?, ?, ?, '', ?, 'scheduled', ?)`,
        uuid(),
        row.employee_id,
        atClock(targetDate, row.starts_at.slice(11, 16)),
        atClock(targetDate, row.ends_at.slice(11, 16)),
        row.break_minutes,
        row.station,
        nowStamp(),
      );
      count += 1;
    }
    return count;
  });
  audit(actor, "labor.schedule.copy", "schedule", weekStart, `${copied} shift(s) copied from the previous week`);
  return { copied };
}

// ------------------------------------------------------------------ availability
export function getAvailability(employeeId?: string): AvailabilityWindow[] {
  const rows = employeeId
    ? all<{ id: string; employee_id: string; weekday: number; starts: string; ends: string; unavailable: number }>(
        "SELECT * FROM availability WHERE employee_id = ? ORDER BY weekday",
        employeeId,
      )
    : all<{ id: string; employee_id: string; weekday: number; starts: string; ends: string; unavailable: number }>(
        "SELECT * FROM availability ORDER BY weekday",
      );
  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    weekday: row.weekday,
    starts: row.starts,
    ends: row.ends,
    unavailable: Boolean(row.unavailable),
  }));
}

export function setAvailability(employeeId: string, weekday: number, patch: { starts?: string; ends?: string; unavailable?: boolean }, actor: SessionUser | null): AvailabilityWindow {
  if (!get("SELECT id FROM employees WHERE id = ?", employeeId)) throw notFound("Employee not found");
  const day = ((weekday % 7) + 7) % 7;
  const existing = get<{ id: string; starts: string; ends: string; unavailable: number }>(
    "SELECT * FROM availability WHERE employee_id = ? AND weekday = ?",
    employeeId,
    day,
  );
  if (existing) {
    run(
      "UPDATE availability SET starts = ?, ends = ?, unavailable = ? WHERE id = ?",
      patch.starts ?? existing.starts,
      patch.ends ?? existing.ends,
      patch.unavailable === undefined ? existing.unavailable : patch.unavailable ? 1 : 0,
      existing.id,
    );
  } else {
    run(
      "INSERT INTO availability (id, employee_id, weekday, starts, ends, unavailable) VALUES (?, ?, ?, ?, ?, ?)",
      uuid(),
      employeeId,
      day,
      patch.starts ?? "09:00",
      patch.ends ?? "22:00",
      patch.unavailable ? 1 : 0,
    );
  }
  void actor;
  return getAvailability(employeeId).find((row) => row.weekday === day)!;
}

// ------------------------------------------------------------------------ swaps
export function requestSwap(shiftId: string, input: { requestedTo?: string; reason?: string }, actor: SessionUser | null): SwapRequest {
  const shift = get<{ id: string; employee_id: string; starts_at: string; status: string }>("SELECT * FROM shifts WHERE id = ?", shiftId);
  if (!shift) throw notFound("Shift not found");
  if (shift.status === "completed" || shift.status === "cancelled") throw badRequest("That shift can no longer be swapped");
  const existing = get<{ id: string }>("SELECT id FROM shift_swaps WHERE shift_id = ? AND status = 'pending'", shiftId);
  if (existing) throw badRequest("A swap request for this shift is already pending");
  const id = uuid();
  run(
    `INSERT INTO shift_swaps (id, shift_id, requested_by, requested_to, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    id,
    shiftId,
    shift.employee_id,
    input.requestedTo ?? "",
    String(input.reason ?? "").slice(0, 280),
    nowStamp(),
  );
  audit(actor, "labor.swap.request", "shift_swap", id, `shift ${shift.starts_at}`);
  return getSwaps().find((row) => row.id === id)!;
}

export function decideSwap(swapId: string, decision: "approved" | "denied", actor: SessionUser | null): SwapRequest {
  const row = get<{ id: string; shift_id: string; status: string; requested_by: string; requested_to: string }>(
    "SELECT * FROM shift_swaps WHERE id = ?",
    swapId,
  );
  if (!row) throw notFound("Swap request not found");
  if (row.status !== "pending") throw badRequest(`That request was already ${row.status}`);

  tx(() => {
    run("UPDATE shift_swaps SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?", decision, actor?.id ?? null, nowStamp(), swapId);
    if (decision === "approved" && row.requested_to) {
      run("UPDATE shifts SET employee_id = ?, note = TRIM(COALESCE(note,'') || ' (swapped)') WHERE id = ?", row.requested_to, row.shift_id);
    }
  });
  audit(actor, `labor.swap.${decision}`, "shift_swap", swapId, decision);
  return getSwaps().find((entry) => entry.id === swapId)!;
}

/** Coverage check for the scheduler: hours planned vs hours actually worked. */
export function coverageForDate(date: string) {
  const planned = all<{ starts_at: string; ends_at: string; break_minutes: number }>(
    "SELECT starts_at, ends_at, break_minutes FROM shifts WHERE date(starts_at) = ? AND status != 'cancelled'",
    date,
  );
  const worked = getTimeEntries({ from: date, to: date });
  const plannedHours = scheduledHours(planned);
  const workedHours = worked.reduce((sum, entry) => sum + (entry.open ? entry.liveHours : entry.regularHours + entry.overtimeHours), 0);
  return {
    date,
    plannedHours: Math.round(plannedHours * 100) / 100,
    workedHours: Math.round(workedHours * 100) / 100,
    variance: Math.round((workedHours - plannedHours) * 100) / 100,
    shiftCount: planned.length,
    clockedIn: worked.filter((entry) => entry.open).length,
  };
}

export function laborToday(targetBand?: { min: number; max: number }) {
  return laborSummary(businessDateNow(), businessDateNow(), targetBand);
}

export { elapsedMinutes, zoned };
