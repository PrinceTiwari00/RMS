import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { get, scalar } from "@/db/client";
import { ensureDatabase } from "@/db/boot";
import { initializeProduction, productionSetupStatus } from "@/server/bootstrap";
import { signInWithPin } from "@/server/staff";

const previousEnvironment = process.env.RMS_ENV;
const previousSecret = process.env.RMS_SECRET_KEY;
const previousToken = process.env.RMS_SETUP_TOKEN;
const setupToken = "test-only-production-setup-token-0123456789abcdef";
const managerPin = "642810";

describe("production first-run bootstrap", () => {
  beforeAll(() => {
    process.env.RMS_DB_PATH = ":memory:";
    process.env.RMS_ENV = "production";
    process.env.RMS_SECRET_KEY = "test-only-production-session-secret-0123456789abcdef";
    delete process.env.RMS_SETUP_TOKEN;
    ensureDatabase();
  });

  afterAll(() => {
    if (previousEnvironment === undefined) delete process.env.RMS_ENV;
    else process.env.RMS_ENV = previousEnvironment;
    if (previousSecret === undefined) delete process.env.RMS_SECRET_KEY;
    else process.env.RMS_SECRET_KEY = previousSecret;
    if (previousToken === undefined) delete process.env.RMS_SETUP_TOKEN;
    else process.env.RMS_SETUP_TOKEN = previousToken;
  });

  it("migrates an empty production database without demo records", () => {
    expect(Number(scalar("SELECT COUNT(*) FROM employees") ?? -1)).toBe(0);
    expect(Number(scalar("SELECT COUNT(*) FROM orders") ?? -1)).toBe(0);
    expect(Number(scalar("SELECT COUNT(*) FROM menu_items") ?? -1)).toBe(0);
    expect(Number(scalar("SELECT COUNT(*) FROM roles") ?? -1)).toBe(0);
    expect(productionSetupStatus()).toEqual({ required: true, tokenConfigured: false, production: true });
  });

  it("requires a configured deployment token and rejects an incorrect one", () => {
    const input = { restaurantName: "Test Bistro", adminName: "Production Manager", adminPin: managerPin, setupToken };
    expect(() => initializeProduction(input)).toThrow(/RMS_SETUP_TOKEN/);
    process.env.RMS_SETUP_TOKEN = setupToken;
    expect(() => initializeProduction({ ...input, setupToken: `wrong-${setupToken}` })).toThrow(/not valid/);
    expect(Number(scalar("SELECT COUNT(*) FROM employees") ?? -1)).toBe(0);
  });

  it("creates only core configuration and a hashed manager, then closes setup", () => {
    process.env.RMS_SETUP_TOKEN = setupToken;
    const manager = initializeProduction({
      restaurantName: "Test Bistro",
      tagline: "Production smoke test",
      adminName: "Production Manager",
      adminPin: managerPin,
      setupToken,
    });
    expect(manager.name).toBe("Production Manager");
    expect(Number(scalar("SELECT COUNT(*) FROM employees") ?? 0)).toBe(1);
    expect(Number(scalar("SELECT COUNT(*) FROM roles") ?? 0)).toBe(8);
    expect(Number(scalar("SELECT COUNT(*) FROM orders") ?? -1)).toBe(0);
    expect(Number(scalar("SELECT COUNT(*) FROM menu_items") ?? -1)).toBe(0);
    expect(get<{ pin: string }>("SELECT pin FROM employees WHERE id = ?", manager.id)?.pin).toMatch(/^scrypt\$/);
    expect(get<{ pin: string }>("SELECT pin FROM employees WHERE id = ?", manager.id)?.pin).not.toContain(managerPin);
    expect(get<{ value: string }>("SELECT value FROM settings WHERE key = 'restaurant_name'")?.value).toBe("Test Bistro");

    const audits = JSON.stringify(get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'setup.initialize'"));
    expect(audits).not.toContain(setupToken);
    expect(audits).not.toContain(managerPin);
    expect(signInWithPin(managerPin, false).user.id).toBe(manager.id);
    expect(productionSetupStatus().required).toBe(false);
    expect(() => initializeProduction({ restaurantName: "Other", adminName: "Other Admin", adminPin: "135790", setupToken })).toThrow(/already been initialized/);
  });
});
