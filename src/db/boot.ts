/**
 * Database bootstrap.
 *
 * Kept separate from `db/client` on purpose: `seed.ts` imports the client, so
 * putting the seeding call inside the client would create an import cycle. Both
 * the API entrypoint and server components call `ensureDatabase()` before
 * touching a table, which makes a fresh clone (or a wiped `data/` directory)
 * come up with the full demo dataset instead of an empty shell.
 *
 * Everything here is idempotent — `migrate()` uses CREATE TABLE IF NOT EXISTS
 * and `seedIfEmpty()` is a no-op once the seed-version key exists — so it is
 * safe to call on every request. A module-level flag keeps it to one real pass
 * per server process.
 */
import { db, migrate } from "@/db/client";
import { seedIfEmpty } from "@/db/seed";

let ready = false;

export function ensureDatabase(): void {
  if (ready) return;
  db();
  migrate();
  seedIfEmpty();
  ready = true;
}

/** True once this process has opened and seeded the database. */
export function isDatabaseReady(): boolean {
  return ready;
}
