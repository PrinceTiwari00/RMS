/**
 * Populate the platform and the demo restaurant if they are empty.
 *
 *   npm run db:seed
 *
 * Idempotent: the platform account and the demo tenant are only created when
 * missing, so this is safe to run on every boot. The demo restaurant lives in
 * `data/tenants/terai-kitchen/rms.db`; the registry that points at it lives in
 * `data/control.db`. Use `npm run db:reset` to erase everything and rebuild.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const productionMode = process.env.RMS_ENV
  ? process.env.RMS_ENV.toLowerCase() === "production"
  : process.env.NODE_ENV === "production";
if (productionMode && process.env.RMS_ALLOW_DEMO_SEED !== "1") {
  throw new Error(
    "Refusing to install demo accounts in production. Create the platform owner from /platform and restaurants from the console.",
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dataDir = process.env.RMS_DATA_DIR ?? join(root, "data");
const dbPath = process.env.RMS_DB_PATH ?? join(dataDir, "rms.db");
mkdirSync(dirname(dbPath), { recursive: true });
process.env.RMS_DB_PATH = dbPath;

const { migrate, migrateControl } = await import("@/db/client");
const { ensurePlatformBootstrap, DEMO_PLATFORM_EMAIL, DEMO_PLATFORM_PASSWORD } = await import("@/server/platform");
const { ensureDemoTenant } = await import("@/server/tenant");

migrateControl();
const platform = ensurePlatformBootstrap();
migrate();
const tenant = ensureDemoTenant();

console.log(`[rms] control plane: ${process.env.RMS_CONTROL_DB_PATH ?? join(dataDir, "control.db")}`);
if (platform.created) {
  console.log(
    platform.demo
      ? `[rms] platform owner seeded: ${DEMO_PLATFORM_EMAIL} / ${DEMO_PLATFORM_PASSWORD} (demo only)`
      : "[rms] platform owner created from RMS_PLATFORM_EMAIL",
  );
} else {
  console.log("[rms] platform already initialized, nothing to do");
}
console.log(`[rms] demo restaurant: ${tenant.name} (code ${tenant.code}) at ${tenant.dbFile}`);
console.log(`[rms] sign in at /login with restaurant code "${tenant.code}" and PIN 2468`);
