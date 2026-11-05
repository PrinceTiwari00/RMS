/**
 * Populate the demo database if it is empty.
 *
 *   npm run db:seed
 *
 * Idempotent: `seedIfEmpty()` is a no-op once rows exist, so this is safe to run
 * on every boot. Use `npm run db:reset` to wipe and rebuild from scratch.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dbPath = process.env.RMS_DB_PATH ?? join(root, "data", "rms.db");
mkdirSync(dirname(dbPath), { recursive: true });
process.env.RMS_DB_PATH = dbPath;

const { migrate } = await import("@/db/client");
const { seedIfEmpty } = await import("@/db/seed");

migrate();
const { seeded } = seedIfEmpty();
console.log(`[rms] ${dbPath}: ${seeded ? "demo data seeded" : "already seeded, nothing to do"}`);
