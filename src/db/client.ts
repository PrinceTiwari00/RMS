/**
 * SQLite access layer built on Node's native `node:sqlite` module.
 *
 * No ORM and no native compilation step: the driver ships with Node >= 22.5.
 * Every query goes through `all` / `get` / `run` so parameter normalisation
 * (booleans -> 0/1, Date -> ISO text, undefined -> NULL) happens in one place,
 * and `tx()` gives composable transactions via SAVEPOINTs.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SqlValue = string | number | bigint | null | Uint8Array;

/** Rows come back as null-prototype objects; widen them for ergonomics. */
export type Row = Record<string, unknown>;

export function uuid(): string {
  return randomUUID();
}

function normalize(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 19);
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function normalizeAll(params: unknown[]): SqlValue[] {
  return params.map(normalize);
}

function databasePath(): string {
  const configured = process.env.RMS_DB_PATH;
  if (configured) return configured;
  return path.join(process.env.RMS_DATA_DIR ?? path.join(process.cwd(), "data"), "rms.db");
}

function openDatabase(): DatabaseSync {
  const target = databasePath();
  if (target !== ":memory:") {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const db = new DatabaseSync(target);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

const globalForDb = globalThis as unknown as { __rmsDb?: DatabaseSync };

export function db(): DatabaseSync {
  if (!globalForDb.__rmsDb) globalForDb.__rmsDb = openDatabase();
  return globalForDb.__rmsDb;
}

/** Test helper: drop the cached connection (used with RMS_DB_PATH=":memory:"). */
export function resetConnection(): void {
  globalForDb.__rmsDb = undefined;
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  const rows = db().prepare(sql).all(...normalizeAll(params));
  return rows as unknown as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  const row = db().prepare(sql).get(...normalizeAll(params));
  return row as unknown as T | undefined;
}

export function run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
  const result = db().prepare(sql).run(...normalizeAll(params));
  // node:sqlite types `changes` as number|bigint; normalise so callers can compare.
  return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
}

export function exec(sql: string): void {
  db().exec(sql);
}

export function scalar<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
  const row = db().prepare(sql).get(...normalizeAll(params)) as unknown as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const first = Object.values(row)[0];
  return first as T | undefined;
}

let savepointDepth = 0;

/**
 * Run `fn` inside a transaction. Nested calls use SAVEPOINTs so domain
 * helpers can stay atomic while composing into a larger operation.
 */
export function tx<T>(fn: () => T): T {
  const connection = db();
  const outermost = savepointDepth === 0;
  if (outermost) {
    connection.exec("BEGIN IMMEDIATE");
    savepointDepth = 1;
    try {
      const result = fn();
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        connection.exec("ROLLBACK");
      } catch {
        /* the transaction was already aborted */
      }
      throw error;
    } finally {
      savepointDepth = 0;
    }
  }

  const name = `sp_${savepointDepth}_${Math.random().toString(36).slice(2, 8)}`;
  savepointDepth += 1;
  connection.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    connection.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    connection.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    connection.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  } finally {
    savepointDepth -= 1;
  }
}

const schemaCache: { sql?: string } = {};

/** Idempotent schema creation, safe to call on every cold start. */
export function migrate(): void {
  if (!schemaCache.sql) {
    // Next's standalone bundle can retain an absolute build-machine module URL.
    // Prefer the colocated source file, then fall back to the runtime workspace
    // copy shipped by the Dockerfile.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const colocated = path.join(here, "schema.sql");
    const workspace = path.join(process.cwd(), "src", "db", "schema.sql");
    const schemaPath = fs.existsSync(colocated) ? colocated : workspace;
    schemaCache.sql = fs.readFileSync(schemaPath, "utf8");
  }
  db().exec(schemaCache.sql);
}
