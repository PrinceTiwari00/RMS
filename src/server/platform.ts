/**
 * Platform / super-admin accounts.
 *
 * The platform layer sits above every restaurant. A platform account can create
 * and suspend restaurants and reset a restaurant administrator's PIN, but it
 * never holds a staff session, never receives a restaurant permission and has no
 * route into a restaurant's orders, staff or money.
 *
 * Accounts are email + password (scrypt). The first account is created either
 * from RMS_PLATFORM_EMAIL / RMS_PLATFORM_PASSWORD at boot, or by a one-time
 * browser setup protected by RMS_SETUP_TOKEN.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { controlAll, controlGet, controlRun, controlTx, uuid } from "@/db/client";
import { nowStamp } from "@/domain/time";
import { isDemoMode } from "@/lib/session-core";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "@/server/errors";

export interface PlatformUser {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  lastSigninAt: string | null;
}

interface PlatformUserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  is_active: number;
  created_at: string;
  last_signin_at: string | null;
}

interface PlatformAuditRow {
  id: string;
  actor_email: string;
  action: string;
  tenant_code: string;
  detail: string;
  created_at: string;
}

export const DEMO_PLATFORM_EMAIL = "owner@rms.local";
export const DEMO_PLATFORM_PASSWORD = "rms-super-admin";

function toPublic(row: PlatformUserRow): PlatformUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    lastSigninAt: row.last_signin_at,
  };
}

// ---------------------------------------------------------------- passwords

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("base64url")}`;
}

function passwordMatches(stored: string, candidate: string): boolean {
  const [, salt, expected] = stored.split("$");
  if (!salt || !expected) return false;
  try {
    const actual = scryptSync(candidate, salt, 64);
    const expectedBuffer = Buffer.from(expected, "base64url");
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}

export function assertPlatformPassword(password: string, email: string): void {
  const value = String(password ?? "");
  if (value.length < 10) throw badRequest("Platform password must be at least 10 characters");
  if (value.length > 200) throw badRequest("Platform password must be at most 200 characters");
  if (value.toLowerCase() === String(email ?? "").toLowerCase()) {
    throw badRequest("Choose a password that is not your email address");
  }
}

function normalizeEmail(email: string): string {
  const value = String(email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 200) {
    throw badRequest("Enter a valid email address");
  }
  return value;
}

// ------------------------------------------------------------------ accounts

export function platformUserCount(): number {
  return Number(controlGet<{ count: number }>("SELECT COUNT(*) AS count FROM platform_users")?.count ?? 0);
}

export function platformSetupRequired(): boolean {
  return platformUserCount() === 0;
}

/** Production first-run is token-gated; demo mode is pre-seeded instead. */
export function platformSetupStatus(): {
  required: boolean;
  tokenConfigured: boolean;
  demoMode: boolean;
  envProvisioned: boolean;
} {
  return {
    required: platformSetupRequired() && !isDemoMode(),
    tokenConfigured: (process.env.RMS_SETUP_TOKEN ?? "").trim().length >= 32,
    demoMode: isDemoMode(),
    envProvisioned: Boolean(process.env.RMS_PLATFORM_EMAIL && process.env.RMS_PLATFORM_PASSWORD),
  };
}

export function verifySetupToken(supplied: string): void {
  const expected = process.env.RMS_SETUP_TOKEN ?? "";
  if (expected.trim().length < 32) {
    throw badRequest(
      "Platform setup is locked. Set RMS_SETUP_TOKEN to a random value of at least 32 characters and restart RMS.",
    );
  }
  const actualBuffer = Buffer.from(String(supplied ?? ""));
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw forbidden("The setup token is not valid");
  }
}

export interface CreatePlatformUserInput {
  name: string;
  email: string;
  password: string;
  setupToken?: string;
  /** True for the very first account, which is token-gated in production. */
  firstAccount?: boolean;
}

export function createPlatformUser(input: CreatePlatformUserInput): PlatformUser {
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 120) throw badRequest("Your name is required and must be at most 120 characters");
  const email = normalizeEmail(input.email);
  assertPlatformPassword(input.password, email);
  if (controlGet<{ id: string }>("SELECT id FROM platform_users WHERE email = ? COLLATE NOCASE", email)) {
    throw conflict("A platform account with that email already exists");
  }
  if (input.firstAccount) {
    if (!isDemoMode()) verifySetupToken(String(input.setupToken ?? ""));
    if (!platformSetupRequired()) throw conflict("The platform has already been initialized");
  }

  const id = uuid();
  controlRun(
    "INSERT INTO platform_users (id, email, name, password_hash, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
    id,
    email,
    name,
    hashPassword(input.password),
    nowStamp(),
  );
  platformAudit({ id, email, name }, "platform.account.create", null, `${email}`);
  const row = controlGet<PlatformUserRow>("SELECT * FROM platform_users WHERE id = ?", id);
  if (!row) throw notFound("Platform account not found");
  return toPublic(row);
}

/**
 * Boot-time provisioning for scripted deployments. Never overwrites an existing
 * account, and never runs in demo mode (the demo seed owns those credentials).
 */
export function ensurePlatformBootstrap(): { created: boolean; demo: boolean } {
  if (!platformSetupRequired()) return { created: false, demo: false };

  if (isDemoMode()) {
    createPlatformUser({
      name: "Platform Owner",
      email: DEMO_PLATFORM_EMAIL,
      password: DEMO_PLATFORM_PASSWORD,
      firstAccount: true,
    });
    return { created: true, demo: true };
  }

  const email = (process.env.RMS_PLATFORM_EMAIL ?? "").trim();
  const password = process.env.RMS_PLATFORM_PASSWORD ?? "";
  if (!email || !password) return { created: false, demo: false };
  createPlatformUser({
    name: (process.env.RMS_PLATFORM_NAME ?? "Platform Owner").trim(),
    email,
    password,
    firstAccount: true,
  });
  return { created: true, demo: false };
}

export function getPlatformUser(id: string): PlatformUser | null {
  const row = controlGet<PlatformUserRow>("SELECT * FROM platform_users WHERE id = ?", id);
  if (!row || !row.is_active) return null;
  return toPublic(row);
}

export function listPlatformUsers(): PlatformUser[] {
  return controlAll<PlatformUserRow>("SELECT * FROM platform_users ORDER BY created_at").map(toPublic);
}

export interface PlatformSignInResult {
  user: PlatformUser;
}

/** Email + password sign-in. Always fails with the same message. */
export function signInPlatform(email: string, password: string): PlatformSignInResult {
  const normalized = String(email ?? "").trim().toLowerCase();
  const supplied = String(password ?? "");
  if (!normalized || !supplied) throw unauthorized("Email and password are required");
  const row = controlGet<PlatformUserRow>("SELECT * FROM platform_users WHERE email = ? COLLATE NOCASE", normalized);
  if (!row || !row.is_active || !passwordMatches(row.password_hash, supplied)) {
    throw unauthorized("Email or password is not correct");
  }
  controlRun("UPDATE platform_users SET last_signin_at = ? WHERE id = ?", nowStamp(), row.id);
  platformAudit({ id: row.id, email: row.email, name: row.name }, "platform.signin", null, "");
  return { user: toPublic(row) };
}

export interface UpdatePlatformUserInput {
  name?: string;
  password?: string;
  currentPassword?: string;
  isActive?: boolean;
}

export function updatePlatformUser(actor: PlatformUser, id: string, patch: UpdatePlatformUserInput): PlatformUser {
  const row = controlGet<PlatformUserRow>("SELECT * FROM platform_users WHERE id = ?", id);
  if (!row) throw notFound("Platform account not found");

  if (patch.isActive === false) {
    if (row.id === actor.id) throw badRequest("You cannot deactivate your own account");
    const active = Number(controlGet<{ count: number }>("SELECT COUNT(*) AS count FROM platform_users WHERE is_active = 1")?.count ?? 0);
    if (active <= 1) throw badRequest("At least one active platform account must remain");
  }

  if (patch.password) {
    // Changing your own password requires the current one; resetting another
    // operator's password is a super-admin action and needs no proof.
    if (row.id === actor.id) {
      if (!patch.currentPassword || !passwordMatches(row.password_hash, patch.currentPassword)) {
        throw forbidden("Your current password is required to set a new one");
      }
    }
    assertPlatformPassword(patch.password, row.email);
  }

  controlRun(
    "UPDATE platform_users SET name = ?, password_hash = ?, is_active = ? WHERE id = ?",
    patch.name !== undefined ? String(patch.name).trim().slice(0, 120) : row.name,
    patch.password ? hashPassword(patch.password) : row.password_hash,
    patch.isActive === undefined ? row.is_active : patch.isActive ? 1 : 0,
    id,
  );
  platformAudit(actor, "platform.account.update", null, `${row.email}${patch.password ? " · password changed" : ""}`);
  const updated = controlGet<PlatformUserRow>("SELECT * FROM platform_users WHERE id = ?", id);
  if (!updated) throw notFound("Platform account not found");
  return toPublic(updated);
}

// --------------------------------------------------------------------- audit

export function platformAudit(
  actor: { id: string; email: string; name?: string } | null,
  action: string,
  tenant: { id: string; code: string } | null,
  detail: string,
): void {
  controlRun(
    `INSERT INTO platform_audit (id, actor_id, actor_email, action, tenant_id, tenant_code, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    uuid(),
    actor?.id ?? null,
    actor?.email ?? "system",
    action,
    tenant?.id ?? null,
    tenant?.code ?? "",
    detail,
    nowStamp(),
  );
}

export function recentPlatformAudit(limit = 60): {
  id: string;
  actorEmail: string;
  action: string;
  tenantCode: string;
  detail: string;
  createdAt: string;
}[] {
  return controlAll<PlatformAuditRow>(
    "SELECT * FROM platform_audit ORDER BY created_at DESC, rowid DESC LIMIT ?",
    Math.min(Math.max(limit, 1), 200),
  ).map((row) => ({
    id: row.id,
    actorEmail: row.actor_email,
    action: row.action,
    tenantCode: row.tenant_code,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}

export function withPlatformTx<T>(fn: () => T): T {
  return controlTx(fn);
}
