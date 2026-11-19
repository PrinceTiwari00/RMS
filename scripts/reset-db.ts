/**
 * Rebuild the platform registry and the demo restaurant from scratch: delete the
 * control database, every restaurant database and the legacy single-store file,
 * then re-run migrations and re-seed.
 *
 *   npm run db:reset
 *
 * Run through vite-node so the `@/` path alias resolves the same way it does
 * under Next.js and vitest — plain `node --experimental-strip-types` cannot see
 * tsconfig paths.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.RMS_ENV?.toLowerCase() !== "demo" || process.env.NODE_ENV === "production" || process.env.RMS_ALLOW_RESET !== "1") {
  throw new Error("Destructive demo reset requires RMS_ENV=demo, RMS_ALLOW_RESET=1 and a non-production Node environment. Never reset real restaurant data.");
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dataDir = process.env.RMS_DATA_DIR ?? join(root, "data");
const dbPath = process.env.RMS_DB_PATH ?? join(dataDir, "rms.db");
const controlPath = process.env.RMS_CONTROL_DB_PATH ?? join(dataDir, "control.db");

function removeDatabase(target: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
}

// Remove the database and its WAL/SHM sidecars before anything opens a handle.
if (existsSync(dataDir)) {
  for (const entry of readdirSync(dataDir)) {
    if (entry.startsWith(`${dbPath.split("/").pop()}`)) rmSync(join(dataDir, entry), { force: true });
  }
}
removeDatabase(dbPath);
removeDatabase(controlPath);
rmSync(join(dataDir, "tenants"), { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

process.env.RMS_DB_PATH = dbPath;

const { migrate, migrateControl, resetConnection } = await import("@/db/client");
const { ensurePlatformBootstrap, DEMO_PLATFORM_EMAIL, DEMO_PLATFORM_PASSWORD } = await import("@/server/platform");
const { ensureDemoTenant } = await import("@/server/tenant");

resetConnection();
migrateControl();
ensurePlatformBootstrap();
migrate();
const tenant = ensureDemoTenant();

console.log(`[rms] database reset: ${dataDir}`);
console.log(`[rms] control plane: ${controlPath}`);
console.log(`[rms] demo restaurant: ${tenant.name} (code ${tenant.code})`);
console.log(`[rms] platform owner: ${DEMO_PLATFORM_EMAIL} / ${DEMO_PLATFORM_PASSWORD} (demo only)`);
console.log(`[rms] staff sign in: restaurant code "${tenant.code}", manager PIN 2468`);
