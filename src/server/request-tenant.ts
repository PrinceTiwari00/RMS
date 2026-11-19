/**
 * Which restaurant does this request belong to?
 *
 * Every operational table lives in a per-restaurant SQLite file, so the request
 * must be bound to exactly one tenant before any service code runs. Resolution
 * is ordered from most to least authoritative:
 *
 *   1. the signed tenant id inside the staff session (cannot be forged),
 *   2. the guest QR token in the path,
 *   3. an explicit `?tenant=<code>` query or body parameter,
 *   4. the `rms_tenant` convenience cookie (guest pages, CFD),
 *   5. the only active restaurant, when the deployment has exactly one.
 */
import { cookies } from "next/headers";
import { get, withTenant } from "@/db/client";
import { TENANT_COOKIE } from "@/lib/session-keys";
import { readSession, type CookieJar, type StaffSession } from "@/lib/session";
import { loadUser, type SessionUser } from "@/server/identity";
import {
  findTenantByGuestToken,
  getTenantByCode,
  getTenantById,
  listTenants,
  singleActiveTenant,
  tenantScope,
  type Tenant,
} from "@/server/tenant";

export interface TenantResolution {
  tenant: Tenant | null;
  /** Why no restaurant matched, for a precise client error. */
  reason?: "no-tenants" | "unknown-tenant" | "unknown-token";
}

export function resolveRequestTenant(input: {
  segments: string[];
  query: URLSearchParams;
  jar: CookieJar;
  session?: StaffSession | null;
  /** Body of the request, so sign-in can name its restaurant. */
  body?: Record<string, unknown>;
}): TenantResolution {
  const session = input.session ?? readSession(input.jar);
  if (session?.tenantId) {
    const tenant = getTenantById(session.tenantId);
    return tenant ? { tenant } : { tenant: null, reason: "unknown-tenant" };
  }

  if (input.segments[0] === "guest" && input.segments[1]) {
    const tenant = findTenantByGuestToken(input.segments[1]);
    return tenant ? { tenant } : { tenant: null, reason: "unknown-token" };
  }

  const queryCode = input.query.get("tenant");
  if (queryCode) {
    const tenant = getTenantByCode(queryCode);
    if (tenant) return { tenant };
  }

  const bodyCode = input.body?.restaurant ?? input.body?.tenantCode ?? input.body?.tenant;
  if (typeof bodyCode === "string" && bodyCode.trim()) {
    const tenant = getTenantByCode(bodyCode);
    if (tenant) return { tenant };
  }

  const cookieCode = input.jar.get(TENANT_COOKIE)?.value;
  if (cookieCode) {
    const tenant = getTenantByCode(cookieCode);
    if (tenant) return { tenant };
  }

  const single = singleActiveTenant();
  if (single) return { tenant: single };
  return { tenant: null, reason: listTenants().length ? "unknown-tenant" : "no-tenants" };
}

export interface StaffContext {
  tenant: Tenant;
  session: StaffSession;
  user: SessionUser;
}

/**
 * Server-component helper: the signed-in employee plus the restaurant that owns
 * their session. The database is scoped for the duration of `loadUser`, which
 * re-reads permissions from the tenant's own role matrix.
 */
export async function currentStaffContext(): Promise<StaffContext | null> {
  const jar = await cookies();
  const readable: CookieJar = { get: (name) => jar.get(name) };
  const session = readSession(readable);
  if (!session) return null;

  const resolution = resolveRequestTenant({ segments: [], query: new URLSearchParams(), jar: readable, session });
  const tenant = resolution.tenant;
  if (!tenant || tenant.status !== "active") return null;

  const user = withTenant(tenantScope(tenant), () => loadUser(session.uid));
  if (!user) return null;
  return { tenant, session, user };
}

/** Public guest/CFD helper: the tenant owning a token or the single restaurant. */
export function resolvePublicTenant(token?: string): Tenant | null {
  if (token) {
    const tenant = findTenantByGuestToken(token);
    return tenant;
  }
  return singleActiveTenant();
}

/** Read the tenant's store name without assuming a scope (used by the console). */
export function tenantDisplayName(tenantId: string): string | null {
  const tenant = getTenantById(tenantId);
  if (!tenant) return null;
  try {
    return withTenant(tenantScope(tenant), () => get<{ value: string }>("SELECT value FROM settings WHERE key = 'restaurant_name'")?.value ?? tenant.name);
  } catch {
    return tenant.name;
  }
}
