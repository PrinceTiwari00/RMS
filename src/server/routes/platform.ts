/**
 * Super-admin (platform) API.
 *
 * These endpoints manage the restaurant registry and are authorized by a
 * platform session cookie only — never by a staff PIN, and never by a
 * restaurant permission. The tenant routes in this registry exist nowhere else:
 * a restaurant manager cannot create, suspend or inspect another restaurant.
 */
import { NextResponse } from "next/server";
import { created, platformRoute } from "@/server/router";
import {
  DEMO_PLATFORM_EMAIL,
  DEMO_PLATFORM_PASSWORD,
  createPlatformUser,
  getPlatformUser,
  listPlatformUsers,
  platformSetupStatus,
  platformAudit,
  recentPlatformAudit,
  signInPlatform,
  updatePlatformUser,
  type PlatformUser,
} from "@/server/platform";
import {
  countTenants,
  createTenant,
  getTenantById,
  listTenants,
  publicTenant,
  resetTenantAdminPin,
  tenantDirectoryEnabled,
  updateTenant,
} from "@/server/tenant";
import { optBool, optStr, qInt, required } from "@/server/coerce";
import { badRequest, notFound } from "@/server/errors";
import {
  SIGNIN_POLICY,
  SETUP_POLICY,
  assertNotBlocked,
  clearAuthFailures,
  recordAuthFailure,
} from "@/server/rate-limit";
import {
  PLATFORM_CSRF_COOKIE,
  PLATFORM_SESSION_COOKIE,
  isProduction,
  issueToken,
  newCsrfToken,
} from "@/lib/session";

const COOKIE_BASE = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: isProduction(),
  path: "/",
};

const PLATFORM_SESSION_MAX_AGE = 60 * 60 * 8;

function issuePlatformSession(user: PlatformUser): NextResponse {
  const token = issueToken(user.id, { scope: "platform" });
  const csrf = newCsrfToken();
  const response = NextResponse.json({
    user,
    csrfToken: csrf,
    demoMode: !isProduction(),
  });
  response.cookies.set(PLATFORM_SESSION_COOKIE, token, { ...COOKIE_BASE, maxAge: PLATFORM_SESSION_MAX_AGE });
  response.cookies.set(PLATFORM_CSRF_COOKIE, csrf, {
    ...COOKIE_BASE,
    httpOnly: false,
    maxAge: PLATFORM_SESSION_MAX_AGE,
  });
  return response;
}

function clearPlatformSession(): NextResponse {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(PLATFORM_SESSION_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 });
  response.cookies.set(PLATFORM_CSRF_COOKIE, "", { ...COOKIE_BASE, httpOnly: false, maxAge: 0 });
  return response;
}

// ------------------------------------------------------------------- public

platformRoute(
  "GET",
  "status",
  () => {
    const status = platformSetupStatus();
    return {
      ...status,
      restaurants: countTenants(),
      // Demo credentials are a documented convenience, never a production hint.
      demoCredentials: status.demoMode ? { email: DEMO_PLATFORM_EMAIL, password: DEMO_PLATFORM_PASSWORD } : null,
      tenantDirectory: tenantDirectoryEnabled(),
    };
  },
  { requiresAuth: false },
);

platformRoute(
  "GET",
  "session",
  ({ admin }) => ({
    user: admin,
    ...platformSetupStatus(),
    demoCredentials: !isProduction() ? { email: DEMO_PLATFORM_EMAIL, password: DEMO_PLATFORM_PASSWORD } : null,
  }),
  { requiresAuth: false },
);

platformRoute(
  "POST",
  "setup",
  ({ body, ip }) => {
    const attemptKey = `platform-setup:${ip}`;
    assertNotBlocked(attemptKey, SETUP_POLICY);
    let user;
    try {
      user = createPlatformUser({
        name: required(body, "name", "Your name"),
        email: required(body, "email", "Email"),
        password: required(body, "password", "Password"),
        setupToken: optStr(body, "setupToken"),
        firstAccount: true,
      });
    } catch (error) {
      // Only a rejected token should consume the allowance; a validation error
      // on the form is not a guess at the deployment secret.
      if (error instanceof Error && /setup token/i.test(error.message)) recordAuthFailure(attemptKey, SETUP_POLICY);
      throw error;
    }
    clearAuthFailures(attemptKey);
    return issuePlatformSession(user);
  },
  { requiresAuth: false },
);

platformRoute(
  "POST",
  "signin",
  ({ body, ip }) => {
    const email = required(body, "email", "Email");
    const password = required(body, "password", "Password");
    const attemptKey = `platform:${ip}:${email.trim().toLowerCase()}`;
    assertNotBlocked(attemptKey, SIGNIN_POLICY);
    let user;
    try {
      ({ user } = signInPlatform(email, password));
    } catch (error) {
      recordAuthFailure(attemptKey, SIGNIN_POLICY);
      throw error;
    }
    clearAuthFailures(attemptKey);
    return issuePlatformSession(user);
  },
  { requiresAuth: false },
);

platformRoute("POST", "signout", ({ admin }) => {
  if (admin) platformAudit(admin, "platform.signout", null, "");
  return clearPlatformSession();
}, { requiresAuth: false });

// ------------------------------------------------------------- restaurant CRUD

platformRoute("GET", "tenants", () => ({
  tenants: listTenants({ includeSuspended: true }).map(publicTenant),
  demoMode: !isProduction(),
}));

platformRoute("GET", "tenants/:id", ({ params }) => {
  const tenant = getTenantById(params.id);
  if (!tenant) throw notFound("Restaurant not found");
  return { tenant: publicTenant(tenant) };
});

platformRoute("POST", "tenants", ({ body, admin }) => {
  const { tenant, adminPin } = createTenant({
    name: required(body, "name", "Restaurant name"),
    code: optStr(body, "code"),
    tagline: optStr(body, "tagline"),
    adminName: required(body, "adminName", "Restaurant admin name"),
    adminPin: required(body, "adminPin", "Restaurant admin PIN"),
    contactName: optStr(body, "contactName"),
    contactEmail: optStr(body, "contactEmail"),
    contactPhone: optStr(body, "contactPhone"),
    plan: optStr(body, "plan"),
    notes: optStr(body, "notes"),
    starter: optStr(body, "starter") === "demo" ? "demo" : "blank",
    createdBy: admin?.id ?? null,
  });
  platformAudit(admin, "platform.tenant.create", tenant, `${tenant.name} (${tenant.code}) · plan ${tenant.plan}`);
  const view = publicTenant(tenant);
  return created({
    tenant: view,
    adminPin,
    handoff: {
      restaurantCode: tenant.code,
      signInUrl: `/login?restaurant=${encodeURIComponent(tenant.code)}`,
      adminName: tenant.adminName,
      note: "Share the restaurant code and admin PIN with the owner. The PIN is not stored in plaintext and will not be shown again.",
    },
  });
});

platformRoute("PATCH", "tenants/:id", ({ params, body, admin }) => {
  const before = getTenantById(params.id);
  if (!before) throw notFound("Restaurant not found");
  const tenant = updateTenant(params.id, {
    name: optStr(body, "name"),
    tagline: optStr(body, "tagline"),
    status: optStr(body, "status"),
    plan: optStr(body, "plan"),
    contactName: optStr(body, "contactName"),
    contactEmail: optStr(body, "contactEmail"),
    contactPhone: optStr(body, "contactPhone"),
    notes: optStr(body, "notes"),
  });
  const action =
    tenant.status !== before.status
      ? tenant.status === "suspended"
        ? "platform.tenant.suspend"
        : "platform.tenant.activate"
      : "platform.tenant.update";
  platformAudit(admin, action, tenant, tenant.status === before.status ? "profile updated" : `status → ${tenant.status}`);
  return { tenant: publicTenant(tenant) };
});

platformRoute("POST", "tenants/:id/reset-admin", ({ params, body, admin }) => {
  const pin = required(body, "pin", "New admin PIN");
  const tenant = resetTenantAdminPin(
    params.id,
    pin,
    { id: admin?.id ?? "", email: admin?.email ?? "" },
    optStr(body, "reason") ?? "",
  );
  platformAudit(admin, "platform.tenant.reset_admin", tenant, `admin PIN reset for ${tenant.name}`);
  return {
    tenant: publicTenant(tenant),
    adminPin: pin,
    handoff: {
      restaurantCode: tenant.code,
      signInUrl: `/login?restaurant=${encodeURIComponent(tenant.code)}`,
      adminName: tenant.adminName,
      note: "Give the new PIN to the restaurant owner directly; it is not stored in plaintext.",
    },
  };
});

// ------------------------------------------------------------------ operators

platformRoute("GET", "accounts", () => ({ accounts: listPlatformUsers() }));

platformRoute("POST", "accounts", ({ body, admin }) => {
  const user = createPlatformUser({
    name: required(body, "name", "Name"),
    email: required(body, "email", "Email"),
    password: required(body, "password", "Password"),
    firstAccount: false,
  });
  platformAudit(admin, "platform.account.create", null, user.email);
  return created({ account: user });
});

platformRoute("PATCH", "accounts/:id", ({ params, body, admin }) => {
  if (!admin) throw badRequest("Platform sign-in required");
  const account = updatePlatformUser(admin, params.id, {
    name: optStr(body, "name"),
    password: optStr(body, "password"),
    currentPassword: optStr(body, "currentPassword"),
    isActive: optBool(body, "isActive"),
  });
  return { account };
});

platformRoute("GET", "audit", ({ query }) => ({ entries: recentPlatformAudit(qInt(query, "limit", 60)) }));

platformRoute("GET", "me", ({ admin }) => {
  if (!admin) throw badRequest("Platform sign-in required");
  // Re-read so a deactivated operator loses access on the next request.
  const fresh = getPlatformUser(admin.id);
  if (!fresh) throw notFound("Platform account not found");
  return { user: fresh };
});

// The directory switch is surfaced so the console can explain the PIN pad
// behaviour when an operator hides restaurant names.
platformRoute("GET", "settings", () => ({
  tenantDirectory: tenantDirectoryEnabled(),
  production: isProduction(),
  demoMode: !isProduction(),
  setup: { required: platformSetupStatus().required, tokenConfigured: platformSetupStatus().tokenConfigured },
  flags: { publicDirectory: tenantDirectoryEnabled(), envProvisioned: platformSetupStatus().envProvisioned },
}));
