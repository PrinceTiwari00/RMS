/**
 * Staff service — employees, PIN sign-in, roles and granular permissions.
 *
 * PINs are stored hashed, never in plain text. A sign-in resolves the employee,
 * verifies the PIN with a constant-time compare, records the audit entry and
 * optionally opens a time-clock entry so the labour report is accurate.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, notFound, unauthorized } from "@/server/router";
import { audit, recentAudit } from "@/server/audit";
import { PERMISSIONS, permissionsFor, ROLE_DEFINITIONS, PERMISSION_GROUPS, type Permission } from "@/domain/permissions";
import { openTimeEntry } from "@/server/labor";
import { isDemoMode } from "@/lib/session";
import { nowStamp } from "@/domain/time";
import type { AuditEntry, RoleInfo, SessionUser, StaffMember } from "@/types";

interface EmployeeRow {
  id: string;
  name: string;
  role_id: string | null;
  pin: string;
  initials: string;
  color: string;
  phone: string | null;
  is_active: number;
  hire_date: string | null;
  created_at: string;
  role_name: string | null;
  role_title: string | null;
  hourly_rate: number | null;
  open_entry: string | null;
}

const EMPLOYEE_SELECT = `
  SELECT e.*, r.name AS role_name, r.title AS role_title, r.hourly_rate,
         (SELECT t.id FROM time_entries t WHERE t.employee_id = e.id AND t.clock_out IS NULL
           ORDER BY t.clock_in DESC LIMIT 1) AS open_entry
    FROM employees e LEFT JOIN roles r ON r.id = e.role_id`;

/** PINs are hashed at rest; the demo seed stores a hash too. */
export function hashPin(pin: string): string {
  return createHash("sha256").update(`rms:${pin}`).digest("hex");
}

function pinMatches(stored: string, candidate: string): boolean {
  const a = Buffer.from(stored ?? "");
  const b = Buffer.from(hashPin(candidate));
  // Tolerate legacy plain-text PINs written by the demo seed.
  const plain = Buffer.from(candidate);
  if (a.length === b.length && timingSafeEqual(a, b)) return true;
  if (a.length === plain.length && timingSafeEqual(a, plain)) return true;
  return false;
}

export function validatePin(pin: string): void {
  if (!/^\d{4}(\d{2})?$/.test(String(pin ?? ""))) throw badRequest("PIN must be 4 or 6 digits");
}

export function getStaff(filter: { includeInactive?: boolean; role?: string } = {}): StaffMember[] {
  const rows = all<EmployeeRow>(`${EMPLOYEE_SELECT} ORDER BY e.name`);
  const showPin = isDemoMode();
  return rows
    .filter((row) => (filter.includeInactive ? true : Boolean(row.is_active)))
    .filter((row) => (filter.role && filter.role !== "all" ? row.role_name === filter.role : true))
    .map((row) => {
      const roleName = row.role_name ?? "server";
      const granted = all<{ permission: string }>("SELECT permission FROM role_permissions WHERE role_id = ?", row.role_id ?? "").map(
        (entry) => entry.permission,
      );
      return {
        id: row.id,
        name: row.name,
        initials: row.initials,
        color: row.color,
        role: roleName,
        roleTitle: row.role_title ?? roleName,
        phone: row.phone ?? "",
        isActive: Boolean(row.is_active),
        hourlyRate: Number(row.hourly_rate ?? 0),
        hireDate: row.hire_date,
        permissions: permissionsFor(roleName, granted),
        clockedIn: Boolean(row.open_entry),
        currentEntryId: row.open_entry,
        // Only ever exposed in demo mode, purely as an on-screen hint.
        ...(showPin ? { pin: row.pin.length === 64 ? "" : row.pin } : {}),
      };
    });
}

export function getStaffMember(id: string): StaffMember | null {
  return getStaff({ includeInactive: true }).find((member) => member.id === id) ?? null;
}

export function findEmployeeByPin(pin: string): EmployeeRow | null {
  const rows = all<EmployeeRow>(`${EMPLOYEE_SELECT} WHERE e.is_active = 1`);
  return rows.find((row) => pinMatches(row.pin, pin)) ?? null;
}

export function toSessionUser(row: EmployeeRow): SessionUser {
  const roleName = row.role_name ?? "server";
  const granted = all<{ permission: string }>("SELECT permission FROM role_permissions WHERE role_id = ?", row.role_id ?? "").map(
    (entry) => entry.permission,
  );
  return {
    id: row.id,
    name: row.name,
    initials: row.initials,
    color: row.color,
    role: roleName,
    roleTitle: row.role_title ?? roleName,
    permissions: permissionsFor(roleName, granted),
  };
}

/** PIN-pad sign-in. Optionally opens a time entry at the same moment. */
export function signInWithPin(pin: string, clockIn: boolean): { user: SessionUser; clockedIn: boolean; entryId: string | null } {
  validatePin(pin);
  const row = findEmployeeByPin(pin);
  if (!row) throw unauthorized("That PIN does not match an active employee");

  let entryId: string | null = row.open_entry ?? null;
  let clockedIn = Boolean(row.open_entry);
  if (clockIn && !clockedIn) {
    entryId = openTimeEntry(row.id, Number(row.hourly_rate ?? 0));
    clockedIn = true;
  }
  audit(toSessionUser(row), "auth.signin", "employee", row.id, clockIn ? "signed in and clocked on" : "terminal unlock only");
  return { user: toSessionUser(row), clockedIn, entryId };
}

export interface EmployeeInput {
  name?: string;
  roleId?: string | null;
  pin?: string;
  color?: string;
  phone?: string;
  isActive?: boolean;
  hireDate?: string;
}

export function createEmployee(input: EmployeeInput, actor: SessionUser | null): StaffMember {
  const name = String(input.name ?? "").trim();
  if (!name) throw badRequest("Employee name is required");
  const pin = String(input.pin ?? "").trim();
  validatePin(pin);
  if (findEmployeeByPin(pin)) throw badRequest("That PIN is already assigned to another employee");
  if (input.roleId && !get("SELECT id FROM roles WHERE id = ?", input.roleId)) throw notFound("Role not found");

  const id = uuid();
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  run(
    `INSERT INTO employees (id, name, role_id, pin, initials, color, phone, is_active, hire_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    name,
    input.roleId ?? null,
    hashPin(pin),
    initials,
    input.color ?? "#137c70",
    input.phone ?? "",
    input.isActive === false ? 0 : 1,
    input.hireDate ?? nowStamp().slice(0, 10),
    nowStamp(),
  );
  audit(actor, "admin.employee.create", "employee", id, `${name} (${pin})`);
  return getStaffMember(id)!;
}

export function updateEmployee(id: string, patch: EmployeeInput, actor: SessionUser | null): StaffMember {
  const row = get<EmployeeRow>("SELECT * FROM employees WHERE id = ?", id);
  if (!row) throw notFound("Employee not found");
  if (patch.pin !== undefined && patch.pin !== "") {
    validatePin(patch.pin);
    const clash = all<EmployeeRow>("SELECT * FROM employees WHERE is_active = 1").find(
      (candidate) => candidate.id !== id && pinMatches(candidate.pin, patch.pin as string),
    );
    if (clash) throw badRequest(`That PIN is already used by ${clash.name}`);
  }
  run(
    `UPDATE employees SET name = ?, role_id = ?, pin = ?, color = ?, phone = ?, is_active = ?, hire_date = ? WHERE id = ?`,
    patch.name ?? row.name,
    patch.roleId !== undefined ? patch.roleId : row.role_id,
    patch.pin ? hashPin(patch.pin) : row.pin,
    patch.color ?? row.color,
    patch.phone ?? row.phone,
    patch.isActive === undefined ? row.is_active : patch.isActive ? 1 : 0,
    patch.hireDate ?? row.hire_date,
    id,
  );
  audit(actor, "admin.employee.update", "employee", id, patch.name ?? row.name);
  return getStaffMember(id)!;
}

/** Deactivate rather than delete: history must keep its actor. */
export function deactivateEmployee(id: string, actor: SessionUser | null): void {
  const row = get<EmployeeRow>("SELECT * FROM employees WHERE id = ?", id);
  if (!row) throw notFound("Employee not found");
  const openShift = get<{ id: string }>("SELECT id FROM time_entries WHERE employee_id = ? AND clock_out IS NULL", id);
  if (openShift) throw badRequest("Clock this employee out before deactivating them");
  run("UPDATE employees SET is_active = 0 WHERE id = ?", id);
  audit(actor, "admin.employee.deactivate", "employee", id, row.name);
}

// ------------------------------------------------------------------------ roles
export function getRoles(): RoleInfo[] {
  const rows = all<{ id: string; name: string; title: string; hourly_rate: number; is_system: number; headcount: number }>(
    `SELECT r.*, (SELECT COUNT(*) FROM employees e WHERE e.role_id = r.id AND e.is_active = 1) AS headcount
       FROM roles r ORDER BY r.sort_order, r.title`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    title: row.title,
    hourlyRate: row.hourly_rate,
    isSystem: Boolean(row.is_system),
    permissions: all<{ permission: string }>("SELECT permission FROM role_permissions WHERE role_id = ?", row.id).map(
      (entry) => entry.permission,
    ),
    headcount: Number(row.headcount),
  }));
}

/** Replace a role's individually granted permission set. */
export function setRolePermissions(roleId: string, permissions: string[], actor: SessionUser | null): RoleInfo {
  const role = get<{ id: string; name: string }>("SELECT id, name FROM roles WHERE id = ?", roleId);
  if (!role) throw notFound("Role not found");
  const valid = new Set(Object.keys(PERMISSIONS));
  tx(() => {
    run("DELETE FROM role_permissions WHERE role_id = ?", roleId);
    for (const permission of permissions) {
      if (!valid.has(permission)) continue;
      run("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)", roleId, permission);
    }
  });
  audit(actor, "admin.permissions.update", "role", roleId, `${role.name}: ${permissions.length} permission(s)`);
  return getRoles().find((entry) => entry.id === roleId)!;
}

export function updateRole(id: string, patch: { title?: string; hourlyRate?: number }, actor: SessionUser | null): RoleInfo {
  const row = get<{ id: string; title: string; hourly_rate: number }>("SELECT * FROM roles WHERE id = ?", id);
  if (!row) throw notFound("Role not found");
  run(
    "UPDATE roles SET title = ?, hourly_rate = ? WHERE id = ?",
    patch.title ?? row.title,
    patch.hourlyRate !== undefined ? Math.round(Number(patch.hourlyRate)) : row.hourly_rate,
    id,
  );
  audit(actor, "admin.role.update", "role", id, `${row.title}: rate ${patch.hourlyRate ?? row.hourly_rate / 100}`);
  return getRoles().find((entry) => entry.id === id)!;
}

export function permissionCatalogue(): { label: string; permissions: { key: Permission; label: string }[] }[] {
  return PERMISSION_GROUPS.map((group) => ({
    label: group.label,
    permissions: group.permissions.map((key) => ({ key, label: PERMISSIONS[key] ?? key })),
  }));
}

export function roleTemplates() {
  return ROLE_DEFINITIONS.map((definition) => ({
    name: definition.name,
    title: definition.title,
    hourlyRate: definition.hourlyRate,
    permissionCount: definition.permissions.length,
  }));
}

export function auditTrail(limit = 60): AuditEntry[] {
  return recentAudit(limit);
}

export { notFound };
