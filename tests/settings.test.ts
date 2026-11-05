import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { get, migrate } from "@/db/client";
import { getRawSettings, getSettings, SECRET_MASK, setSettings } from "@/server/settings";
import { createEmployee, createRole, setRolePermissions } from "@/server/staff";
import { permissionsFor } from "@/domain/permissions";
import { authorizeSensitiveAction } from "@/server/approvals";
import type { SessionUser } from "@/types";

const dbFile = path.join(os.tmpdir(), `rms-settings-${process.pid}-${Date.now()}.db`);
process.env.RMS_DB_PATH = dbFile;

describe("settings portal persistence", () => {
  beforeAll(() => {
    fs.rmSync(dbFile, { force: true });
    migrate();
  });

  it("projects service style, security and localization settings", () => {
    setSettings(
      {
        vat_rate: "8.25",
        operating_mode: "quick_service",
        seat_tracking_enabled: "0",
        pin_length: "6",
        store_forward_limit: "50000",
        time_zone: "America/New_York",
      },
      null,
    );
    const settings = getSettings();
    expect(settings.vatRate).toBe(8.25);
    expect(settings.operatingMode).toBe("quick_service");
    expect(settings.seatTrackingEnabled).toBe(false);
    expect(settings.pinLength).toBe(6);
    expect(settings.storeForwardLimit).toBe(50000);
    expect(settings.timeZone).toBe("America/New_York");
  });

  it("masks saved credentials and preserves them when the mask is submitted", () => {
    setSettings({ twilio_auth_token: "twilio-secret-value" }, null);
    expect(getRawSettings().twilio_auth_token).toBe(SECRET_MASK);
    expect(getRawSettings().twilio_auth_token).not.toContain("twilio-secret-value");

    setSettings({ twilio_auth_token: SECRET_MASK, sendgrid_api_key: "sendgrid-secret" }, null);
    expect(get<{ value: string }>("SELECT value FROM settings WHERE key = 'twilio_auth_token'")?.value).toBe("twilio-secret-value");
    expect(getRawSettings().sendgrid_api_key).toBe(SECRET_MASK);

    process.env.RMS_TWILIO_AUTH_TOKEN = "environment-only-secret";
    expect(getRawSettings().twilio_auth_token).toBe(SECRET_MASK);
    expect(() => setSettings({ twilio_auth_token: "browser-replacement" }, null)).toThrow(/deployment environment/);
    delete process.env.RMS_TWILIO_AUTH_TOKEN;
  });

  it("validates the whole patch before writing any value", () => {
    setSettings({ restaurant_name: "Before validation", vat_rate: "13" }, null);
    expect(() => setSettings({ restaurant_name: "Should not persist", vat_rate: "101" }, null)).toThrow(/between 0 and 100/);
    expect(getSettings().restaurantName).toBe("Before validation");
    expect(getSettings().vatRate).toBe(13);
    expect(() => setSettings({ time_zone: "Not/A_Real_Zone" }, null)).toThrow(/valid IANA/);
  });

  it("accepts structured KDS routes and rejects malformed JSON", () => {
    setSettings({ kds_routing: JSON.stringify({ "cat-bar": "bar", "cat-western": "grill" }) }, null);
    expect(getSettings().kdsRouting).toEqual({ "cat-bar": "bar", "cat-western": "grill" });
    expect(() => setSettings({ kds_routing: "not-json" }, null)).toThrow(/valid JSON/);
  });

  it("uses a persisted role matrix verbatim, including revocations", () => {
    const role = createRole({ title: "Test Shift Lead", hourlyRate: 30000, permissions: ["pos.open", "pos.void"] }, null);
    const updated = setRolePermissions(role.id, ["kds.view"], null);
    expect(updated.permissions).toEqual(["kds.view"]);
    const effective = permissionsFor(role.name, updated.permissions);
    expect(effective).toEqual(["kds.view"]);
    expect(effective).not.toContain("pos.open");
    expect(effective).not.toContain("pos.void");
  });

  it("enforces manager-PIN approvals without logging the PIN", () => {
    setSettings({ pin_length: "6", require_manager_pin_void: "1" }, null);
    const managerRole = createRole({ title: "General Manager", name: "manager", permissions: ["admin.users"] }, null);
    createEmployee({ name: "Approval Manager", roleId: managerRole.id, pin: "123456" }, null);
    const server: SessionUser = {
      id: "server-test",
      name: "Test Server",
      initials: "TS",
      color: "#000000",
      role: "server",
      roleTitle: "Server",
      permissions: ["pos.open"],
    };

    expect(() => authorizeSensitiveAction(server, "void", "")).toThrow(/manager PIN is required/);
    expect(() => authorizeSensitiveAction(server, "void", "000000")).toThrow(/not valid/);
    expect(authorizeSensitiveAction(server, "void", "123456")?.name).toBe("Approval Manager");

    setSettings({ require_manager_pin_void: "0" }, null);
    expect(() => authorizeSensitiveAction(server, "void")).toThrow(/pos.void/);
    expect(authorizeSensitiveAction({ ...server, permissions: ["pos.open", "pos.void"] }, "void")).toBeNull();
  });
});
