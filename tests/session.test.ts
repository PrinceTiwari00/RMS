import { describe, expect, it } from "vitest";
import {
  CSRF_COOKIE,
  csrfHeaderMatches,
  csrfMatches,
  issueToken,
  newCsrfToken,
  verifyToken,
} from "@/lib/session";

describe("staff session security", () => {
  it("round-trips a signed employee token and rejects tampering", () => {
    const token = issueToken("emp-manager");
    expect(verifyToken(token)?.uid).toBe("emp-manager");
    expect(verifyToken(`${token.slice(0, -1)}x`)).toBeNull();
    expect(verifyToken("not-a-token")).toBeNull();
  });

  it("compares the CSRF cookie and supplied token exactly", () => {
    const csrf = newCsrfToken();
    const jar = { get: (name: string) => (name === CSRF_COOKIE ? { value: csrf } : undefined) };
    expect(csrfMatches(jar, csrf)).toBe(true);
    expect(csrfMatches(jar, `${csrf}x`)).toBe(false);
    expect(csrfMatches(jar, "")).toBe(false);
    expect(csrfMatches({ get: () => undefined }, csrf)).toBe(false);
  });

  it("fails closed for missing, short, or development production secrets", () => {
    const previousEnvironment = process.env.RMS_ENV;
    const previousSecret = process.env.RMS_SECRET_KEY;
    const previousNodeEnvironment = process.env.NODE_ENV;
    try {
      delete process.env.RMS_ENV;
      Reflect.set(process.env, "NODE_ENV", "production");
      delete process.env.RMS_SECRET_KEY;
      expect(() => issueToken("emp-manager")).toThrow(/RMS_SECRET_KEY/);
      process.env.RMS_SECRET_KEY = "too-short";
      expect(() => issueToken("emp-manager")).toThrow(/RMS_SECRET_KEY/);
      process.env.RMS_SECRET_KEY = "rms-development-secret-change-me-0123456789abcdef";
      expect(() => issueToken("emp-manager")).toThrow(/RMS_SECRET_KEY/);
      process.env.RMS_SECRET_KEY = "a-real-test-only-production-secret-0123456789";
      expect(verifyToken(issueToken("emp-manager"))?.uid).toBe("emp-manager");
    } finally {
      if (previousEnvironment === undefined) delete process.env.RMS_ENV;
      else process.env.RMS_ENV = previousEnvironment;
      if (previousSecret === undefined) delete process.env.RMS_SECRET_KEY;
      else process.env.RMS_SECRET_KEY = previousSecret;
      if (previousNodeEnvironment === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
      else Reflect.set(process.env, "NODE_ENV", previousNodeEnvironment);
    }
  });

  it("requires an explicit CSRF header even when the browser sent the cookie", () => {
    const csrf = newCsrfToken();
    const jar = { get: (name: string) => (name === CSRF_COOKIE ? { value: csrf } : undefined) };
    const headers = new Headers({ cookie: `${CSRF_COOKIE}=${encodeURIComponent(csrf)}` });

    // Regression: parsing the Cookie header here would let a cross-site form
    // satisfy its own double-submit check without knowing the token.
    expect(csrfHeaderMatches(jar, headers)).toBe(false);
    headers.set("x-csrf-token", "wrong-token");
    expect(csrfHeaderMatches(jar, headers)).toBe(false);
    headers.set("x-csrf-token", csrf);
    expect(csrfHeaderMatches(jar, headers)).toBe(true);
  });
});
