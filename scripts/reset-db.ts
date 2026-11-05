/**
 * Rebuild the demo database from scratch: delete the SQLite files, re-run the
 * migration and re-seed.
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

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dbPath = process.env.RMS_DB_PATH ?? join(root, "data", "rms.db");

// Remove the database and its WAL/SHM sidecars before anything opens a handle.
const dataDir = dirname(dbPath);
if (existsSync(dataDir)) {
  for (const entry of readdirSync(dataDir)) {
    if (entry.startsWith(`${dbPath.split("/").pop()}`)) rmSync(join(dataDir, entry), { force: true });
  }
}
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
mkdirSync(dataDir, { recursive: true });

process.env.RMS_DB_PATH = dbPath;

const { migrate, resetConnection } = await import("@/db/client");
const { seedIfEmpty } = await import("@/db/seed");

resetConnection();
migrate();
const { seeded } = seedIfEmpty();

console.log(`[rms] database reset: ${dbPath}`);
console.log(`[rms] seed: ${seeded ? "demo data written" : "already populated"}`);
