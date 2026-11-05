import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPlanToPermissions, planFor, PLAN_DEFINITIONS } from "@/domain/plans";
import type { Permission } from "@/domain/permissions";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rms-plans-"));
const previous = {
  dataDir: process.env.RMS_DATA_DIR,
  controlPath: process.env.RMS_CONTROL_DB_PATH,
  dbPath: process.env.RMS_DB_PATH,
  env: process.env.RMS_ENV,
};

process.env.RMS_DATA_DIR = tempDir;
process.env.RMS_CONTROL_DB_PATH = path.join(tempDir, "control.db");
process.env.RMS_DB_PATH = path.join(tempDir, "legacy.db");
process.env.RMS_ENV = "demo";

const { get, migrate, migrateControl, resetConnection, withTenant } = await import("@/db/client");
const { createTenant, tenantScope, updateTenant } = await import("@/server/tenant");
const { createEmployee, deactivateEmployee } = await import("@/server/staff");
const { loadUser } = await import("@/server/identity");

import type { Tenant } from "@/server/tenant";

let tenant: Tenant;
let adminId: string;

const ALL: Permission[] = ["pos.open", "admin.inventory", "reports.executive", "admin.settings", "kds.bump"];

describe("plan entitlements", () => {
  beforeAll(() => {
    migrateControl();
    migrate();
    tenant = createTenant({
      name: "Starter Kitchen",
      code: "starter-kitchen",
      adminName: "Plan Admin",
      adminPin: "1357",
      plan: "free",
    }).tenant;
    adminId = tenant.adminEmployeeId;
  });

  afterAll(() => {
    resetConnection();
    fs.rmSync(tempDir, { recursive: true, force: true });
    const keys: Record<string, string | undefined> = {
      RMS_DATA_DIR: previous.dataDir,
      RMS_CONTROL_DB_PATH: previous.controlPath,
      RMS_DB_PATH: previous.dbPath,
      RMS_ENV: previous.env,
    };
    for (const [key, value] of Object.entries(keys)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("keeps starter from back-office supply chain and analytics, but not service", () => {
    const filtered = applyPlanToPermissions("free", ALL);
    expect(filtered).toContain("pos.open");
    expect(filtered).toContain("admin.settings");
    expect(filtered).not.toContain("admin.inventory");
    expect(filtered).not.toContain("reports.executive");
    expect(filtered).not.toContain("admin.purchasing");
    expect(filtered).not.toContain("admin.schedule");
    // Expo bumping is core service and stays available on Starter.
    expect(filtered).toContain("kds.bump");

    // Standard and pro carry the full role matrix.
    expect(applyPlanToPermissions("standard", ALL)).toEqual(ALL);
    expect(applyPlanToPermissions("pro", ALL)).toEqual(ALL);
    // Unknown plans fall back to Standard rather than silently stripping access.
    expect(applyPlanToPermissions("legacy-plan", ALL)).toEqual(ALL);
  });

  it("caps the manager's effective permissions by the restaurant plan", () => {
    const user = withTenant(tenantScope(tenant), () => loadUser(adminId));
    expect(user).not.toBeNull();
    expect(user!.permissions).toContain("pos.open");
    expect(user!.permissions).toContain("admin.users");
    expect(user!.permissions).not.toContain("admin.inventory");
    expect(user!.permissions).not.toContain("reports.executive");
  });

  it("blocks adding staff beyond the plan's seat count", () => {
    // The provisioning admin already occupies one seat (limit is 8).
    withTenant(tenantScope(tenant), () => {
      for (let index = 1; index <= 7; index += 1) {
        createEmployee({ name: `Starter Staff ${index}`, pin: `20${String(index).padStart(2, "0")}` }, null);
      }
    });

    expect(() =>
      withTenant(tenantScope(tenant), () =>
        createEmployee({ name: "One Too Many", pin: "2999" }, null),
      ),
    ).toThrow(/allows 8 active staff/);

    // Deactivating is always allowed and frees a seat for a replacement.
    withTenant(tenantScope(tenant), () => {
      const target = get<{ id: string; name: string }>(
        "SELECT id, name FROM employees WHERE is_active = 1 AND name LIKE 'Starter Staff%' ORDER BY name LIMIT 1",
      );
      expect(target).toBeDefined();
      deactivateEmployee(target!.id, null);
      const replacement = createEmployee({ name: "Replacement", pin: "2998" }, null);
      expect(replacement.isActive).toBe(true);
      // The administrator must never be the one deactivated by a seat test.
      expect(get<{ is_active: number }>("SELECT is_active FROM employees WHERE id = ?", tenant.adminEmployeeId)?.is_active).toBe(1);
    });
  });

  it("lifts the cap immediately when the platform changes the plan", () => {
    updateTenant(tenant.id, { plan: "pro" });

    withTenant(tenantScope(tenant), () => {
      const created = createEmployee({ name: "Ninth Staff", pin: "2999" }, null);
      expect(created.isActive).toBe(true);
      const user = loadUser(adminId);
      expect(user?.permissions).toContain("admin.inventory");
      expect(user?.permissions).toContain("reports.executive");
    });
  });

  it("exposes the plan catalogue for the console", () => {
    expect(PLAN_DEFINITIONS.map((plan) => plan.id)).toEqual(["free", "standard", "pro"]);
    expect(planFor("free").maxStaff).toBe(8);
    expect(planFor("standard").maxStaff).toBe(30);
    expect(planFor("pro").maxStaff).toBeNull();
  });
});
