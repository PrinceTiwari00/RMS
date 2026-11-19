/**
 * Restaurant registry and provisioning (the control-plane domain).
 *
 * Every restaurant ("tenant") owns a completely separate SQLite database at
 * `data/tenants/<code>/rms.db`. The control plane in `data/control.db` only
 * stores the registry row plus platform accounts, so no query in the ~40
 * operational tables can ever return another restaurant's row: the isolation is
 * the database file itself, not a WHERE clause somebody can forget.
 *
 * Provisioning a restaurant is the super-admin action: it creates the database,
 * installs the role matrix and station list, writes the store identity and
 * creates the restaurant administrator (the `manager` role, which already holds
 * every restaurant-level permission).
 */
import fs from "node:fs";
import path from "node:path";
import {
  closeConnection,
  controlGet,
  controlRun,
  controlAll,
  controlTx,
  dataDir,
  get,
  migrate,
  run,
  uuid,
  withTenant,
  type TenantScope,
} from "@/db/client";
import { seedCoreRoles, seedCoreStations } from "@/db/core";
import { seedIfEmpty } from "@/db/seed";
import { nowStamp } from "@/domain/time";
import { isDemoMode } from "@/lib/session-core";
import { hashPin, pinMatches } from "@/lib/pin";
import { planFor, planStaffLimit } from "@/domain/plans";
import { badRequest, conflict, forbidden, notFound } from "@/server/errors";
import { audit } from "@/server/audit";
import { platformAudit } from "@/server/platform";

export type TenantStatus = "active" | "suspended";
export type TenantPlan = "free" | "standard" | "pro";
export type TenantStarter = "blank" | "demo";

export interface Tenant {
  id: string;
  code: string;
  name: string;
  tagline: string;
  status: TenantStatus;
  plan: TenantPlan;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  /** Relative to the data directory, e.g. `tenants/terai-kitchen/rms.db`. */
  dbFile: string;
  adminEmployeeId: string;
  adminName: string;
  pinLength: 4 | 6;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
}

export interface TenantPublic {
  id: string;
  code: string;
  name: string;
  tagline: string;
  status: TenantStatus;
  plan: TenantPlan;
  /** Display name and seat cap of the plan (null cap = unlimited). */
  planName: string;
  staffLimit: number | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  adminName: string;
  pinLength: 4 | 6;
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  stats: TenantStats;
}

export interface TenantStats {
  staff: number;
  managers: number;
  menuItems: number;
  tables: number;
  openOrders: number;
  ordersToday: number;
  salesToday: number;
  lastActivityAt: string | null;
  dbBytes: number;
  healthy: boolean;
}

interface TenantRow {
  id: string;
  code: string;
  name: string;
  tagline: string;
  status: string;
  plan: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  notes: string;
  db_file: string;
  admin_employee_id: string;
  admin_name: string;
  pin_length: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  suspended_at: string | null;
}

const PLANS: readonly TenantPlan[] = ["free", "standard", "pro"];
const RESERVED_CODES = new Set([
  "api",
  "platform",
  "login",
  "logout",
  "setup",
  "admin",
  "t",
  "cfd",
  "pos",
  "kds",
  "expo",
  "prep",
  "floor",
  "host",
  "checkout",
  "static",
  "assets",
  "public",
  "rms",
]);

function mapRow(row: TenantRow): Tenant {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    tagline: row.tagline,
    status: row.status === "suspended" ? "suspended" : "active",
    plan: (PLANS as readonly string[]).includes(row.plan) ? (row.plan as TenantPlan) : "standard",
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    notes: row.notes,
    dbFile: row.db_file,
    adminEmployeeId: row.admin_employee_id,
    adminName: row.admin_name,
    pinLength: Number(row.pin_length) === 6 ? 6 : 4,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    suspendedAt: row.suspended_at,
  };
}

// ------------------------------------------------------------------- lookups

export function listTenants(options: { includeSuspended?: boolean } = {}): Tenant[] {
  const rows = controlAll<TenantRow>(
    options.includeSuspended
      ? "SELECT * FROM tenants ORDER BY created_at DESC"
      : "SELECT * FROM tenants WHERE status = 'active' ORDER BY created_at DESC",
  );
  return rows.map(mapRow);
}

export function getTenantById(id: string): Tenant | null {
  const row = controlGet<TenantRow>("SELECT * FROM tenants WHERE id = ?", id);
  return row ? mapRow(row) : null;
}

export function getTenantByCode(code: string): Tenant | null {
  const normalised = String(code ?? "").trim();
  if (!normalised) return null;
  const row = controlGet<TenantRow>("SELECT * FROM tenants WHERE code = ? COLLATE NOCASE", normalised);
  return row ? mapRow(row) : null;
}

export function countTenants(): number {
  return Number(controlGet<{ count: number }>("SELECT COUNT(*) AS count FROM tenants")?.count ?? 0);
}

/**
 * Public restaurant directory used by the PIN pad. Only the code, display name
 * and tagline are exposed — never contact details, plans or counts.
 */
export function tenantDirectory(): { code: string; name: string; tagline: string }[] {
  return listTenants().map((tenant) => ({ code: tenant.code, name: tenant.name, tagline: tenant.tagline }));
}

/** Set the directory behind an env switch for deployments that want secrecy. */
export function tenantDirectoryEnabled(): boolean {
  return process.env.RMS_TENANT_DIRECTORY === "1" || (isDemoMode() && process.env.RMS_TENANT_DIRECTORY !== "0");
}

// ------------------------------------------------------------------- scoping

export function tenantDbPath(tenant: Pick<Tenant, "dbFile">): string {
  return path.isAbsolute(tenant.dbFile) ? tenant.dbFile : path.join(dataDir(), tenant.dbFile);
}

export function tenantScope(tenant: Tenant): TenantScope {
  return { tenantId: tenant.id, dbPath: tenantDbPath(tenant) };
}

/** Run work against one restaurant's database. Suspended stores fail closed. */
export function runWithTenant<T>(tenant: Tenant, fn: () => T): T {
  if (tenant.status !== "active") {
    throw forbidden(`The ${tenant.name} workspace is suspended. Contact your platform administrator.`);
  }
  return withTenant(tenantScope(tenant), fn);
}

/** Run work against a restaurant even while suspended (platform administration). */
export function runWithTenantUnchecked<T>(tenant: Tenant, fn: () => T): T {
  return withTenant(tenantScope(tenant), fn);
}

/**
 * Guest QR tokens are public and only carry the opaque token, so the tenant is
 * resolved by looking for the token in each active restaurant database. The
 * number of restaurants on one instance is small (single-instance SQLite), and
 * the lookup short-circuits on the first match.
 */
export function findTenantByGuestToken(token: string): Tenant | null {
  if (!token || token.length > 200) return null;
  for (const tenant of listTenants()) {
    try {
      const found = runWithTenant(
        tenant,
        () =>
          get<{ token: string }>("SELECT token FROM qr_tokens WHERE token = ?", token) ??
          get<{ token: string }>(
            "SELECT q.token FROM qr_tokens q JOIN tables t ON t.id = q.table_id WHERE LOWER(t.label) = LOWER(?) AND q.is_active = 1 LIMIT 1",
            token,
          ),
      );
      if (found) return tenant;
    } catch {
      // A broken restaurant must not make guest ordering for others fail.
    }
  }
  return null;
}

/** Fallback for deployments with exactly one restaurant (the demo default). */
export function singleActiveTenant(): Tenant | null {
  const tenants = listTenants();
  return tenants.length === 1 ? tenants[0] : null;
}

// -------------------------------------------------------------- provisioning

export function slugify(input: string): string {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function assertCode(code: string): string {
  const normalised = slugify(code);
  if (normalised.length < 3) throw badRequest("Restaurant code must be at least 3 characters (letters, digits, dashes)");
  if (normalised !== code.trim().toLowerCase()) {
    throw badRequest("Restaurant code may only contain lowercase letters, digits and dashes");
  }
  if (RESERVED_CODES.has(normalised)) throw badRequest(`"${normalised}" is reserved by the application`);
  return normalised;
}

function assertPin(pin: string, label = "Restaurant admin PIN"): void {
  if (!/^\d{4}(\d{2})?$/.test(pin)) throw badRequest(`${label} must be 4 or 6 digits`);
}

function assertEmail(email: string): void {
  if (!email) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    throw badRequest("Contact email is not a valid address");
  }
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

const BRAND_COLORS = ["#0f6f66", "#c2542f", "#3d6ea8", "#8a5aa8", "#3f8f5f", "#a8546f"];

function writeBranding(tenant: Pick<Tenant, "name" | "tagline" | "pinLength">): void {
  const stamp = nowStamp();
  const settings: Record<string, string> = {
    restaurant_name: tenant.name,
    restaurant_tagline: tenant.tagline,
    time_zone: process.env.RMS_TZ || "Asia/Kathmandu",
    currency: "NPR",
    currency_symbol: "Rs",
    locale: "en-IN",
    pin_length: String(tenant.pinLength),
  };
  for (const [key, value] of Object.entries(settings)) {
    run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)", key, value, stamp);
  }
}

/** Create the restaurant administrator (manager role) inside the tenant scope. */
function installAdmin(tenant: Tenant, adminName: string, pin: string): string {
  const managerRoleId =
    get<{ id: string }>("SELECT id FROM roles WHERE name = 'manager'")?.id ?? seedCoreRoles().get("manager") ?? "";
  if (!managerRoleId) throw badRequest("The manager role could not be installed");

  // Reuse an existing manager in the demo starter so the sample restaurant does
  // not end up with two "owner" accounts.
  const existing = get<{ id: string; name: string }>(
    "SELECT e.id, e.name FROM employees e JOIN roles r ON r.id = e.role_id WHERE r.name = 'manager' ORDER BY e.created_at LIMIT 1",
  );
  const employeeId = existing?.id ?? uuid();
  if (existing) {
    run(
      "UPDATE employees SET name = ?, pin = ?, initials = ?, is_active = 1 WHERE id = ?",
      adminName,
      hashPin(pin),
      initialsOf(adminName) || "GM",
      employeeId,
    );
  } else {
    run(
      `INSERT INTO employees (id, name, role_id, pin, initials, color, phone, is_active, hire_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '', 1, ?, ?)`,
      employeeId,
      adminName,
      managerRoleId,
      hashPin(pin),
      initialsOf(adminName) || "GM",
      BRAND_COLORS[0],
      nowStamp().slice(0, 10),
      nowStamp(),
    );
  }
  run(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('pin_length', ?, ?)",
    String(tenant.pinLength),
    nowStamp(),
  );
  audit(null, "setup.initialize", "employee", employeeId, `${tenant.name} · restaurant admin ${adminName}`);
  return employeeId;
}

export interface CreateTenantInput {
  name: string;
  code?: string;
  tagline?: string;
  adminName: string;
  adminPin: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  plan?: string;
  notes?: string;
  starter?: TenantStarter;
  /** Platform account id recorded as the creator. */
  createdBy?: string | null;
}

export interface CreatedTenant {
  tenant: Tenant;
  adminPin: string;
}

export function createTenant(input: CreateTenantInput): CreatedTenant {
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 120) throw badRequest("Restaurant name is required and must be at most 120 characters");
  const adminName = String(input.adminName ?? "").trim();
  if (!adminName || adminName.length > 120) throw badRequest("Restaurant admin name is required and must be at most 120 characters");
  const adminPin = String(input.adminPin ?? "").trim();
  assertPin(adminPin);
  const contactEmail = String(input.contactEmail ?? "").trim();
  assertEmail(contactEmail);

  const code = assertCode(String(input.code ?? "").trim() || slugify(name));
  const plan = (PLANS as readonly string[]).includes(String(input.plan)) ? (String(input.plan) as TenantPlan) : "standard";
  const starter: TenantStarter = input.starter === "demo" ? "demo" : "blank";
  // Demo data is allowed in production only through the explicit seed escape
  // hatch the original deployment docs already use.
  const demoAllowed = isDemoMode();
  if (starter === "demo" && !demoAllowed) {
    throw badRequest("The demo starter is available only in demo mode; use a blank workspace in production");
  }
  if (getTenantByCode(code)) throw conflict(`Restaurant code "${code}" is already in use`);

  const tenant: Tenant = {
    id: uuid(),
    code,
    name,
    tagline: String(input.tagline ?? "").trim().slice(0, 160),
    status: "active",
    plan,
    contactName: String(input.contactName ?? "").trim().slice(0, 120),
    contactEmail,
    contactPhone: String(input.contactPhone ?? "").trim().slice(0, 40),
    notes: String(input.notes ?? "").trim().slice(0, 500),
    dbFile: path.join("tenants", code, "rms.db"),
    adminEmployeeId: "",
    adminName,
    pinLength: adminPin.length === 6 ? 6 : 4,
    createdBy: input.createdBy ?? null,
    createdAt: nowStamp(),
    updatedAt: nowStamp(),
    suspendedAt: null,
  };

  const absolute = tenantDbPath(tenant);
  if (fs.existsSync(absolute)) {
    throw conflict(`A database already exists at ${tenant.dbFile}; choose a different restaurant code`);
  }

  controlTx(() => {
    if (controlGet<{ id: string }>("SELECT id FROM tenants WHERE code = ? COLLATE NOCASE", code)) {
      throw conflict(`Restaurant code "${code}" is already in use`);
    }
    controlRun(
      `INSERT INTO tenants
         (id, code, name, tagline, status, plan, contact_name, contact_email, contact_phone, notes, db_file,
          admin_employee_id, admin_name, pin_length, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
      tenant.id,
      tenant.code,
      tenant.name,
      tenant.tagline,
      tenant.plan,
      tenant.contactName,
      tenant.contactEmail,
      tenant.contactPhone,
      tenant.notes,
      tenant.dbFile,
      tenant.adminName,
      tenant.pinLength,
      tenant.createdBy,
      tenant.createdAt,
      tenant.updatedAt,
    );
  });

  try {
    const adminEmployeeId = withTenant(tenantScope(tenant), () => {
      migrate();
      if (starter === "demo") {
        seedIfEmpty();
      } else {
        seedCoreRoles();
        seedCoreStations();
        run(
          "INSERT OR REPLACE INTO terminals (id, name, area, kind, is_active) VALUES ('term-pos-1', 'Register 1', 'main', 'pos', 1)",
        );
      }
      writeBranding(tenant);
      return installAdmin(tenant, adminName, adminPin);
    });
    controlRun("UPDATE tenants SET admin_employee_id = ? WHERE id = ?", adminEmployeeId, tenant.id);
    return { tenant: { ...tenant, adminEmployeeId }, adminPin };
  } catch (error) {
    // Provisioning is all-or-nothing: leave no half-built restaurant behind.
    try {
      closeConnection(absolute);
      fs.rmSync(path.dirname(absolute), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    controlRun("DELETE FROM tenants WHERE id = ?", tenant.id);
    throw error;
  }
}

export interface UpdateTenantInput {
  name?: string;
  tagline?: string;
  status?: string;
  plan?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
}

export function updateTenant(id: string, patch: UpdateTenantInput): Tenant {
  const tenant = getTenantById(id);
  if (!tenant) throw notFound("Restaurant not found");

  const name = patch.name !== undefined ? String(patch.name).trim() : tenant.name;
  if (!name || name.length > 120) throw badRequest("Restaurant name must be 1–120 characters");
  const status = patch.status !== undefined ? String(patch.status) : tenant.status;
  if (status !== "active" && status !== "suspended") throw badRequest("Status must be active or suspended");
  const plan =
    patch.plan !== undefined
      ? (PLANS as readonly string[]).includes(String(patch.plan))
        ? (patch.plan as TenantPlan)
        : null
      : tenant.plan;
  if (plan === null) throw badRequest("Plan must be free, standard or pro");
  const contactEmail = patch.contactEmail !== undefined ? String(patch.contactEmail).trim() : tenant.contactEmail;
  assertEmail(contactEmail);

  const suspendedAt = status === "suspended" ? tenant.suspendedAt ?? nowStamp() : null;
  controlRun(
    `UPDATE tenants SET name = ?, tagline = ?, status = ?, plan = ?, contact_name = ?, contact_email = ?,
            contact_phone = ?, notes = ?, updated_at = ?, suspended_at = ?
      WHERE id = ?`,
    name,
    patch.tagline !== undefined ? String(patch.tagline).trim().slice(0, 160) : tenant.tagline,
    status,
    plan,
    patch.contactName !== undefined ? String(patch.contactName).trim().slice(0, 120) : tenant.contactName,
    contactEmail,
    patch.contactPhone !== undefined ? String(patch.contactPhone).trim().slice(0, 40) : tenant.contactPhone,
    patch.notes !== undefined ? String(patch.notes).trim().slice(0, 500) : tenant.notes,
    nowStamp(),
    suspendedAt,
    id,
  );

  // Keep the restaurant's own store identity in step when the platform renames it.
  if (name !== tenant.name || (patch.tagline !== undefined && patch.tagline !== tenant.tagline)) {
    try {
      withTenant(tenantScope(tenant), () => {
        const stamp = nowStamp();
        run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('restaurant_name', ?, ?)", name, stamp);
        if (patch.tagline !== undefined) {
          run(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('restaurant_tagline', ?, ?)",
            String(patch.tagline).trim().slice(0, 160),
            stamp,
          );
        }
      });
    } catch {
      // The registry is authoritative; a broken tenant file must not block a
      // suspension or a rename in the control plane.
    }
  }

  const updated = getTenantById(id);
  if (!updated) throw notFound("Restaurant not found");
  return updated;
}

/**
 * Reset the restaurant administrator's PIN. The platform can hand the
 * restaurant back to its owner without reading any restaurant data.
 */
export function resetTenantAdminPin(id: string, pin: string, actor: { id: string; email: string }, reason = ""): Tenant {
  const tenant = getTenantById(id);
  if (!tenant) throw notFound("Restaurant not found");
  assertPin(pin, "New admin PIN");

  withTenant(tenantScope(tenant), () => {
    migrate();
    const managerRoleId = get<{ id: string }>("SELECT id FROM roles WHERE name = 'manager'")?.id ?? "";
    if (!managerRoleId) throw badRequest("This restaurant has no manager role; the workspace may need to be recreated");
    let employee = get<{ id: string }>(
      "SELECT id FROM employees WHERE id = ? AND is_active = 1",
      tenant.adminEmployeeId,
    );
    if (!employee) {
      employee = get<{ id: string }>(
        "SELECT e.id FROM employees e JOIN roles r ON r.id = e.role_id WHERE r.name = 'manager' AND e.is_active = 1 ORDER BY e.created_at LIMIT 1",
      );
    }
    if (employee) {
      run("UPDATE employees SET pin = ? WHERE id = ?", hashPin(pin), employee.id);
      controlRun("UPDATE tenants SET admin_employee_id = ? WHERE id = ?", employee.id, id);
    } else {
      const employeeId = uuid();
      run(
        `INSERT INTO employees (id, name, role_id, pin, initials, color, phone, is_active, hire_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '', 1, ?, ?)`,
        employeeId,
        tenant.adminName || `${tenant.name} Admin`,
        managerRoleId,
        hashPin(pin),
        initialsOf(tenant.adminName || tenant.name),
        BRAND_COLORS[0],
        nowStamp().slice(0, 10),
        nowStamp(),
      );
      controlRun("UPDATE tenants SET admin_employee_id = ? WHERE id = ?", employeeId, id);
    }
    audit(null, "admin.employee.pin_reset", "employee", tenant.adminEmployeeId, "Platform administrator reset the admin PIN");
  });

  controlRun(
    "INSERT INTO tenant_admin_resets (id, tenant_id, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?)",
    uuid(),
    id,
    actor.id,
    String(reason ?? "").slice(0, 300),
    nowStamp(),
  );
  controlRun(
    "UPDATE tenants SET pin_length = ?, updated_at = ? WHERE id = ?",
    pin.length === 6 ? 6 : 4,
    nowStamp(),
    id,
  );
  // Recorded in the control plane as well: a PIN reset is a security event that
  // must survive a restore of the restaurant's own database.
  platformAudit(actor, "platform.tenant.reset_admin", tenant, `admin ${tenant.adminName} · ${reason || "no reason given"}`);

  const updated = getTenantById(id);
  if (!updated) throw notFound("Restaurant not found");
  return updated;
}

/** Delete a restaurant's files. Deliberately not exposed over the API. */
export function destroyTenant(id: string): void {
  const tenant = getTenantById(id);
  if (!tenant) throw notFound("Restaurant not found");
  const absolute = tenantDbPath(tenant);
  closeConnection(absolute);
  fs.rmSync(path.dirname(absolute), { recursive: true, force: true });
  controlRun("DELETE FROM tenants WHERE id = ?", id);
}

// --------------------------------------------------------------------- stats

const EMPTY_STATS: TenantStats = {
  staff: 0,
  managers: 0,
  menuItems: 0,
  tables: 0,
  openOrders: 0,
  ordersToday: 0,
  salesToday: 0,
  lastActivityAt: null,
  dbBytes: 0,
  healthy: false,
};

export function tenantStats(tenant: Tenant): TenantStats {
  const absolute = tenantDbPath(tenant);
  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(absolute).size;
  } catch {
    dbBytes = 0;
  }

  try {
    const stats = withTenant(tenantScope(tenant), () => {
      const row = get<{
        staff: number;
        managers: number;
        menu_items: number;
        tables: number;
        open_orders: number;
        orders_today: number;
        sales_today: number;
        orders_last: string | null;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM employees WHERE is_active = 1) AS staff,
           (SELECT COUNT(*) FROM employees e JOIN roles r ON r.id = e.role_id WHERE r.name = 'manager' AND e.is_active = 1) AS managers,
           (SELECT COUNT(*) FROM menu_items) AS menu_items,
           (SELECT COUNT(*) FROM tables) AS tables,
           (SELECT COUNT(*) FROM orders WHERE status IN ('open','sent')) AS open_orders,
           (SELECT COUNT(*) FROM orders WHERE business_date = date('now')) AS orders_today,
           (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status = 'closed' AND business_date = date('now')) AS sales_today,
           (SELECT MAX(created_at) FROM orders) AS orders_last`,
      );
      return {
        staff: Number(row?.staff ?? 0),
        managers: Number(row?.managers ?? 0),
        menuItems: Number(row?.menu_items ?? 0),
        tables: Number(row?.tables ?? 0),
        openOrders: Number(row?.open_orders ?? 0),
        ordersToday: Number(row?.orders_today ?? 0),
        salesToday: Number(row?.sales_today ?? 0),
        lastActivityAt: row?.orders_last ?? null,
      };
    });
    return { ...stats, dbBytes, healthy: true };
  } catch {
    return { ...EMPTY_STATS, dbBytes, healthy: false };
  }
}

export function publicTenant(tenant: Tenant): TenantPublic {
  return {
    id: tenant.id,
    code: tenant.code,
    name: tenant.name,
    tagline: tenant.tagline,
    status: tenant.status,
    plan: tenant.plan,
    planName: planFor(tenant.plan).name,
    staffLimit: planStaffLimit(tenant.plan),
    contactName: tenant.contactName,
    contactEmail: tenant.contactEmail,
    contactPhone: tenant.contactPhone,
    notes: tenant.notes,
    adminName: tenant.adminName,
    pinLength: tenant.pinLength,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
    suspendedAt: tenant.suspendedAt,
    stats: tenantStats(tenant),
  };
}

/**
 * Demo bootstrap: one ready-to-use restaurant so `npm run dev` still lands on a
 * working floor. The demo tenant's admin is the documented Rajesh/2468 account.
 */
export function ensureDemoTenant(): Tenant {
  const existing = getTenantByCode("terai-kitchen");
  if (existing) return existing;
  try {
    return createTenant({
      name: "Terai Kitchen & Bar",
      code: "terai-kitchen",
      tagline: "Nepali · Indian · Continental",
      adminName: "Rajesh Kumar Sah",
      adminPin: "2468",
      contactName: "Rajesh Kumar Sah",
      contactEmail: "rajesh@teraikitchen.example",
      contactPhone: "+977 981 234 5678",
      plan: "pro",
      notes: "Demo workspace seeded with sample menu, floor, staff and 14 days of history.",
      starter: "demo",
      createdBy: null,
    }).tenant;
  } catch (error) {
    // Another request (or the seed script) may have won the race; the registry
    // row is the source of truth either way.
    const raced = getTenantByCode("terai-kitchen");
    if (raced) return raced;
    throw error;
  }
}

/** Verify a restaurant admin PIN without opening a staff session (CLI/tests). */
export function tenantAdminPinMatches(tenant: Tenant, pin: string): boolean {
  return withTenant(tenantScope(tenant), () => {
    const row = get<{ pin: string }>("SELECT pin FROM employees WHERE id = ?", tenant.adminEmployeeId);
    return Boolean(row && pinMatches(row.pin, pin));
  });
}
