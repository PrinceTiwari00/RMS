/**
 * Session/token primitives with no Next.js imports.
 *
 * Kept separate from `session.ts` so command-line scripts (seeding, tenant
 * provisioning) and the platform control plane can sign and verify tokens
 * without pulling `next/headers` into a plain Node process.
 *
 * A signed payload carries a subject id, an optional tenant id and a scope.
 * The scope matters: a platform (super-admin) token must never be accepted as a
 * restaurant staff session even if the cookie names were ever confused.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_SECRET = "rms-development-secret-change-me-0123456789abcdef";

export type TokenScope = "staff" | "platform";

export interface VerifiedToken {
  uid: string;
  tid?: string;
  scope: TokenScope;
  iat: number;
}

/** Fail closed rather than issuing production sessions with the demo secret. */
export function validateProductionEnvironment(): void {
  if (!isProduction()) return;
  const configured = process.env.RMS_SECRET_KEY ?? "";
  if (configured.trim().length < 32 || configured === DEFAULT_SECRET) {
    throw new Error("RMS_SECRET_KEY must be a stable random value of at least 32 characters in production");
  }
}

export function secret(): string {
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

export interface IssueTokenOptions {
  /** Restaurant (tenant) id. Omitted for platform tokens and legacy installs. */
  tenantId?: string;
  scope?: TokenScope;
}

export function issueToken(subject: string, options: IssueTokenOptions = {}): string {
  const payload = base64url(
    JSON.stringify({
      uid: subject,
      ...(options.tenantId ? { tid: options.tenantId } : {}),
      scope: options.scope ?? "staff",
      iat: Date.now(),
      n: randomBytes(6).toString("hex"),
    }),
  );
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined | null): VerifiedToken | null {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      uid?: string;
      tid?: string;
      scope?: string;
      iat?: number;
    };
    if (!decoded.uid) return null;
    const scope: TokenScope = decoded.scope === "platform" ? "platform" : "staff";
    return {
      uid: decoded.uid,
      ...(decoded.tid ? { tid: decoded.tid } : {}),
      scope,
      iat: decoded.iat ?? 0,
    };
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

export function csrfMatches(jar: CookieJar, supplied: string | null, cookieName: string): boolean {
  const expected = jar.get(cookieName)?.value ?? "";
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
export function csrfHeaderMatches(
  jar: CookieJar,
  headers: Pick<Headers, "get">,
  cookieName: string,
  headerName = "x-csrf-token",
): boolean {
  return csrfMatches(jar, headers.get(headerName), cookieName);
}
