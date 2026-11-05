/**
 * A very small pattern router for the `/api/[...path]` catch-all.
 *
 * Keeping every endpoint in one registry means authentication, CSRF, permission
 * checks, validation errors and JSON encoding are handled exactly once instead
 * of being repeated across forty route files.
 */
import { NextResponse } from "next/server";
import { can, type Permission } from "@/domain/permissions";
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
  unauthorized,
} from "@/server/errors";
import type { PlatformUser } from "@/server/platform";
import type { SessionUser } from "./identity";

export { ApiError, badRequest, conflict, forbidden, notFound, tooManyRequests, unauthorized };

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  user: SessionUser;
  /** Null when the endpoint is public (guest QR ordering, customer display). */
  anonymous: SessionUser | null;
  /** Best-effort client address, used for sign-in throttling. */
  ip: string;
}

export type Handler = (context: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  segments: string[];
  permission: Permission | null;
  /** Public routes skip the staff session requirement. */
  isPublic: boolean;
  handler: Handler;
}

const routes: Route[] = [];

function compile(pattern: string): string[] {
  return pattern.split("/").filter(Boolean);
}

/** Register an authenticated, permission-checked endpoint. */
export function route(
  method: string,
  pattern: string,
  permission: Permission | null,
  handler: Handler,
): void {
  routes.push({ method: method.toUpperCase(), segments: compile(pattern), permission, isPublic: false, handler });
}

/** Register an endpoint reachable without a staff session (QR guests, CFD). */
export function publicRoute(method: string, pattern: string, handler: Handler): void {
  routes.push({ method: method.toUpperCase(), segments: compile(pattern), permission: null, isPublic: true, handler });
}

function match(
  route: { method: string; segments: string[] },
  method: string,
  segments: string[],
): Record<string, string> | null {
  if (route.method !== method.toUpperCase()) return null;
  if (route.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const expected = route.segments[index];
    const actual = segments[index];
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export interface DispatchInput {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  user: SessionUser | null;
  /** Best-effort client address (proxy-aware headers); throttling uses it. */
  ip?: string;
}

export type DispatchResult =
  | { kind: "handled"; response: NextResponse }
  | { kind: "no-match" }
  | { kind: "forbidden"; response: NextResponse };

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  let matchedMethod = false;

  for (const candidate of routes) {
    const params = match(candidate, input.method, input.segments);
    if (!params) continue;
    matchedMethod = true;

    if (!candidate.isPublic) {
      if (!input.user) {
        return {
          kind: "handled",
          response: NextResponse.json({ error: "authentication required" }, { status: 401 }),
        };
      }
      if (candidate.permission && !can(input.user.permissions, candidate.permission)) {
        return {
          kind: "forbidden",
          response: NextResponse.json(
            { error: `missing permission: ${candidate.permission}` },
            { status: 403 },
          ),
        };
      }
    }

    try {
      const result = await candidate.handler({
        params,
        query: input.query,
        body: input.body,
        user: input.user ?? anonymousUser(),
        anonymous: input.user,
        ip: input.ip ?? "unknown",
      });
      if (result instanceof NextResponse) return { kind: "handled", response: result };
      return { kind: "handled", response: NextResponse.json(result ?? { ok: true }, { status: 200 }) };
    } catch (error) {
      return { kind: "handled", response: errorResponse(error) };
    }
  }

  void matchedMethod;
  return { kind: "no-match" };
}

/** Handler helper for resource creation. */
export function created(data: unknown): NextResponse {
  return NextResponse.json(data, { status: 201 });
}

function anonymousUser(): SessionUser {
  return { id: "anonymous", name: "Guest", initials: "G", color: "#7a8894", role: "guest", roleTitle: "Guest", permissions: [] };
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  // Domain rules raise plain Errors for illegal transitions / validation.
  const isDomain =
    error instanceof TypeError || error instanceof RangeError ? false : error instanceof Error;
  if (isDomain && !message.includes("SQLITE")) {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  console.error("[rms] unhandled API error", error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// ------------------------------------------------------------- platform routes
// The super admin lives in a different authority domain: a platform session is
// not a staff session and never carries a restaurant permission. These routes
// therefore have their own tiny registry and auth check instead of pretending to
// be staff endpoints with an empty permission.

export interface PlatformRouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** Null only on the public platform endpoints (status, setup, sign-in). */
  admin: PlatformUser | null;
  /** Best-effort client address, used for password/setup throttling. */
  ip: string;
}

export type PlatformHandler = (context: PlatformRouteContext) => unknown | Promise<unknown>;

interface PlatformRoute {
  method: string;
  segments: string[];
  requiresAuth: boolean;
  handler: PlatformHandler;
}

const platformRoutes: PlatformRoute[] = [];

export function platformRoute(
  method: string,
  pattern: string,
  handler: PlatformHandler,
  options: { requiresAuth?: boolean } = {},
): void {
  platformRoutes.push({
    method: method.toUpperCase(),
    segments: compile(pattern),
    requiresAuth: options.requiresAuth ?? true,
    handler,
  });
}

export interface PlatformDispatchInput {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  admin: PlatformUser | null;
  ip?: string;
}

export async function dispatchPlatform(input: PlatformDispatchInput): Promise<DispatchResult> {
  for (const candidate of platformRoutes) {
    const params = match(candidate, input.method, input.segments);
    if (!params) continue;

    if (candidate.requiresAuth && !input.admin) {
      return {
        kind: "handled",
        response: NextResponse.json({ error: "Platform sign-in required" }, { status: 401 }),
      };
    }

    try {
      const result = await candidate.handler({
        params,
        query: input.query,
        body: input.body,
        admin: input.admin,
        ip: input.ip ?? "unknown",
      });
      if (result instanceof NextResponse) return { kind: "handled", response: result };
      return { kind: "handled", response: NextResponse.json(result ?? { ok: true }, { status: 200 }) };
    } catch (error) {
      return { kind: "handled", response: errorResponse(error) };
    }
  }
  return { kind: "no-match" };
}

export function platformRouteTable(): { method: string; pattern: string; requiresAuth: boolean }[] {
  return platformRoutes.map((entry) => ({
    method: entry.method,
    pattern: `/platform/${entry.segments.join("/")}`,
    requiresAuth: entry.requiresAuth,
  }));
}

export function routeTable(): { method: string; pattern: string; permission: string | null; isPublic: boolean }[] {
  return routes.map((entry) => ({
    method: entry.method,
    pattern: `/${entry.segments.join("/")}`,
    permission: entry.permission,
    isPublic: entry.isPublic,
  }));
}
