/**
 * SQLite access layer built on Node's native `node:sqlite` module.
 *
 * No ORM and no native compilation step: the driver ships with Node >= 22.5.
 * Every query goes through `all` / `get` / `run` so parameter normalisation
 * (booleans -> 0/1, Date -> ISO text, undefined -> NULL) happens in one place,
 * and `tx()` gives composable transactions via SAVEPOINTs.
 *
 * Multi-restaurant support: `withTenant()` puts a restaurant in an
 * AsyncLocalStorage scope, and `db()` then hands back that restaurant's own
 * SQLite file. Services keep writing plain SQL and stay tenant-agnostic, while
 * two restaurants can never see each other's rows because they are literally
 * different databases.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
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

/** Directory that holds the control plane and every restaurant's database. */
export function dataDir(): string {
  return process.env.RMS_DATA_DIR ?? path.join(process.cwd(), "data");
}

/** The legacy/single-store database path (also the tests' `:memory:` target). */
export function defaultDatabasePath(): string {
  const configured = process.env.RMS_DB_PATH;
  if (configured) return configured;
  return path.join(dataDir(), "rms.db");
}

/** The control-plane database: platform admins and the restaurant registry. */
export function controlDatabasePath(): string {
  return process.env.RMS_CONTROL_DB_PATH ?? path.join(dataDir(), "control.db");
}

export interface TenantScope {
  tenantId: string;
  /** Absolute path to this restaurant's SQLite file. */
  dbPath: string;
}

const tenantStorage = new AsyncLocalStorage<TenantScope>();

/**
 * Run `fn` with every `all`/`get`/`run`/`tx` call pointed at one restaurant's
 * database. Nested calls are allowed and simply keep the active scope.
 */
export function withTenant<T>(scope: TenantScope, fn: () => T): T {
  return tenantStorage.run(scope, fn);
}

/** The restaurant scope of the current async context, if any. */
export function currentTenantScope(): TenantScope | null {
  return tenantStorage.getStore() ?? null;
}

/** The database file that the current context reads and writes. */
export function activeDatabasePath(): string {
  return tenantStorage.getStore()?.dbPath ?? defaultDatabasePath();
}

function openDatabase(target: string): DatabaseSync {
  if (target !== ":memory:") {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const db = new DatabaseSync(target);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

const globalForDb = globalThis as unknown as { __rmsDbs?: Map<string, DatabaseSync> };

function connections(): Map<string, DatabaseSync> {
  if (!globalForDb.__rmsDbs) globalForDb.__rmsDbs = new Map();
  return globalForDb.__rmsDbs;
}

function connectionFor(target: string): DatabaseSync {
  const cache = connections();
  const existing = cache.get(target);
  if (existing) return existing;
  const opened = openDatabase(target);
  cache.set(target, opened);
  return opened;
}

/** The database for the active context. */
export function db(): DatabaseSync {
  return connectionFor(activeDatabasePath());
}

/** Open a specific database file (used by the control plane). */
export function dbAt(target: string): DatabaseSync {
  return connectionFor(target);
}

export function controlDb(): DatabaseSync {
  return connectionFor(controlDatabasePath());
}

/** Test helper: drop every cached connection (used with RMS_DB_PATH=":memory:"). */
export function resetConnection(): void {
  const cache = connections();
  for (const connection of cache.values()) {
    try {
      connection.close();
    } catch {
      /* already closed */
    }
  }
  cache.clear();
}

/** Close one restaurant's handle, e.g. after a failed provisioning attempt. */
export function closeConnection(target: string): void {
  const cache = connections();
  const connection = cache.get(target);
  if (!connection) return;
  try {
    connection.close();
  } catch {
    /* already closed */
  }
  cache.delete(target);
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

// ------------------------------------------------------------- control plane I/O
// The control plane owns the restaurant registry, so it must never depend on the
// active tenant scope. These helpers always talk to `control.db`.

export function controlAll<T = Row>(sql: string, ...params: unknown[]): T[] {
  return controlDb().prepare(sql).all(...normalizeAll(params)) as unknown as T[];
}

export function controlGet<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return controlDb().prepare(sql).get(...normalizeAll(params)) as unknown as T | undefined;
}

export function controlRun(sql: string, ...params: unknown[]): { changes: number } {
  const result = controlDb().prepare(sql).run(...normalizeAll(params));
  return { changes: Number(result.changes) };
}

let controlSavepointDepth = 0;

export function controlTx<T>(fn: () => T): T {
  const connection = controlDb();
  if (controlSavepointDepth > 0) return fn();
  controlSavepointDepth = 1;
  connection.exec("BEGIN IMMEDIATE");
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
    controlSavepointDepth = 0;
  }
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

const schemaCache: { sql?: string; controlSql?: string } = {};

/** Next's standalone bundle can retain build-machine module URLs, so prefer the
 * colocated SQL file and fall back to the runtime workspace copy. */
function readSchema(fileName: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const colocated = path.join(here, fileName);
  const workspace = path.join(process.cwd(), "src", "db", fileName);
  const schemaPath = fs.existsSync(colocated) ? colocated : workspace;
  return fs.readFileSync(schemaPath, "utf8");
}

/** Idempotent schema creation for the active restaurant, safe on every cold start. */
export function migrate(): void {
  if (!schemaCache.sql) schemaCache.sql = readSchema("schema.sql");
  db().exec(schemaCache.sql);
}

/** Idempotent schema creation for the platform/control database. */
export function migrateControl(): void {
  if (!schemaCache.controlSql) schemaCache.controlSql = readSchema("control-schema.sql");
  controlDb().exec(schemaCache.controlSql);
}
