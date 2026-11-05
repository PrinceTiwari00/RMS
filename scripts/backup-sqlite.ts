/**
 * Create transactionally consistent online SQLite backups and prune old copies.
 *
 * The instance now holds more than one database: the control plane
 * (`control.db`) plus one file per restaurant under `tenants/<code>/rms.db`.
 * A backup is a timestamped directory containing a verified snapshot of every
 * one of them, so a restore can never mix a registry row with a different
 * restaurant's data.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = path.resolve(process.env.RMS_DATA_DIR ?? path.join(process.cwd(), "data"));
const backupRoot = path.resolve(process.env.RMS_BACKUP_DIR ?? path.join(dataDir, "..", "backups"));
const retentionDays = Number(process.env.RMS_BACKUP_RETENTION_DAYS ?? "30");

if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
  throw new Error("RMS_BACKUP_RETENTION_DAYS must be an integer from 1 to 3650");
}

interface Source {
  /** Path inside the backup directory. */
  relative: string;
  absolute: string;
}

function collectSources(): Source[] {
  const sources: Source[] = [];
  const control = path.resolve(process.env.RMS_CONTROL_DB_PATH ?? path.join(dataDir, "control.db"));
  if (fs.existsSync(control)) sources.push({ relative: "control.db", absolute: control });

  // Legacy single-store database, if this deployment still has one.
  const legacy = path.resolve(process.env.RMS_DB_PATH ?? path.join(dataDir, "rms.db"));
  if (legacy !== control && fs.existsSync(legacy)) sources.push({ relative: "rms.db", absolute: legacy });

  const tenantsRoot = path.join(dataDir, "tenants");
  if (fs.existsSync(tenantsRoot)) {
    for (const entry of fs.readdirSync(tenantsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(tenantsRoot, entry.name, "rms.db");
      if (!fs.existsSync(file)) continue;
      sources.push({ relative: path.join("tenants", entry.name, "rms.db"), absolute: file });
    }
  }
  return sources;
}

function snapshot(source: string, destination: string): void {
  if (!fs.existsSync(source) || fs.statSync(source).size === 0) {
    throw new Error(`Cannot back up a missing or empty database: ${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}`;
  const handle = new DatabaseSync(source);
  handle.exec("PRAGMA busy_timeout = 5000");
  try {
    // VACUUM INTO writes a complete transactionally consistent snapshot from a
    // live WAL database. A plain copy of the main file can miss committed frames.
    handle.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
    const verification = new DatabaseSync(temporary, { readOnly: true });
    try {
      const result = verification.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      if (result.integrity_check !== "ok") throw new Error(`Backup integrity check failed: ${result.integrity_check}`);
    } finally {
      verification.close();
    }
    fs.chmodSync(temporary, 0o600);
    const descriptor = fs.openSync(temporary, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  } finally {
    handle.close();
  }
}

const sources = collectSources();
if (!sources.length) {
  throw new Error(`No databases found under ${dataDir}. Start RMS once before running a backup.`);
}

fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const finalDir = path.join(backupRoot, `rms-${stamp}`);
const workingDir = `${finalDir}.tmp-${process.pid}`;
fs.mkdirSync(workingDir, { recursive: true, mode: 0o700 });

try {
  for (const source of sources) {
    snapshot(source.absolute, path.join(workingDir, source.relative));
  }
  fs.writeFileSync(
    path.join(workingDir, "manifest.json"),
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        dataDir,
        databases: sources.map((source) => source.relative),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(workingDir, finalDir);
} catch (error) {
  fs.rmSync(workingDir, { recursive: true, force: true });
  throw error;
}

const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
for (const name of fs.readdirSync(backupRoot)) {
  if (!/^rms-\d{4}-\d{2}-\d{2}T.*/.test(name)) continue;
  const candidate = path.join(backupRoot, name);
  if (candidate !== finalDir && fs.statSync(candidate).mtimeMs < cutoff) {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

// stdout is consumed by scripts/backup.sh for the optional off-site copy.
console.log(finalDir);
