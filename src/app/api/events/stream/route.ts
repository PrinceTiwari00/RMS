/**
 * Server-Sent Events (SSE) endpoint for real-time updates across guests, floor staff, and KDS.
 */
import { NextRequest, NextResponse } from "next/server";
import { ensureDatabase } from "@/db/boot";
import { withTenant } from "@/db/client";
import { readSession, type CookieJar } from "@/lib/session";
import { resolveRequestTenant } from "@/server/request-tenant";
import { loadUser } from "@/server/identity";
import { tenantScope } from "@/server/tenant";
import { resolveToken } from "@/server/customer";
import { subscribeTenantEvents, type RmsEvent } from "@/server/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    ensureDatabase();
  } catch {
    return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
  }

  const jar: CookieJar = { get: (name) => request.cookies.get(name) };
  const session = readSession(jar);
  const query = request.nextUrl.searchParams;
  const token = query.get("token")?.trim() || "";
  const stationFilter = query.get("station")?.trim() || "";

  const resolution = resolveRequestTenant({
    segments: token ? ["guest", token] : [],
    query,
    jar,
    session,
  });

  if (!resolution.tenant) {
    return NextResponse.json({ error: "Unknown tenant" }, { status: 404 });
  }
  const tenant = resolution.tenant;

  if (tenant.status !== "active") return NextResponse.json({ error: "Restaurant is suspended" }, { status: 403 });

  let guestTableId: string | null = null;
  if (token) {
    try {
      const resolved = withTenant(tenantScope(tenant), () => resolveToken(token));
      if (!resolved) {
        return NextResponse.json({ error: "Unknown table token" }, { status: 404 });
      }
      guestTableId = resolved.tableId;
    } catch {
      return NextResponse.json({ error: "Unknown table token" }, { status: 404 });
    }
  } else {
    const user = session ? withTenant(tenantScope(tenant), () => loadUser(session.uid)) : null;
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
  }

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* stream already closed */
        }
      };

      send("connected", { ok: true, tenantId: tenant.id, ts: Date.now() });

      const unsub = subscribeTenantEvents(tenant.id, (evt: RmsEvent) => {
        if (token) {
          // Guests receive events for their own table, plus live quiz updates.
          const isOwnTable = Boolean(guestTableId && evt.tableId === guestTableId);
          const isQuiz = evt.type === "quiz.updated";
          if (!isOwnTable && !isQuiz) return;
        } else if (stationFilter && stationFilter !== "all" && evt.type === "kds.updated" && evt.station && evt.station !== stationFilter) {
          return;
        }
        send("rms", evt);
      });

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          clearInterval(keepalive);
        }
      }, 15000);

      cleanup = () => {
        clearInterval(keepalive);
        unsub();
      };

      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
