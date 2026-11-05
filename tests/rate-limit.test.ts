import { beforeEach, describe, expect, it } from "vitest";
import {
  SIGNIN_POLICY,
  assertNotBlocked,
  checkRateLimit,
  clearAuthFailures,
  rateLimitSize,
  recordAuthFailure,
  resetRateLimits,
} from "@/server/rate-limit";
import { ApiError } from "@/server/errors";

const START = 1_700_000_000_000;

describe("sign-in throttling", () => {
  beforeEach(() => resetRateLimits());

  it("allows attempts until the failure allowance is spent", () => {
    const key = "staff:tenant-1:203.0.113.9";
    for (let attempt = 0; attempt < SIGNIN_POLICY.maxFailures - 1; attempt += 1) {
      recordAuthFailure(key, SIGNIN_POLICY, START + attempt);
      expect(checkRateLimit(key, SIGNIN_POLICY, START + attempt).allowed).toBe(true);
    }
    recordAuthFailure(key, SIGNIN_POLICY, START + 4);

    const blocked = checkRateLimit(key, SIGNIN_POLICY, START + 5);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("throws a 429 with a retry hint while blocked", () => {
    const key = "platform:203.0.113.9:ops@example.com";
    for (let attempt = 0; attempt < SIGNIN_POLICY.maxFailures; attempt += 1) {
      recordAuthFailure(key, SIGNIN_POLICY, START + attempt);
    }
    try {
      assertNotBlocked(key, SIGNIN_POLICY, START + 10);
      throw new Error("expected a 429");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(429);
      expect((error as ApiError).message).toMatch(/Too many failed sign-in attempts/);
    }
  });

  it("lets the client in again once the block expires", () => {
    const key = "staff:tenant-1:203.0.113.9";
    for (let attempt = 0; attempt < SIGNIN_POLICY.maxFailures; attempt += 1) {
      recordAuthFailure(key, SIGNIN_POLICY, START + attempt);
    }
    // Every failure is recorded a few ms apart, so the block ends a few ms after
    // START + blockMs; step past it.
    const later = START + SIGNIN_POLICY.blockMs + 10_000;
    expect(checkRateLimit(key, SIGNIN_POLICY, later).allowed).toBe(true);
    expect(() => assertNotBlocked(key, SIGNIN_POLICY, later)).not.toThrow();
  });

  it("forgets failures on a successful sign-in and after the window rolls over", () => {
    const successKey = "staff:tenant-2:203.0.113.10";
    recordAuthFailure(successKey, SIGNIN_POLICY, START);
    recordAuthFailure(successKey, SIGNIN_POLICY, START + 1);
    clearAuthFailures(successKey);
    expect(checkRateLimit(successKey, SIGNIN_POLICY, START + 2).remaining).toBe(SIGNIN_POLICY.maxFailures);

    const windowKey = "staff:tenant-3:203.0.113.11";
    for (let attempt = 0; attempt < SIGNIN_POLICY.maxFailures - 1; attempt += 1) {
      recordAuthFailure(windowKey, SIGNIN_POLICY, START + attempt);
    }
    const afterWindow = START + SIGNIN_POLICY.windowMs + 5_000;
    const rolled = checkRateLimit(windowKey, SIGNIN_POLICY, afterWindow);
    expect(rolled.allowed).toBe(true);
    expect(rolled.remaining).toBe(SIGNIN_POLICY.maxFailures);
    expect(rateLimitSize()).toBe(0);
  });

  it("scopes counters per restaurant and per client", () => {
    const keyA = "staff:tenant-a:203.0.113.20";
    for (let attempt = 0; attempt < SIGNIN_POLICY.maxFailures; attempt += 1) {
      recordAuthFailure(keyA, SIGNIN_POLICY, START + attempt);
    }
    expect(checkRateLimit(keyA, SIGNIN_POLICY, START + 9).allowed).toBe(false);
    // A different restaurant (or a different client) is unaffected.
    expect(checkRateLimit("staff:tenant-b:203.0.113.20", SIGNIN_POLICY, START + 9).allowed).toBe(true);
    expect(checkRateLimit("staff:tenant-a:203.0.113.21", SIGNIN_POLICY, START + 9).allowed).toBe(true);
  });
});
