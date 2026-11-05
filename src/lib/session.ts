/**
 * Session handling.
 *
 * Staff sign in on the Shift PIN Pad; the server issues an HMAC-signed,
 * HTTP-only cookie plus a readable double-submit CSRF token. The signed payload
 * carries the employee id and the restaurant (tenant) id — permissions are
 * re-read from the database on every request so revoking access takes effect
 * immediately.
 *
 * The cryptographic primitives live in `session-core.ts` (no Next.js imports);
 * this module adds the request-scoped cookie helpers.
 */
import { cookies } from "next/headers";
import {
  CSRF_COOKIE,
  PLATFORM_CSRF_COOKIE,
  PLATFORM_SESSION_COOKIE,
  SESSION_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session-keys";
import {
  csrfHeaderMatches as coreCsrfHeaderMatches,
  csrfMatches as coreCsrfMatches,
  type CookieJar,
  type VerifiedToken,
  verifyToken as verifyTokenFromCore,
} from "@/lib/session-core";

export {
  CSRF_COOKIE,
  PLATFORM_CSRF_COOKIE,
  PLATFORM_SESSION_COOKIE,
  SESSION_COOKIE,
  TENANT_COOKIE,
};
export {
  isDemoMode,
  isProduction,
  issueToken,
  newCsrfToken,
  secret,
  validateProductionEnvironment,
  verifyToken,
  type CookieJar,
  type IssueTokenOptions,
  type TokenScope,
  type VerifiedToken,
} from "@/lib/session-core";

export interface StaffSession {
  uid: string;
  tenantId?: string;
}

/** Read + verify the staff session from a cookie jar (Next `cookies()` or a map). */
export function readSession(jar: CookieJar): StaffSession | null {
  const verified: VerifiedToken | null = verifyStaffToken(jar.get(SESSION_COOKIE)?.value);
  return verified ? { uid: verified.uid, ...(verified.tid ? { tenantId: verified.tid } : {}) } : null;
}

/** Read + verify the platform (super admin) session. */
export function readPlatformSession(jar: CookieJar): { uid: string } | null {
  const token = jar.get(PLATFORM_SESSION_COOKIE)?.value;
  if (!token) return null;
  const verified = verifyTokenFromCore(token);
  if (!verified || verified.scope !== "platform") return null;
  return { uid: verified.uid };
}

function verifyStaffToken(token: string | undefined | null): VerifiedToken | null {
  if (!token) return null;
  const verified = verifyTokenFromCore(token);
  if (!verified || verified.scope !== "staff") return null;
  return verified;
}

/** Server-component helper: current employee id, or null when signed out. */
export async function currentEmployeeId(): Promise<string | null> {
  const jar = await cookies();
  return readSession({ get: (name) => jar.get(name) })?.uid ?? null;
}

/** Server-component helper: the signed tenant id for the current request. */
export async function currentTenantId(): Promise<string | null> {
  const jar = await cookies();
  return readSession({ get: (name) => jar.get(name) })?.tenantId ?? null;
}

export function csrfMatches(jar: CookieJar, supplied: string | null): boolean {
  return coreCsrfMatches(jar, supplied, CSRF_COOKIE);
}

export function csrfHeaderMatches(jar: CookieJar, headers: Pick<Headers, "get">): boolean {
  return coreCsrfHeaderMatches(jar, headers, CSRF_COOKIE);
}

export function platformCsrfHeaderMatches(jar: CookieJar, headers: Pick<Headers, "get">): boolean {
  return coreCsrfHeaderMatches(jar, headers, PLATFORM_CSRF_COOKIE, "x-platform-csrf-token");
}
