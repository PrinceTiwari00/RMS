/**
 * PIN hashing, shared by staff sign-in and control-plane provisioning.
 *
 * New and changed PINs are salted and hashed with scrypt. Legacy SHA-256 hashes
 * remain verifiable so an older database keeps working, and plaintext samples
 * authenticate only in demo mode (the seeded PIN pad shows them as hints).
 *
 * No Next.js imports here: the tenant provisioning script needs to hash a new
 * restaurant admin's PIN outside a request context.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { isDemoMode } from "@/lib/session-core";

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("base64url");
  const derived = scryptSync(pin, salt, 64).toString("base64url");
  return `scrypt$${salt}$${derived}`;
}

export function pinMatches(stored: string, candidate: string): boolean {
  if (stored.startsWith("scrypt$")) {
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

  // Backward compatibility for databases created before salted scrypt. These
  // hashes are upgraded whenever the employee's PIN is next changed.
  const legacy = createHash("sha256").update(`rms:${candidate}`).digest("hex");
  const storedBuffer = Buffer.from(stored ?? "");
  const legacyBuffer = Buffer.from(legacy);
  if (storedBuffer.length === legacyBuffer.length && timingSafeEqual(storedBuffer, legacyBuffer)) return true;

  // The original demo seed deliberately exposes its sample PINs on the PIN pad.
  // Never authenticate plaintext records in production mode.
  const plain = Buffer.from(candidate);
  return isDemoMode() && storedBuffer.length === plain.length && timingSafeEqual(storedBuffer, plain);
}
