/**
 * Session handling.
 *
 * Staff sign in on the Shift PIN Pad; the server issues an HMAC-signed,
 * HTTP-only cookie plus a readable double-submit CSRF token. The signed payload
 * carries only the employee id — permissions are re-read from the database on
 * every request so revoking access takes effect immediately.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/lib/session-keys";

export { SESSION_COOKIE, CSRF_COOKIE };

const DEFAULT_SECRET = "rms-development-secret-change-me-0123456789abcdef";

/** Fail closed rather than issuing production sessions with the demo secret. */
export function validateProductionEnvironment(): void {
  if (!isProduction()) return;
  const configured = process.env.RMS_SECRET_KEY ?? "";
  if (configured.trim().length < 32 || configured === DEFAULT_SECRET) {
    throw new Error("RMS_SECRET_KEY must be a stable random value of at least 32 characters in production");
  }
}

function secret(): string {
  validateProductionEnvironment();
  return process.env.RMS_SECRET_KEY || DEFAULT_SECRET;
}

export function isProduction(): boolean {
  const explicitMode = process.env.RMS_ENV?.toLowerCase();
  // An explicit RMS_ENV=demo supports reviewed demo/preview builds. Otherwise
  // a conventional NODE_ENV=production start must never fall back to demo data.
  return explicitMode ? explicitMode === "production" : process.env.NODE_ENV === "production";
}

export function isDemoMode(): boolean {
  return !isProduction();
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function issueToken(employeeId: string): string {
  const payload = base64url(JSON.stringify({ uid: employeeId, iat: Date.now(), n: randomBytes(6).toString("hex") }));
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined | null): { uid: string; iat: number } | null {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { uid?: string; iat?: number };
    if (!decoded.uid) return null;
    return { uid: decoded.uid, iat: decoded.iat ?? 0 };
  } catch {
    return null;
  }
}

export function newCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

export interface CookieJar {
  get(name: string): { value: string } | undefined;
}

/** Read + verify the session from a cookie jar (Next `cookies()` or a plain map). */
export function readSession(jar: CookieJar): { uid: string } | null {
  const verified = verifyToken(jar.get(SESSION_COOKIE)?.value);
  return verified ? { uid: verified.uid } : null;
}

/** Server-component helper: current employee id, or null when signed out. */
export async function currentEmployeeId(): Promise<string | null> {
  const jar = await cookies();
  return readSession({ get: (name) => jar.get(name) })?.uid ?? null;
}

export function csrfMatches(jar: CookieJar, supplied: string | null): boolean {
  const expected = jar.get(CSRF_COOKIE)?.value ?? "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Validate the double-submit header without ever falling back to Cookie.
 * A browser attaches cookies to cross-site requests automatically, so parsing
 * the token out of that same header would provide no CSRF protection at all.
 */
export function csrfHeaderMatches(jar: CookieJar, headers: Pick<Headers, "get">): boolean {
  return csrfMatches(jar, headers.get("x-csrf-token"));
}
