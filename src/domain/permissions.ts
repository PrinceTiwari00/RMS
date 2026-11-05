/**
 * Role-based access control.
 *
 * Permissions are coarse-grained capability strings stored per role. Every
 * mutating API route calls `requirePermission`, and the navigation shell hides
 * anything the signed-in employee cannot open — so the UI and the API can never
 * disagree about what a Cashier is allowed to do.
 */

export const PERMISSIONS = {
  // Front of house
  "pos.open": "Open and edit tickets",
  "pos.send": "Send tickets to the kitchen",
  "pos.fire": "Fire held courses",
  "pos.void": "Void items (audited)",
  "pos.discount": "Apply discounts (audited)",
  "pos.checkout": "Take payment and close a check",
  "pos.split": "Split checks",
  "host.seat": "Seat parties and manage the floor plan",
  "host.waitlist": "Manage the waitlist and reservations",

  // Back of house
  "kds.view": "View kitchen display",
  "kds.ready": "Mark items ready",
  "kds.bump": "Bump assembled tickets at expo",
  "kds.prep": "View recipe and prep sheets",

  // Back office — configuration
  "admin.menu": "Edit the menu, categories and modifiers",
  "admin.floorplan": "Edit the floor plan layout",
  "admin.users": "Manage employees, PINs and permissions",
  "admin.settings": "Change business settings and terminals",

  // Back office — inventory and supply chain
  "admin.inventory": "Manage inventory items and stock",
  "admin.recipes": "Manage recipe costing / bill of materials",
  "admin.purchasing": "Create, approve and receive purchase orders",
  "admin.waste": "Log waste and reconcile counts",

  // Back office — labour
  "admin.schedule": "Build and publish the shift schedule",
  "admin.timeclock": "Audit and edit timesheets",

  // Back office — reporting
  "reports.executive": "View the executive financial dashboard",
  "reports.pmix": "View the product mix report",
  "reports.zreport": "Run end-of-day reconciliation",

  // Customer facing
  "guest.cfd": "Operate the customer facing display",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  {
    label: "Front of house",
    permissions: ["pos.open", "pos.send", "pos.fire", "pos.void", "pos.discount", "pos.checkout", "pos.split", "host.seat", "host.waitlist"],
  },
  { label: "Back of house", permissions: ["kds.view", "kds.ready", "kds.bump", "kds.prep"] },
  {
    label: "Back office — configuration",
    permissions: ["admin.menu", "admin.floorplan", "admin.users", "admin.settings"],
  },
  {
    label: "Back office — inventory & supply chain",
    permissions: ["admin.inventory", "admin.recipes", "admin.purchasing", "admin.waste"],
  },
  { label: "Back office — labour", permissions: ["admin.schedule", "admin.timeclock"] },
  { label: "Back office — reporting", permissions: ["reports.executive", "reports.pmix", "reports.zreport"] },
  { label: "Customer facing", permissions: ["guest.cfd"] },
];

export interface RoleDefinition {
  name: string;
  title: string;
  /** paisa per hour */
  hourlyRate: number;
  permissions: Permission[];
}

const ALL = Object.keys(PERMISSIONS) as Permission[];

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  { name: "manager", title: "General Manager", hourlyRate: 45000, permissions: ALL },
  {
    name: "server",
    title: "Server",
    hourlyRate: 22000,
    permissions: [
      "pos.open",
      "pos.send",
      "pos.fire",
      "pos.checkout",
      "pos.split",
      "host.seat",
      "kds.view",
      "kds.prep",
    ],
  },
  {
    name: "cashier",
    title: "Cashier",
    hourlyRate: 24000,
    permissions: ["pos.open", "pos.send", "pos.checkout", "pos.split", "pos.discount", "kds.view"],
  },
  {
    name: "host",
    title: "Host / Hostess",
    hourlyRate: 20000,
    permissions: ["host.seat", "host.waitlist", "pos.open", "kds.view"],
  },
  {
    name: "shift_lead",
    title: "Shift Lead",
    hourlyRate: 30000,
    permissions: [
      "pos.open",
      "pos.send",
      "pos.fire",
      "pos.void",
      "pos.discount",
      "pos.checkout",
      "pos.split",
      "host.seat",
      "host.waitlist",
      "kds.view",
      "kds.ready",
      "kds.bump",
      "kds.prep",
      "admin.timeclock",
      "reports.zreport",
    ],
  },
  {
    name: "cook",
    title: "Line Cook",
    hourlyRate: 21000,
    permissions: ["kds.view", "kds.ready", "kds.prep"],
  },
  {
    name: "expo",
    title: "Expeditor",
    hourlyRate: 26000,
    permissions: ["kds.view", "kds.ready", "kds.bump", "kds.prep", "pos.fire"],
  },
  {
    name: "bartender",
    title: "Bartender",
    hourlyRate: 23000,
    permissions: ["kds.view", "kds.ready", "pos.open", "pos.send", "pos.checkout"],
  },
];

export function permissionsFor(role: string, granted?: Iterable<string>): Permission[] {
  // A persisted role matrix is authoritative: grants can be removed as well as
  // added. The curated definition is only a fallback for legacy rows that have
  // never been seeded or edited.
  if (granted !== undefined) {
    const stored = new Set(granted);
    return ALL.filter((permission) => stored.has(permission) || stored.has("*"));
  }
  const definition = ROLE_DEFINITIONS.find((candidate) => candidate.name === role);
  return definition ? [...definition.permissions] : [];
}

export function can(permissions: Iterable<string>, permission: Permission): boolean {
  const set = permissions instanceof Set ? permissions : new Set(permissions);
  return set.has(permission) || set.has("*");
}

/** Nav visibility: which workspace sections a role can see at all. */
export function workspaceFor(permissions: Iterable<string>): {
  foh: boolean;
  boh: boolean;
  admin: boolean;
  customer: boolean;
} {
  const has = (list: Permission[]) => list.some((permission) => can(permissions, permission));
  return {
    foh: has(["pos.open", "pos.checkout", "host.seat", "host.waitlist"]),
    boh: has(["kds.view", "kds.ready", "kds.bump"]),
    admin: has([
      "admin.menu",
      "admin.inventory",
      "admin.schedule",
      "reports.executive",
      "reports.pmix",
      "reports.zreport",
      "admin.users",
    ]),
    customer: has(["guest.cfd", "admin.settings"]),
  };
}
