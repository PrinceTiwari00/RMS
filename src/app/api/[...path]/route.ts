/**
 * Single catch-all API entry point.
 *
 * Every endpoint is registered in `src/server/routes`, so authentication, CSRF,
 * permission checks, tenant binding, validation errors and JSON encoding all
 * happen exactly once here instead of being repeated across forty route files.
 *
 * The order matters:
 *   1. `/api/platform/*` talks to the control plane only (super admin).
 *   2. `/api/setup/*` is the legacy single-store first-run path.
 *   3. everything else resolves a restaurant and runs the handler inside that
 *      restaurant's database scope.
 */
import { NextRequest, NextResponse } from "next/server";
import { dispatch, dispatchPlatform, errorResponse, type DispatchResult } from "@/server/router";
import { loadUser } from "@/server/identity";
import { getPlatformUser } from "@/server/platform";
import { resolveRequestTenant } from "@/server/request-tenant";
import { getTenantById, tenantScope, type Tenant } from "@/server/tenant";
import {
  TENANT_COOKIE,
  csrfHeaderMatches,
  platformCsrfHeaderMatches,
  readPlatformSession,
  readSession,
  type CookieJar,
} from "@/lib/session";
import { ensureDatabase } from "@/db/boot";
import { withTenant } from "@/db/client";
import "@/server/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Mutating verbs need a CSRF token when a session is present. */
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Prefixes that are not scoped to a restaurant database. */
const CONTROL_PREFIXES = new Set(["platform", "setup", "health", "session"]);

interface RouteContext {
  params: Promise<{ path?: string[] }>;
}

/** Proxy-aware client address for sign-in throttling. */
function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function parseBody(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  return { value: parsed };
}

function tenantCookie(tenant: Tenant, jar: CookieJar): { name: string; value: string; options: Record<string, unknown> } | null {
  if (jar.get(TENANT_COOKIE)?.value === tenant.code) return null;
  return {
    name: TENANT_COOKIE,
    value: tenant.code,
    options: {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production" && process.env.RMS_ENV !== "demo",
      path: "/",
      maxAge: 60 * 60 * 24 * 180,
    },
  };
}

async function handle(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const resolved = await context.params;
  const segments = (resolved?.path ?? []).filter(Boolean);
  const method = request.method.toUpperCase();
  const jar: CookieJar = { get: (name) => request.cookies.get(name) };
  const ip = clientIp(request);

  try {
    ensureDatabase();
  } catch (error) {
    console.error("[rms] database unavailable", error);
    const configurationError = error instanceof Error && error.message.startsWith("RMS_SECRET_KEY");
    return NextResponse.json(
      {
        error: configurationError
          ? (error as Error).message
          : "The database could not be opened. Check RMS_DB_PATH, filesystem permissions and available disk space.",
      },
      { status: 500 },
    );
  }

  // ------------------------------------------------------------- platform (super admin)
  if (segments[0] === "platform") {
    const platformSession = readPlatformSession(jar);
    const admin = platformSession ? getPlatformUser(platformSession.uid) : null;

    if (admin && MUTATING.has(method) && !platformCsrfHeaderMatches(jar, request.headers)) {
      return NextResponse.json(
        { error: "Your platform session expired — reload and sign in again" },
        { status: 403 },
      );
    }

    let body: Record<string, unknown> = {};
    if (MUTATING.has(method)) {
      try {
        body = parseBody(await request.text());
      } catch {
        return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
      }
    }

    let result: DispatchResult;
    try {
      result = await dispatchPlatform({
        method,
        segments: segments.slice(1),
        query: request.nextUrl.searchParams,
        body,
        admin,
        ip,
      });
    } catch (error) {
      return errorResponse(error);
    }
    if (result.kind === "no-match") {
      return NextResponse.json({ error: `No API route for ${method} /api/${segments.join("/")}` }, { status: 404 });
    }
    return result.response;
  }

  let body: Record<string, unknown> = {};
  if (MUTATING.has(method)) {
    try {
      body = parseBody(await request.text());
    } catch {
      return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
    }
  }

  // ------------------------------------------- legacy single-store setup + health
  if (CONTROL_PREFIXES.has(segments[0] ?? "")) {
    const user = (() => {
      const session = readSession(jar);
      if (!session) return null;
      // A tenant session still resolves its restaurant so sign-out and the
      // legacy setup routes can attribute the action to the right employee.
      const tenant = session.tenantId ? getTenantById(session.tenantId) : null;
      return tenant ? withTenant(tenantScope(tenant), () => loadUser(session.uid)) : loadUser(session.uid);
    })();
    if (user && MUTATING.has(method) && !isPublicPrefix(segments[0]) && !csrfHeaderMatches(jar, request.headers)) {
      return NextResponse.json({ error: "Your session expired — reload the page and sign in again" }, { status: 403 });
    }
    let result: DispatchResult;
    try {
      result = await dispatch({ method, segments, query: request.nextUrl.searchParams, body, user, ip });
    } catch (error) {
      return errorResponse(error);
    }
    if (result.kind === "no-match") {
      return NextResponse.json({ error: `No API route for ${method} /api/${segments.join("/")}` }, { status: 404 });
    }
    return result.response;
  }

  // ------------------------------------------------------------- restaurant scope
  const session = readSession(jar);
  const resolution = resolveRequestTenant({
    segments,
    query: request.nextUrl.searchParams,
    jar,
    session,
    body,
  });

  if (!resolution.tenant) {
    const message =
      resolution.reason === "unknown-token"
        ? "This table token is not recognized. Ask a staff member for a new QR code."
        : resolution.reason === "no-tenants"
          ? "No restaurants exist yet. Create one in the platform console."
          : "Unknown restaurant. Open the link or QR code for your own restaurant, or add ?tenant=<code>.";
    return NextResponse.json({ error: message }, { status: 404 });
  }

  const tenant = resolution.tenant;
  if (tenant.status !== "active") {
    return NextResponse.json(
      { error: `${tenant.name} is suspended. Contact the platform administrator.` },
      { status: 403 },
    );
  }

  const user = session ? withTenant(tenantScope(tenant), () => loadUser(session.uid)) : null;

  if (MUTATING.has(method) && user && !isPublicPrefix(segments[0]) && !csrfHeaderMatches(jar, request.headers)) {
    // The header is mandatory. Reading the token back out of the Cookie header
    // would make a cross-site request satisfy its own double-submit check.
    return NextResponse.json({ error: "Your session expired — reload the page and sign in again" }, { status: 403 });
  }

  let result: DispatchResult;
  try {
    result = await withTenant(tenantScope(tenant), () =>
      dispatch({ method, segments, query: request.nextUrl.searchParams, body, user, ip }),
    );
  } catch (error) {
    return errorResponse(error);
  }

  if (result.kind === "no-match") {
    return NextResponse.json({ error: `No API route for ${method} /api/${segments.join("/")}` }, { status: 404 });
  }

  // Keep the convenience cookie aligned with the signed session so guest and
  // display pages opened in this browser land on the same restaurant.
  const adjustment = tenantCookie(tenant, jar);
  if (adjustment) result.response.cookies.set(adjustment.name, adjustment.value, adjustment.options);
  return result.response;
}

function isPublicPrefix(prefix: string | undefined): boolean {
  return prefix === "guest" || prefix === "cfd" || prefix === "session" || prefix === "setup" || prefix === "platform";
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
