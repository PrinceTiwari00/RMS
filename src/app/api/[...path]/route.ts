/**
 * Single catch-all API entry point.
 *
 * Every endpoint is registered in `src/server/routes`, so authentication, CSRF,
 * permission checks, validation errors and JSON encoding all happen exactly once
 * here instead of being repeated across forty route files.
 */
import { NextRequest, NextResponse } from "next/server";
import { dispatch, errorResponse, type DispatchResult } from "@/server/router";
import { userFromJar } from "@/server/identity";
import { csrfHeaderMatches } from "@/lib/session";
import { ensureDatabase } from "@/db/boot";
import "@/server/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Mutating verbs need a CSRF token when a staff session is present. */
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

interface RouteContext {
  params: Promise<{ path?: string[] }>;
}

async function handle(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const resolved = await context.params;
  const segments = (resolved?.path ?? []).filter(Boolean).map(decodeURIComponent);

  try {
    ensureDatabase();
  } catch (error) {
    console.error("[rms] database unavailable", error);
    return NextResponse.json(
      { error: "The database could not be opened. Run `npm run db:reset` to rebuild the demo data." },
      { status: 500 },
    );
  }

  const jar = { get: (name: string) => request.cookies.get(name) };
  const user = userFromJar(jar);
  const method = request.method.toUpperCase();

  // Public endpoints (guest QR ordering, the customer display) carry no session.
  const publicPrefixes = ["guest", "cfd", "session"];
  const isPublicPath = publicPrefixes.includes(segments[0] ?? "");

  if (user && MUTATING.has(method) && !isPublicPath) {
    // The header is mandatory. Reading the token back out of the Cookie header
    // would make a cross-site request satisfy its own double-submit check.
    if (!csrfHeaderMatches(jar, request.headers)) {
      return NextResponse.json({ error: "Your session expired — reload the page and sign in again" }, { status: 403 });
    }
  }

  let body: Record<string, unknown> = {};
  if (MUTATING.has(method)) {
    try {
      const text = await request.text();
      if (text.trim()) {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        else body = { value: parsed };
      }
    } catch {
      return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
    }
  }

  let result: DispatchResult;
  try {
    result = await dispatch({ method, segments, query: request.nextUrl.searchParams, body, user });
  } catch (error) {
    return errorResponse(error);
  }

  switch (result.kind) {
    case "handled":
    case "forbidden":
      return result.response;
    case "no-match":
      return NextResponse.json({ error: `No API route for ${method} /api/${segments.join("/")}` }, { status: 404 });
    default:
      return NextResponse.json({ error: "Unhandled request" }, { status: 500 });
  }
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
