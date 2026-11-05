/**
 * Session, bootstrap and settings routes.
 *
 * Sign-in is public (there is no session yet); everything else here requires an
 * authenticated employee. Cookies are HTTP-only, SameSite=Lax and Secure outside
 * demo mode, matching the fail-closed rule for production.
 */
import { NextResponse } from "next/server";
import { publicRoute, route, badRequest } from "@/server/router";
import { signInWithPin, getStaff, auditTrail } from "@/server/staff";
import { buildBootstrap, buildMetrics } from "@/server/state";
import { getRawSettings, getSettings, getStations, setSettings } from "@/server/settings";
import { bool, q, qInt, required } from "@/server/coerce";
import { routeTable } from "@/server/router";
import { CSRF_COOKIE, SESSION_COOKIE, issueToken, newCsrfToken, isProduction } from "@/lib/session";
import { TENANT_COOKIE } from "@/lib/session-keys";
import { audit } from "@/server/audit";
import { DENOMINATIONS, rangePresets } from "@/server/reports";
import { TENDER_METHODS, cashSuggestions } from "@/domain/checkout";
import { tipSuggestions } from "@/domain/pricing";
import { productionSetupStatus } from "@/server/bootstrap";
import {
  countTenants,
  getTenantByCode,
  runWithTenant,
  singleActiveTenant,
  tenantDirectory,
  tenantDirectoryEnabled,
  type Tenant,
} from "@/server/tenant";
import { platformSetupRequired } from "@/server/platform";
import { planUsage } from "@/server/plan";
import { PLAN_DEFINITIONS } from "@/domain/plans";
import { SIGNIN_POLICY, assertNotBlocked, clearAuthFailures, recordAuthFailure } from "@/server/rate-limit";

const COOKIE_BASE = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: isProduction(),
  path: "/",
};

// ---------------------------------------------------------------------- sign-in
/**
 * PIN sign-in is scoped to one restaurant. A PIN is only unique inside its own
 * store, so the request must name the restaurant — either explicitly (the PIN
 * pad's restaurant picker) or implicitly because this deployment serves exactly
 * one active restaurant.
 */
publicRoute("POST", "session/signin", ({ body, ip }) => {
  const pin = required(body, "pin", "PIN");
  // Deliberately not `required`: a single-restaurant deployment needs no code.
  const code = String(body.restaurant ?? body.tenantCode ?? "").trim();
  const tenant: Tenant | null = code ? getTenantByCode(code) : singleActiveTenant();
  if (!tenant) {
    throw badRequest(
      code
        ? `No restaurant uses the code "${code}". Check the code with your manager.`
        : "Enter your restaurant code to sign in.",
    );
  }
  if (tenant.status !== "active") {
    throw badRequest(`${tenant.name} is suspended. Contact your platform administrator.`);
  }

  // Throttle per client + restaurant: five wrong PINs start a 15 minute block.
  const attemptKey = `staff:${tenant.id}:${ip}`;
  assertNotBlocked(attemptKey, SIGNIN_POLICY);

  const clockIn = bool(body, "clockIn", false);
  let user;
  try {
    ({ user } = runWithTenant(tenant, () => signInWithPin(pin, clockIn)));
  } catch (error) {
    recordAuthFailure(attemptKey, SIGNIN_POLICY);
    throw error;
  }
  clearAuthFailures(attemptKey);

  const token = issueToken(user.id, { tenantId: tenant.id });
  const csrf = newCsrfToken();
  const response = NextResponse.json({
    user,
    csrfToken: csrf,
    demoMode: !isProduction(),
    tenant: { id: tenant.id, code: tenant.code, name: tenant.name, tagline: tenant.tagline },
  });
  response.cookies.set(SESSION_COOKIE, token, { ...COOKIE_BASE, maxAge: 60 * 60 * 12 });
  // The CSRF token must be readable by the client script, so it is not httpOnly.
  response.cookies.set(CSRF_COOKIE, csrf, { ...COOKIE_BASE, httpOnly: false, maxAge: 60 * 60 * 12 });
  // Remember the restaurant for guest/CFD pages opened from this terminal.
  response.cookies.set(TENANT_COOKIE, tenant.code, {
    ...COOKIE_BASE,
    maxAge: 60 * 60 * 24 * 180,
  });
  return response;
});

publicRoute("POST", "session/signout", ({ anonymous }) => {
  if (anonymous) audit(anonymous, "auth.signout", "employee", anonymous.id, null);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 });
  response.cookies.set(CSRF_COOKIE, "", { ...COOKIE_BASE, httpOnly: false, maxAge: 0 });
  return response;
});

publicRoute("GET", "session", () => ({
  user: null,
  csrfToken: null,
  demoMode: !isProduction(),
  // "Setup required" now means the platform has no super admin yet; individual
  // restaurants are created from the platform console, not from `/setup`.
  setupRequired: platformSetupRequired() && countTenants() === 0,
  legacySetupRequired: productionSetupStatus().required,
  restaurantDirectory: tenantDirectoryEnabled(),
}));

/**
 * Demo-only PIN hints. Production never returns a PIN to the browser; this
 * endpoint exists so the seeded sample restaurant keeps its documented PIN pad
 * and is scoped to the selected restaurant.
 */
publicRoute("GET", "session/demo-pins", ({ query }) => {
  if (isProduction()) return { staff: [], demoMode: false };
  const code = q(query, "restaurant");
  const tenant = code ? getTenantByCode(code) : singleActiveTenant();
  if (!tenant) return { staff: [], demoMode: true };
  return { staff: runWithTenant(tenant, () => getStaff()).filter((member) => member.pin), demoMode: true };
});

/**
 * Restaurant picker for the PIN pad. Only the code, name and tagline are
 * public; `RMS_TENANT_DIRECTORY=0` hides even those on shared deployments.
 */
publicRoute("GET", "session/tenants", () => {
  const single = singleActiveTenant();
  return {
    tenants: tenantDirectoryEnabled() ? tenantDirectory() : [],
    single: single ? { code: single.code, name: single.name, tagline: single.tagline } : null,
    directoryEnabled: tenantDirectoryEnabled(),
  };
});

// -------------------------------------------------------------------- bootstrap
route("GET", "bootstrap", null, ({ anonymous, query }) => buildBootstrap(anonymous, q(query, "csrf") || null));

route("GET", "metrics", null, () => buildMetrics());

route("GET", "state/staff", "pos.open", () => ({ staff: getStaff() }));

/** Plan capacity for the current restaurant (seats, module caps). */
route("GET", "plan", null, () => ({
  plan: planUsage(),
  catalogue: PLAN_DEFINITIONS,
}));

// --------------------------------------------------------------------- settings
route("GET", "settings", "admin.settings", () => ({
  settings: getSettings(),
  raw: getRawSettings(),
  stations: getStations(),
}));

route("PATCH", "settings", "admin.settings", ({ body, user }) => {
  const patch: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) patch[key] = value.join(",");
    else if (typeof value === "boolean") patch[key] = value ? "1" : "0";
    else patch[key] = String(value);
  }
  if (!Object.keys(patch).length) throw badRequest("Nothing to update");
  const raw = setSettings(patch, user);
  return { settings: getSettings(), raw, stations: getStations() };
});

route("GET", "stations", null, () => ({ stations: getStations() }));

// ------------------------------------------------------------------- reference
/** Lookup data the client needs for dropdowns and validation hints. */
route("GET", "reference", null, () => {
  const settings = getSettings();
  return {
    tenders: TENDER_METHODS,
    tipPresets: tipSuggestions(10000, settings.tipPresets),
    cashSteps: cashSuggestions(123456).map((step) => step.label),
    denominations: DENOMINATIONS,
    ranges: rangePresets(),
    stations: getStations(),
    courses: ["appetizer", "entree", "drink", "dessert"],
    routes: routeTable().length,
  };
});

route("GET", "audit", "admin.users", ({ query }) => ({
  entries: auditTrail(qInt(query, "limit", 60)),
}));

// Health check used by the preview and by monitoring.
publicRoute("GET", "health", () => ({ ok: true, time: new Date().toISOString() }));
