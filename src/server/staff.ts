/**
 * Staff service — employees, PIN sign-in, roles and granular permissions.
 *
 * New and changed PINs are salted and hashed with scrypt. Legacy hashes remain
 * verifiable for migration; plaintext samples authenticate only in demo mode.
 * A sign-in records an audit entry and optionally opens a time-clock entry.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, forbidden, notFound, unauthorized } from "@/server/router";
import { audit, recentAudit } from "@/server/audit";
import { can, PERMISSIONS, permissionsFor, ROLE_DEFINITIONS, PERMISSION_GROUPS, type Permission } from "@/domain/permissions";
import { openTimeEntry } from "@/server/labor";
import { isDemoMode } from "@/lib/session";
import { nowStamp } from "@/domain/time";
import type { AuditEntry, RoleInfo, SessionUser, StaffMember } from "@/types";
import { getSettings } from "@/server/settings";
import { applyPlan, assertSeatAvailable } from "@/server/plan";

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

/** New and changed PINs use a unique salt and a memory-hard derivation. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("base64url");
  const derived = scryptSync(pin, salt, 64).toString("base64url");
  return `scrypt$${salt}$${derived}`;
}

function pinMatches(stored: string, candidate: string): boolean {
  if (stored.startsWith("scrypt$")) {
    const [, salt, expected] = stored.split("$");
    if (!salt || !expected) return false;
    try {
      const actual = scryptSync(candidate, salt, 64);
      const expectedBuffer = Buffer.from(expected, "base64url");
      return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
    } catch {
      return false;
    }
  }

  // Backward compatibility for databases created before salted scrypt. These
  // hashes are upgraded whenever the employee's PIN is next changed.
  const legacy = createHash("sha256").update(`rms:${candidate}`).digest("hex");
  const storedBuffer = Buffer.from(stored ?? "");
  const legacyBuffer = Buffer.from(legacy);
  if (storedBuffer.length === legacyBuffer.length && timingSafeEqual(storedBuffer, legacyBuffer)) return true;

  // The original demo seed deliberately exposes its sample PINs on the PIN pad.
  // Never authenticate plaintext records in production mode.
  const plain = Buffer.from(candidate);
  return isDemoMode() && storedBuffer.length === plain.length && timingSafeEqual(storedBuffer, plain);
}

export function validatePin(pin: string, configuredLength?: 4 | 6): void {
  if (!/^\d{4}(\d{2})?$/.test(String(pin ?? ""))) throw badRequest("PIN must be 4 or 6 digits");
  if (configuredLength && String(pin).length !== configuredLength) {
    throw badRequest(`PIN must be exactly ${configuredLength} digits for this restaurant`);
  }
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
        permissions: applyPlan(permissionsFor(roleName, granted)),
        clockedIn: Boolean(row.open_entry),
        currentEntryId: row.open_entry,
        // Only ever exposed in demo mode, purely as an on-screen hint.
        ...(showPin && /^\d{4}(\d{2})?$/.test(row.pin) ? { pin: row.pin } : {}),
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
    permissions: applyPlan(permissionsFor(roleName, granted)),
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

/** Verify a one-off manager approval without creating a second staff session. */
export function verifyManagerPin(pin: string): SessionUser {
  if (!pin) throw forbidden("A manager PIN is required for this action");
  validatePin(pin);
  const row = findEmployeeByPin(pin);
  if (!row) throw forbidden("That manager PIN is not valid");
  const manager = toSessionUser(row);
  if (row.role_name !== "manager" && !can(manager.permissions, "admin.users")) {
    throw forbidden("This action needs a General Manager's PIN");
  }
  return manager;
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
  validatePin(pin, getSettings().pinLength);
  if (findEmployeeByPin(pin)) throw badRequest("That PIN is already assigned to another employee");
  if (input.roleId && !get("SELECT id FROM roles WHERE id = ?", input.roleId)) throw notFound("Role not found");
  // Seat caps come from the restaurant's plan. Reactivating an inactive
  // employee below also checks this.
  if (input.isActive !== false) assertSeatAvailable();

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
  audit(actor, "admin.employee.create", "employee", id, name);
  return getStaffMember(id)!;
}

export function updateEmployee(id: string, patch: EmployeeInput, actor: SessionUser | null): StaffMember {
  const row = get<EmployeeRow>("SELECT * FROM employees WHERE id = ?", id);
  if (!row) throw notFound("Employee not found");
  if (patch.isActive === true && !row.is_active) assertSeatAvailable();
  if (patch.pin !== undefined && patch.pin !== "") {
    validatePin(patch.pin, getSettings().pinLength);
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

export function createRole(
  input: { title: string; name?: string; hourlyRate?: number; permissions?: string[] },
  actor: SessionUser | null,
): RoleInfo {
  const title = String(input.title ?? "").trim();
  if (!title) throw badRequest("Role title is required");
  const name = String(input.name ?? title)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!name) throw badRequest("Role name is required");
  if (get("SELECT id FROM roles WHERE name = ? OR title = ? COLLATE NOCASE", name, title)) {
    throw badRequest("A role with that name already exists");
  }
  const id = uuid();
  const valid = new Set(Object.keys(PERMISSIONS));
  const permissions = [...new Set(input.permissions ?? [])].filter((permission) => valid.has(permission));
  tx(() => {
    const sortOrder = Number(get<{ next: number }>("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM roles")?.next ?? 0);
    run(
      "INSERT INTO roles (id, name, title, hourly_rate, is_system, sort_order) VALUES (?, ?, ?, ?, 0, ?)",
      id,
      name,
      title,
      Math.max(0, Math.round(input.hourlyRate ?? 0)),
      sortOrder,
    );
    for (const permission of permissions) {
      run("INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)", id, permission);
    }
  });
  audit(actor, "admin.role.create", "role", id, `${title}: ${permissions.length} permission(s)`);
  return getRoles().find((entry) => entry.id === id)!;
}

/** Replace a role's complete permission set. */
export function setRolePermissions(roleId: string, permissions: string[], actor: SessionUser | null): RoleInfo {
  const role = get<{ id: string; name: string }>("SELECT id, name FROM roles WHERE id = ?", roleId);
  if (!role) throw notFound("Role not found");
  if (role.name === "manager" && (!permissions.includes("admin.users") || !permissions.includes("admin.settings"))) {
    throw badRequest("General Manager must retain user and settings administration to prevent a lockout");
  }
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
