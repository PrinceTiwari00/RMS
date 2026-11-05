import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Multi-restaurant control plane.
 *
 * These tests run against real SQLite files in a throwaway directory: tenant
 * isolation is a property of the filesystem, so an in-memory database would not
 * prove anything.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rms-tenant-"));
const previous = {
  dataDir: process.env.RMS_DATA_DIR,
  dbPath: process.env.RMS_DB_PATH,
  controlPath: process.env.RMS_CONTROL_DB_PATH,
  env: process.env.RMS_ENV,
  secret: process.env.RMS_SECRET_KEY,
};

process.env.RMS_DATA_DIR = tempDir;
process.env.RMS_CONTROL_DB_PATH = path.join(tempDir, "control.db");
process.env.RMS_DB_PATH = path.join(tempDir, "legacy.db");
process.env.RMS_ENV = "demo";

const {
  controlGet,
  controlRun,
  migrate,
  migrateControl,
  resetConnection,
  run,
  get,
  all,
  withTenant,
} = await import("@/db/client");
const {
  DEMO_PLATFORM_EMAIL,
  DEMO_PLATFORM_PASSWORD,
  createPlatformUser,
  ensurePlatformBootstrap,
  platformSetupRequired,
  signInPlatform,
} = await import("@/server/platform");
const {
  createTenant,
  destroyTenant,
  getTenantByCode,
  listTenants,
  publicTenant,
  resetTenantAdminPin,
  runWithTenant,
  tenantAdminPinMatches,
  tenantDbPath,
  tenantScope,
  updateTenant,
  tenantDirectory,
  findTenantByGuestToken,
} = await import("@/server/tenant");
const { issueToken, verifyToken } = await import("@/lib/session");

import type { Tenant } from "@/server/tenant";

let north: Tenant;
let south: Tenant;

describe("platform and restaurant accounts", () => {
  beforeAll(() => {
    migrateControl();
    const bootstrap = ensurePlatformBootstrap();
    expect(bootstrap.demo).toBe(true);

    const created = createTenant({
      name: "North Kitchen",
      code: "north-kitchen",
      tagline: "Thakali · Pokhara",
      adminName: "Sita Gurung",
      adminPin: "778899",
      contactEmail: "sita@example.com",
      plan: "standard",
    });
    north = created.tenant;
    expect(created.adminPin).toBe("778899");

    south = createTenant({
      name: "South Cafe",
      code: "south-cafe",
      adminName: "Bikash Yadav",
      adminPin: "4321",
      plan: "free",
    }).tenant;
  });

  afterAll(() => {
    resetConnection();
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      const envKey =
        key === "dataDir"
          ? "RMS_DATA_DIR"
          : key === "dbPath"
            ? "RMS_DB_PATH"
            : key === "controlPath"
              ? "RMS_CONTROL_DB_PATH"
              : key === "env"
                ? "RMS_ENV"
                : "RMS_SECRET_KEY";
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  });

  it("creates the platform owner once and authenticates by email and password", () => {
    expect(platformSetupRequired()).toBe(false);
    const owner = controlGet<{ email: string }>("SELECT email FROM platform_users WHERE email = ?", DEMO_PLATFORM_EMAIL);
    expect(owner?.email).toBe(DEMO_PLATFORM_EMAIL);

    const { user } = signInPlatform(DEMO_PLATFORM_EMAIL, DEMO_PLATFORM_PASSWORD);
    expect(user.email).toBe(DEMO_PLATFORM_EMAIL);

    expect(() => signInPlatform(DEMO_PLATFORM_EMAIL, "wrong-password")).toThrow(/not correct/);
    expect(() => signInPlatform("nobody@example.com", DEMO_PLATFORM_PASSWORD)).toThrow(/not correct/);

    // Operators can be added, but not with a weak password.
    expect(() =>
      createPlatformUser({ name: "Ops", email: "ops@example.com", password: "short" }),
    ).toThrow(/at least 10 characters/);
    const ops = createPlatformUser({ name: "Ops", email: "ops@example.com", password: "a-long-operator-password" });
    expect(ops.isActive).toBe(true);
  });

  it("provisions an isolated database per restaurant with its own admin", () => {
    const file = path.join(tempDir, "tenants", "north-kitchen", "rms.db");
    expect(fs.existsSync(file)).toBe(true);

    const roles = withTenant(tenantScope(north), () => all<{ name: string }>("SELECT name FROM roles"));
    expect(roles.map((row) => row.name)).toContain("manager");
    expect(tenantAdminPinMatches(north, "778899")).toBe(true);
    expect(tenantAdminPinMatches(north, "4321")).toBe(false);

    const settings = withTenant(tenantScope(north), () =>
      get<{ value: string }>("SELECT value FROM settings WHERE key = 'restaurant_name'"),
    );
    expect(settings?.value).toBe("North Kitchen");

    // The blank starter ships no menu and no floor.
    expect(publicTenant(north).stats.menuItems).toBe(0);
    expect(publicTenant(north).stats.tables).toBe(0);
    expect(listTenants().map((tenant) => tenant.code).sort()).toEqual(["north-kitchen", "south-cafe"]);
    expect(tenantDirectory().some((entry) => entry.code === "south-cafe")).toBe(true);
  });

  it("keeps restaurant data physically separate", () => {
    withTenant(tenantScope(north), () => {
      run(
        `INSERT INTO menu_items (id, name, price, course, station, prep_minutes)
         VALUES ('item-north', 'North Momo', 25000, 'entree', 'grill', 8)`,
      );
      run(
        `INSERT INTO employees (id, name, pin, initials, is_active) VALUES ('emp-north', 'North Cook', '1111', 'NC', 1)`,
      );
    });

    // Nothing written in the North database appears in the South database.
    const southMenu = withTenant(tenantScope(south), () => all("SELECT id FROM menu_items"));
    const southStaff = withTenant(tenantScope(south), () => all<{ name: string }>("SELECT name FROM employees"));
    expect(southMenu).toHaveLength(0);
    expect(southStaff.map((row) => row.name)).not.toContain("North Cook");

    const northMenu = withTenant(tenantScope(north), () => all("SELECT id FROM menu_items"));
    expect(northMenu).toHaveLength(1);

    // The same PIN can exist in both restaurants because they are separate stores.
    expect(tenantAdminPinMatches(south, "4321")).toBe(true);
    expect(tenantAdminPinMatches(north, "4321")).toBe(false);
  });

  it("resolves a guest QR token to exactly one restaurant", () => {
    withTenant(tenantScope(south), () => {
      run("INSERT INTO qr_tokens (token, table_id, is_active) VALUES ('south-table-1', NULL, 1)");
    });
    expect(findTenantByGuestToken("south-table-1")?.code).toBe("south-cafe");
    expect(findTenantByGuestToken("missing-token")).toBeNull();
  });

  it("suspends a restaurant without destroying its data, then reactivates it", () => {
    const suspended = updateTenant(north.id, { status: "suspended" });
    expect(suspended.status).toBe("suspended");
    expect(suspended.suspendedAt).not.toBeNull();
    expect(listTenants().map((tenant) => tenant.code)).toEqual(["south-cafe"]);

    expect(() => runWithTenant(suspended, () => all("SELECT 1"))).toThrow(/suspended/);

    const reactivated = updateTenant(north.id, { status: "active" });
    expect(reactivated.status).toBe("active");
    expect(reactivated.suspendedAt).toBeNull();
    // Data survived the suspension.
    expect(withTenant(tenantScope(north), () => all("SELECT id FROM menu_items"))).toHaveLength(1);
  });

  it("lets the platform reset the restaurant admin PIN and audits it", () => {
    const updated = resetTenantAdminPin(north.id, "909090", { id: "platform-1", email: "owner@rms.local" }, "owner lost PIN");
    expect(updated.pinLength).toBe(6);
    expect(tenantAdminPinMatches(north, "909090")).toBe(true);
    expect(tenantAdminPinMatches(north, "778899")).toBe(false);

    const resets = controlGet<{ count: number }>(
      "SELECT COUNT(*) AS count FROM tenant_admin_resets WHERE tenant_id = ?",
      north.id,
    );
    expect(Number(resets?.count)).toBe(1);
    const audit = controlGet<{ action: string }>(
      "SELECT action FROM platform_audit WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      north.id,
    );
    expect(audit?.action).toBe("platform.tenant.reset_admin");
  });

  it("names a restaurant's signed session with its tenant id", () => {
    const token = issueToken("emp-north", { tenantId: north.id });
    const verified = verifyToken(token);
    expect(verified?.uid).toBe("emp-north");
    expect(verified?.tid).toBe(north.id);
    expect(verified?.scope).toBe("staff");

    const platformToken = issueToken("platform-1", { scope: "platform" });
    expect(verifyToken(platformToken)?.scope).toBe("platform");
    expect(verifyToken(platformToken)?.tid).toBeUndefined();
  });

  it("rejects duplicate codes, reserved codes and weak admin PINs", () => {
    expect(() =>
      createTenant({ name: "Another", code: "north-kitchen", adminName: "X", adminPin: "1234" }),
    ).toThrow(/already in use/);
    expect(() => createTenant({ name: "API", code: "api", adminName: "X", adminPin: "1234" })).toThrow(/reserved/);
    expect(() => createTenant({ name: "Weak", code: "weak-pin", adminName: "X", adminPin: "12" })).toThrow(/4 or 6 digits/);
    expect(() => createTenant({ name: "Bad Code", code: "Bad Code", adminName: "X", adminPin: "1234" })).toThrow(
      /lowercase letters/,
    );
  });

  it("rolls back the registry row when provisioning fails", () => {
    // Occupy the target database path so provisioning must refuse before writing.
    const code = "occupied-store";
    const folder = path.join(tempDir, "tenants", code);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "rms.db"), "not a database");

    expect(() => createTenant({ name: "Occupied", code, adminName: "X", adminPin: "1234" })).toThrow(/already exists/);
    expect(getTenantByCode(code)).toBeNull();
    expect(controlGet("SELECT id FROM tenants WHERE code = ?", code)).toBeUndefined();
  });

  it("removes a restaurant's files on an explicit destroy", () => {
    const doomed = createTenant({ name: "Doomed", code: "doomed-store", adminName: "X", adminPin: "1234" }).tenant;
    const file = tenantDbPath(doomed);
    expect(fs.existsSync(file)).toBe(true);
    destroyTenant(doomed.id);
    expect(fs.existsSync(file)).toBe(false);
    expect(getTenantByCode("doomed-store")).toBeNull();
    expect(controlGet("SELECT id FROM tenants WHERE id = ?", doomed.id)).toBeUndefined();
    void controlRun;
    void migrate;
  });
});
