/**
 * Sign-in throttling.
 *
 * A 4–6 digit PIN is only as strong as the number of guesses it survives, so the
 * two public credential endpoints (staff PIN and platform password) are rate
 * limited per client + restaurant/email.
 *
 * The counters live in process memory: this deployment is a single Node process
 * with a single SQLite writer, so a shared store would add complexity without
 * changing the threat model. The trade-off is that a restart clears the counters,
 * which is documented rather than hidden.
 */
import { tooManyRequests } from "@/server/errors";

export interface RateLimitPolicy {
  /** Failures allowed inside the window before a block starts. */
  maxFailures: number;
  /** Rolling window that the failures are counted in. */
  windowMs: number;
  /** How long a triggered block lasts. */
  blockMs: number;
}

export const SIGNIN_POLICY: RateLimitPolicy = {
  maxFailures: 5,
  windowMs: 10 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
};

export const SETUP_POLICY: RateLimitPolicy = {
  maxFailures: 3,
  windowMs: 30 * 60 * 1000,
  blockMs: 30 * 60 * 1000,
};

interface Bucket {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_KEYS = 10_000;

function prune(now: number, policy: RateLimitPolicy): void {
  if (buckets.size <= MAX_TRACKED_KEYS) return;
  for (const [key, bucket] of buckets) {
    const stale = bucket.blockedUntil <= now && now - bucket.firstFailureAt > policy.windowMs;
    if (stale) buckets.delete(key);
  }
}

export interface RateLimitState {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** Read-only check; does not record anything. */
export function checkRateLimit(key: string, policy: RateLimitPolicy, now = Date.now()): RateLimitState {
  const bucket = buckets.get(key);
  if (!bucket) return { allowed: true, remaining: policy.maxFailures, retryAfterSeconds: 0 };
  if (bucket.blockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000)),
    };
  }
  if (now - bucket.firstFailureAt > policy.windowMs) {
    // The window has rolled over; the next failure starts a fresh count.
    buckets.delete(key);
    return { allowed: true, remaining: policy.maxFailures, retryAfterSeconds: 0 };
  }
  return { allowed: true, remaining: Math.max(0, policy.maxFailures - bucket.failures), retryAfterSeconds: 0 };
}

/** Count one failed attempt and block when the allowance is exhausted. */
export function recordAuthFailure(key: string, policy: RateLimitPolicy, now = Date.now()): void {
  prune(now, policy);
  const existing = buckets.get(key);
  if (!existing || now - existing.firstFailureAt > policy.windowMs) {
    buckets.set(key, { failures: 1, firstFailureAt: now, blockedUntil: 0 });
    return;
  }
  existing.failures += 1;
  if (existing.failures >= policy.maxFailures) {
    existing.blockedUntil = now + policy.blockMs;
    existing.failures = policy.maxFailures;
  }
}

export function clearAuthFailures(key: string): void {
  buckets.delete(key);
}

/** Throw a 429 with a useful retry hint. */
export function assertNotBlocked(key: string, policy: RateLimitPolicy, now = Date.now()): void {
  const state = checkRateLimit(key, policy, now);
  if (state.allowed) return;
  const minutes = Math.max(1, Math.ceil(state.retryAfterSeconds / 60));
  throw tooManyRequests(
    `Too many failed sign-in attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
  );
}

/** Test helper: forget every counter. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** Diagnostics for the platform console / tests. */
export function rateLimitSize(): number {
  return buckets.size;
}
