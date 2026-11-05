/**
 * Session, bootstrap and settings routes.
 *
 * Sign-in is public (there is no session yet); everything else here requires an
 * authenticated employee. Cookies are HTTP-only, SameSite=Lax and Secure outside
 * demo mode, matching the fail-closed rule for production.
 */
import { NextResponse } from "next/server";
import { created, publicRoute, route, badRequest } from "@/server/router";
import { signInWithPin, getStaff, auditTrail } from "@/server/staff";
import { buildBootstrap, buildMetrics } from "@/server/state";
import { getRawSettings, getSettings, getStations, setSettings } from "@/server/settings";
import { bool, q, qInt, required } from "@/server/coerce";
import { routeTable } from "@/server/router";
import { CSRF_COOKIE, SESSION_COOKIE, issueToken, newCsrfToken, isProduction } from "@/lib/session";
import { audit } from "@/server/audit";
import { DENOMINATIONS, rangePresets } from "@/server/reports";
import { TENDER_METHODS, cashSuggestions } from "@/domain/checkout";
import { tipSuggestions } from "@/domain/pricing";

const COOKIE_BASE = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: isProduction(),
  path: "/",
};

// ---------------------------------------------------------------------- sign-in
publicRoute("POST", "session/signin", ({ body }) => {
  const pin = required(body, "pin", "PIN");
  const clockIn = bool(body, "clockIn", false);
  const { user } = signInWithPin(pin, clockIn);

  const token = issueToken(user.id);
  const csrf = newCsrfToken();
  const response = NextResponse.json({ user, csrfToken: csrf, demoMode: !isProduction() });
  response.cookies.set(SESSION_COOKIE, token, { ...COOKIE_BASE, maxAge: 60 * 60 * 12 });
  // The CSRF token must be readable by the client script, so it is not httpOnly.
  response.cookies.set(CSRF_COOKIE, csrf, { ...COOKIE_BASE, httpOnly: false, maxAge: 60 * 60 * 12 });
  return response;
});

publicRoute("POST", "session/signout", ({ anonymous }) => {
  if (anonymous) audit(anonymous, "auth.signout", "employee", anonymous.id, null);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 });
  response.cookies.set(CSRF_COOKIE, "", { ...COOKIE_BASE, httpOnly: false, maxAge: 0 });
  return response;
});

publicRoute("GET", "session", ({ anonymous }) => ({
  user: anonymous,
  csrfToken: null,
  demoMode: !isProduction(),
}));

// -------------------------------------------------------------------- bootstrap
route("GET", "bootstrap", null, ({ anonymous, query }) => buildBootstrap(anonymous, q(query, "csrf") || null));

route("GET", "metrics", null, () => buildMetrics());

route("GET", "state/staff", "pos.open", () => ({ staff: getStaff() }));

// --------------------------------------------------------------------- settings
route("GET", "settings", null, () => ({
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
  setSettings(patch, user);
  return { settings: getSettings(), stations: getStations() };
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
