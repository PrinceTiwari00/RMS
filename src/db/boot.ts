/**
 * Database bootstrap.
 *
 * Kept separate from `db/client` on purpose: `seed.ts` imports the client, so
 * putting the seeding call inside the client would create an import cycle. Both
 * the API entrypoint and server components call `ensureDatabase()` before
 * touching a table, which makes a fresh clone (or a wiped `data/` directory)
 * come up with the full demo dataset instead of an empty shell.
 *
 * Everything here is idempotent. Demo seeding runs only outside production;
 * production performs schema migration and then uses the token-protected
 * first-run setup. A module-level flag keeps this to one pass per process.
 */
import { db, migrate } from "@/db/client";
import { seedIfEmpty } from "@/db/seed";
import { isProduction, validateProductionEnvironment } from "@/lib/session";

let ready = false;

export function ensureDatabase(): void {
  if (ready) return;
  validateProductionEnvironment();
  db();
  migrate();
  // Demo identities are opt-in development data, never a production recovery
  // mechanism. A fresh production database is initialized through /setup.
  if (!isProduction()) seedIfEmpty();
  ready = true;
}

/** True once this process has opened and seeded the database. */
export function isDatabaseReady(): boolean {
  return ready;
}
