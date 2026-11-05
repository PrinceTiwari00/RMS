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
