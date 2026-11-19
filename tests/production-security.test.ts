import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { isDemoMode, isProduction, issueToken, secret, verifyToken } from "@/lib/session-core";
import { clockInByEmployee, clockOutByEmployee } from "@/server/labor";
import { payGuestOrder } from "@/server/customer";
import { forwardStoredPayments } from "@/server/checkout";
import { checkTcpConnection, discoverEscPos } from "@/server/hardware";
import { sendPo, retryTransmission } from "@/server/purchasing";
import { tenantDirectoryEnabled } from "@/server/tenant";

const originalMode = process.env.RMS_ENV;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalMode === undefined) delete process.env.RMS_ENV;
  else process.env.RMS_ENV = originalMode;
});

function signed(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret()).update(encoded).digest("base64url")}`;
}

describe("production security regressions", () => {
  it("requires explicit demo opt-in and fails closed on misspelled production modes", () => {
    delete process.env.RMS_ENV;
    expect(isDemoMode()).toBe(false);
    process.env.RMS_ENV = "demo";
    expect(isDemoMode()).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    process.env.RMS_ENV = "prodution";
    expect(isProduction()).toBe(true);
    vi.unstubAllEnvs();
  });

  it("rejects expired, future-dated and malformed signed sessions", () => {
    expect(verifyToken(signed({ uid: "employee", scope: "staff", iat: Date.now() - 12 * 3600000 }))).toBeNull();
    expect(verifyToken(signed({ uid: "employee", scope: "staff", iat: Date.now() + 120000 }))).toBeNull();
    expect(verifyToken(signed({ uid: "employee", scope: "staff" }))).toBeNull();
    expect(verifyToken(signed({ uid: "employee", scope: "unknown", iat: Date.now() }))).toBeNull();
    expect(verifyToken(`${issueToken("employee")}.extra`)).toBeNull();
    expect(verifyToken(issueToken("employee"))?.uid).toBe("employee");
  });

  it("prevents employees from punching on behalf of a colleague", () => {
    const actor = { id: "server", name: "Server", initials: "S", color: "", role: "server", roleTitle: "Server", permissions: [] };
    expect(() => clockInByEmployee("colleague", actor)).toThrow(/Only time-clock managers/);
    expect(() => clockOutByEmployee("colleague", actor)).toThrow(/Only time-clock managers/);
    expect(() => clockInByEmployee("colleague", null)).toThrow(/Only time-clock managers/);
  });

  it("never records unverified guest payments or fake gateway captures outside demo", () => {
    delete process.env.RMS_ENV;
    expect(() => payGuestOrder("token", "order", { method: "wallet" })).toThrow(/verification is not configured/);
    expect(() => forwardStoredPayments(null)).toThrow(/not configured/);
    expect(() => sendPo("po", "auto", null)).toThrow(/transport is not configured/);
    expect(() => retryTransmission("transmission", null)).toThrow(/transport is not configured/);
  });

  it("blocks arbitrary server-network probes outside demo", async () => {
    delete process.env.RMS_ENV;
    expect(() => checkTcpConnection("169.254.169.254", 80)).toThrow(/RMS_HARDWARE_ALLOWED_IPS/);
    await expect(discoverEscPos("192.168.1")).rejects.toThrow(/disabled outside demo/);
  });

  it("does not publish the restaurant directory by default outside demo", () => {
    delete process.env.RMS_ENV;
    const previous = process.env.RMS_TENANT_DIRECTORY;
    delete process.env.RMS_TENANT_DIRECTORY;
    try { expect(tenantDirectoryEnabled()).toBe(false); }
    finally { if (previous !== undefined) process.env.RMS_TENANT_DIRECTORY = previous; }
  });

  it("has a page for every static sidebar destination", () => {
    const shell = fs.readFileSync("src/components/AppShell.tsx", "utf8");
    for (const [, href] of shell.matchAll(/href: "(\/[^"]+)"/g)) {
      if (href.startsWith("/kds/")) continue;
      const roots = ["src/app/(staff)", "src/app/(theatre)", "src/app"];
      expect(roots.some((root) => fs.existsSync(path.join(root, href, "page.tsx"))), href).toBe(true);
    }
  });
});
