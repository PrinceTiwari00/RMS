/**
 * Plan enforcement for the restaurant in the current tenant scope.
 *
 * Reads the registry row so a plan change applies on the very next request —
 * permissions are already re-read from the database every request, so this
 * adds no new caching problem.
 */
import { currentTenantScope, get } from "@/db/client";
import { badRequest } from "@/server/errors";
import { getTenantById, type Tenant } from "@/server/tenant";
import { applyPlanToPermissions, planFor, planStaffLimit, type PlanDefinition } from "@/domain/plans";
import type { Permission } from "@/domain/permissions";

export function scopedTenant(): Tenant | null {
  const scope = currentTenantScope();
  return scope ? getTenantById(scope.tenantId) : null;
}

/** The plan of the restaurant being served, or null outside a tenant scope. */
export function currentPlan(): PlanDefinition | null {
  const tenant = scopedTenant();
  return tenant ? planFor(tenant.plan) : null;
}

/** Hide permissions the restaurant's plan does not include. */
export function applyPlan(permissions: readonly Permission[]): Permission[] {
  const tenant = scopedTenant();
  if (!tenant) return [...permissions];
  return applyPlanToPermissions(tenant.plan, permissions);
}

export function seatLimit(): number | null {
  const tenant = scopedTenant();
  return tenant ? planStaffLimit(tenant.plan) : null;
}

/**
 * Block adding or reactivating staff beyond the plan's seat count.
 * Deactivating is always allowed, so a downgrade never traps an administrator.
 */
export function assertSeatAvailable(additional = 1): void {
  const limit = seatLimit();
  if (limit === null) return;
  const active = Number(
    get<{ count: number }>("SELECT COUNT(*) AS count FROM employees WHERE is_active = 1")?.count ?? 0,
  );
  if (active + additional > limit) {
    const tenant = scopedTenant();
    throw badRequest(
      `${tenant?.name ?? "This restaurant"} is on the ${currentPlan()?.name ?? "current"} plan, which allows ${limit} active staff. ` +
        "Deactivate an employee or ask your platform administrator to change the plan.",
    );
  }
}

export interface PlanUsage {
  plan: PlanDefinition;
  activeStaff: number;
  staffLimit: number | null;
}

/** Small payload for the settings/users screens. */
export function planUsage(): PlanUsage | null {
  const plan = currentPlan();
  if (!plan) return null;
  const activeStaff = Number(
    get<{ count: number }>("SELECT COUNT(*) AS count FROM employees WHERE is_active = 1")?.count ?? 0,
  );
  return { plan, activeStaff, staffLimit: plan.maxStaff };
}
