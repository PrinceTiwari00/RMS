/**
 * Database bootstrap.
 *
 * Kept separate from `db/client` on purpose: `seed.ts` imports the client, so
 * putting the seeding call inside the client would create an import cycle. Both
 * the API entrypoint and server components call `ensureDatabase()` before
 * touching a table.
 *
 * Since the platform layer exists, "boot" means three things:
 *   1. create/migrate the control-plane database (registry + platform accounts),
 *   2. ensure a platform account exists (demo seed, or env-provided credentials),
 *   3. in demo mode, ensure the sample restaurant and its demo tenant database.
 *
 * The legacy single-store database is still migrated so a production install can
 * use the original `/setup` flow without any platform account.
 */
import { db, migrate, migrateControl } from "@/db/client";
import { ensurePlatformBootstrap } from "@/server/platform";
import { ensureDemoTenant } from "@/server/tenant";
import { isProduction, validateProductionEnvironment } from "@/lib/session";

let ready = false;

export function ensureDatabase(): void {
  if (ready) return;
  validateProductionEnvironment();
  migrateControl();
  ensurePlatformBootstrap();
  // The legacy/single-store file is still schema-migrated so `/setup` and the
  // original deployment path keep working.
  migrate();
  // Demo identities are opt-in development data, never a production recovery
  // mechanism. Production restaurants are created by a platform admin.
  if (!isProduction()) {
    ensureDemoTenant();
  }
  // Touch the handle so a permissions or path problem fails during boot rather
  // than halfway through the first query.
  db();
  ready = true;
}

/** True once this process has opened, migrated and seeded the databases. */
export function isDatabaseReady(): boolean {
  return ready;
}
