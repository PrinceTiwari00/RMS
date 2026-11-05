/**
 * Employee, role and permission routes.
 *
 * Everything here needs `admin.users` except the read-only staff list, which the
 * POS and the scheduler need to render avatar chips. PINs are accepted as plain
 * digits over HTTPS and stored hashed; the plain value is only ever echoed back
 * in demo mode so the login screen can show a hint.
 */
import { route, created, badRequest } from "@/server/router";
import {
  createEmployee,
  createRole,
  deactivateEmployee,
  getRoles,
  getStaff,
  getStaffMember,
  permissionCatalogue,
  roleTemplates,
  setRolePermissions,
  updateEmployee,
  updateRole,
} from "@/server/staff";
import { has, nullableStr, optBool, optStr, paisa, q, required, strArr } from "@/server/coerce";
import { ROLE_DEFINITIONS } from "@/domain/permissions";

route("GET", "staff", null, ({ query }) => ({
  staff: getStaff({
    includeInactive: q(query, "includeInactive") === "1",
    role: q(query, "role", "all"),
  }),
  roles: getRoles(),
}));

route("GET", "staff/:id", "admin.users", ({ params }) => {
  const member = getStaffMember(params.id);
  if (!member) throw badRequest("Employee not found");
  return { member };
});

route("POST", "staff", "admin.users", ({ body, user }) =>
  created(
    createEmployee(
      {
        name: required(body, "name", "Employee name"),
        roleId: nullableStr(body, "roleId"),
        pin: required(body, "pin", "A sign-in PIN"),
        color: optStr(body, "color"),
        phone: optStr(body, "phone"),
        isActive: optBool(body, "isActive"),
        hireDate: optStr(body, "hireDate"),
      },
      user,
    ),
  ),
);

route("PATCH", "staff/:id", "admin.users", ({ params, body, user }) => ({
  member: updateEmployee(
    params.id,
    {
      name: optStr(body, "name"),
      roleId: nullableStr(body, "roleId"),
      // An empty string means "leave the PIN alone"; a value re-hashes it.
      pin: optStr(body, "pin"),
      color: optStr(body, "color"),
      phone: optStr(body, "phone"),
      isActive: optBool(body, "isActive"),
      hireDate: optStr(body, "hireDate"),
    },
    user,
  ),
}));

/** Deactivate rather than delete: history must keep its actor. */
route("POST", "staff/:id/deactivate", "admin.users", ({ params, user }) => {
  deactivateEmployee(params.id, user);
  return { staff: getStaff({ includeInactive: true }) };
});

// ------------------------------------------------------------------------ roles
route("POST", "roles", "admin.users", ({ body, user }) =>
  created({
    role: createRole(
      {
        title: required(body, "title", "Role title"),
        name: optStr(body, "name"),
        hourlyRate: has(body, "hourlyRate") ? paisa(body, "hourlyRate") : 0,
        permissions: strArr(body, "permissions"),
      },
      user,
    ),
    roles: getRoles(),
  }),
);

route("GET", "roles", "admin.users", () => ({
  roles: getRoles(),
  catalogue: permissionCatalogue(),
  templates: roleTemplates(),
  definitions: ROLE_DEFINITIONS.map((definition) => ({
    name: definition.name,
    title: definition.title,
    hourlyRate: definition.hourlyRate,
    permissions: definition.permissions,
  })),
}));

route("PATCH", "roles/:id", "admin.users", ({ params, body, user }) => ({
  role: updateRole(
    params.id,
    { title: optStr(body, "title"), hourlyRate: has(body, "hourlyRate") ? paisa(body, "hourlyRate") : undefined },
    user,
  ),
}));

/** Granular RBAC: replace the role's individually granted permission set. */
route("PUT", "roles/:id/permissions", "admin.users", ({ params, body, user }) => ({
  role: setRolePermissions(params.id, strArr(body, "permissions"), user),
  roles: getRoles(),
}));
