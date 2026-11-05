/**
 * Production first-run setup.
 *
 * An empty production database receives schema only. A one-time setup token,
 * injected by the deployer, authorizes creation of the initial restaurant and
 * manager. No demo staff, menu, orders, or known PINs are written.
 */
import { timingSafeEqual } from "node:crypto";
import { get, run, tx, uuid } from "@/db/client";
import { seedCoreRoles, seedCoreStations } from "@/db/core";
import { nowStamp } from "@/domain/time";
import { isProduction } from "@/lib/session";
import { badRequest, conflict, forbidden } from "@/server/router";
import { hashPin, validatePin } from "@/server/staff";
import { audit } from "@/server/audit";

export function isSetupRequired(): boolean {
  return Number(get<{ count: number }>("SELECT COUNT(*) AS count FROM employees")?.count ?? 0) === 0;
}

export function productionSetupStatus(): { required: boolean; tokenConfigured: boolean; production: boolean } {
  return {
    required: isProduction() && isSetupRequired(),
    tokenConfigured: (process.env.RMS_SETUP_TOKEN ?? "").trim().length >= 32,
    production: isProduction(),
  };
}

function verifySetupToken(supplied: string): void {
  const expected = process.env.RMS_SETUP_TOKEN ?? "";
  if (expected.trim().length < 32) {
    throw badRequest("Initial setup is locked. Set RMS_SETUP_TOKEN to a random value of at least 32 characters and restart RMS.");
  }
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw forbidden("The setup token is not valid");
  }
}

export interface ProductionSetupInput {
  setupToken: string;
  restaurantName: string;
  tagline?: string;
  adminName: string;
  adminPin: string;
}

export function initializeProduction(input: ProductionSetupInput): { id: string; name: string; restaurantName: string } {
  if (!isProduction()) throw badRequest("Initial setup is available only in production mode");
  if (!isSetupRequired()) throw conflict("This restaurant has already been initialized");
  verifySetupToken(String(input.setupToken ?? ""));

  const restaurantName = String(input.restaurantName ?? "").trim();
  const adminName = String(input.adminName ?? "").trim();
  const adminPin = String(input.adminPin ?? "").trim();
  if (!restaurantName || restaurantName.length > 120) throw badRequest("Restaurant name is required and must be at most 120 characters");
  if (!adminName || adminName.length > 120) throw badRequest("Manager name is required and must be at most 120 characters");
  validatePin(adminPin);

  const managerId = uuid();
  tx(() => {
    // Re-check inside BEGIN IMMEDIATE so two simultaneous first-run requests
    // cannot create two different initial administrators.
    if (!isSetupRequired()) throw conflict("This restaurant has already been initialized");
    const roles = seedCoreRoles();
    seedCoreStations();
    const stamp = nowStamp();
    const settings: Record<string, string> = {
      restaurant_name: restaurantName,
      restaurant_tagline: String(input.tagline ?? "").trim(),
      legal_tax_entity: "",
      address: "",
      phone: "",
      website: "",
      logo_data_url: "",
      pan_vat: "",
      pin_length: String(adminPin.length),
      time_zone: process.env.RMS_TZ || "Asia/Kathmandu",
      seed_version: "rms-production-v1",
    };
    for (const [key, value] of Object.entries(settings)) {
      run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)", key, value, stamp);
    }
    const initials = adminName
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("");
    run(
      `INSERT INTO employees (id, name, role_id, pin, initials, color, phone, is_active, hire_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '', 1, ?, ?)`,
      managerId,
      adminName,
      roles.get("manager") ?? null,
      hashPin(adminPin),
      initials || "GM",
      "#0f6f66",
      stamp.slice(0, 10),
      stamp,
    );
    audit(null, "setup.initialize", "employee", managerId, `${restaurantName} · initial manager ${adminName}`);
  });

  return { id: managerId, name: adminName, restaurantName };
}
