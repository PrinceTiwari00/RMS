/**
 * Plan definitions.
 *
 * A plan is a *capacity and module* contract, not a second permission system:
 * the restaurant's role matrix still decides who may do what, and the plan then
 * caps what the restaurant is entitled to at all. Effective permissions are
 * `role permissions ∩ plan permissions`.
 *
 * Pure data + helpers so both the server (enforcement) and the console (labels)
 * can share it.
 */
import type { Permission } from "@/domain/permissions";

export type PlanId = "free" | "standard" | "pro";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  summary: string;
  /** `null` = unlimited. */
  maxStaff: number | null;
  /** `null` = every permission the role matrix grants. */
  permissions: Permission[] | null;
  /** Human-readable highlights for the console and docs. */
  highlights: string[];
}

const CORE_SERVICE: Permission[] = [
  "pos.open",
  "pos.send",
  "pos.fire",
  "pos.void",
  "pos.checkout",
  "pos.split",
  "host.seat",
  "host.waitlist",
  "kds.view",
  "kds.ready",
  "kds.bump",
  "kds.prep",
  "guest.cfd",
  "admin.menu",
  "admin.users",
  "admin.settings",
  "reports.zreport",
];

export const PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    id: "free",
    name: "Starter",
    summary: "Core service, menu and staff. No back-office supply chain or analytics.",
    maxStaff: 8,
    permissions: CORE_SERVICE,
    highlights: ["POS, floor, kitchen and QR ordering", "Menu, staff and settings", "Up to 8 active staff"],
  },
  {
    id: "standard",
    name: "Standard",
    summary: "Full restaurant back office: inventory, purchasing, labour and analytics.",
    maxStaff: 30,
    permissions: null,
    highlights: ["Everything in Starter", "Inventory, recipes, purchasing, waste", "Scheduling, time clock, executive reporting", "Up to 30 active staff"],
  },
  {
    id: "pro",
    name: "Pro",
    summary: "Unlimited staff and every module — the hosted multi-terminal tier.",
    maxStaff: null,
    permissions: null,
    highlights: ["Everything in Standard", "Unlimited active staff", "No module caps"],
  },
];

export function planFor(id: string | null | undefined): PlanDefinition {
  return PLAN_DEFINITIONS.find((plan) => plan.id === id) ?? PLAN_DEFINITIONS[1];
}

/** `null` means "no plan restriction" (standard/pro today). */
export function planPermissionSet(id: string | null | undefined): Set<Permission> | null {
  const plan = planFor(id);
  return plan.permissions ? new Set(plan.permissions) : null;
}

/** Filter a role's permissions down to what the plan allows. */
export function applyPlanToPermissions(
  id: string | null | undefined,
  permissions: Iterable<Permission>,
): Permission[] {
  const allowed = planPermissionSet(id);
  if (!allowed) return [...permissions];
  return [...permissions].filter((permission) => allowed.has(permission));
}

export function planStaffLimit(id: string | null | undefined): number | null {
  return planFor(id).maxStaff;
}
