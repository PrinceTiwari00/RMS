/**
 * Identity: resolve the signed-in employee, their role and their effective
 * permissions. Permissions are re-read on every request so an admin revoking
 * access takes effect without anybody having to sign out.
 */
import { all, get } from "@/db/client";
import { permissionsFor, type Permission } from "@/domain/permissions";
import { readSession, type CookieJar } from "@/lib/session";

export interface SessionUser {
  id: string;
  name: string;
  initials: string;
  color: string;
  role: string;
  roleTitle: string;
  permissions: Permission[];
}

interface EmployeeRow {
  id: string;
  name: string;
  initials: string;
  color: string;
  is_active: number;
  role_name: string | null;
  role_title: string | null;
}

export function loadUser(employeeId: string): SessionUser | null {
  const row = get<EmployeeRow>(
    `SELECT e.id, e.name, e.initials, e.color, e.is_active, r.name AS role_name, r.title AS role_title
       FROM employees e LEFT JOIN roles r ON r.id = e.role_id
      WHERE e.id = ?`,
    employeeId,
  );
  if (!row || !row.is_active) return null;
  const roleName = row.role_name ?? "server";
  // A role's effective set = the curated defaults for that role, plus any
  // individually granted extras stored in role_permissions.
  const permissions = (
    all<{ permission: string }>(
      `SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.name = ?`,
      roleName,
    ) ?? []
  ).map((entry) => entry.permission);
  return {
    id: row.id,
    name: row.name,
    initials: row.initials || initialsOf(row.name),
    color: row.color,
    role: roleName,
    roleTitle: row.role_title ?? roleName,
    permissions: permissionsFor(roleName, permissions),
  };
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function userFromJar(jar: CookieJar): SessionUser | null {
  const session = readSession(jar);
  if (!session) return null;
  return loadUser(session.uid);
}

/** Manager override: a signed-in manager may act on behalf of the system. */
export function auditActor(user: SessionUser | null): { id: string | null; name: string } {
  return { id: user?.id ?? null, name: user?.name ?? "system" };
}
