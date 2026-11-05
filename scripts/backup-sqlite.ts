/** Create a transactionally consistent online SQLite backup and prune old copies. */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = path.resolve(process.env.RMS_DATA_DIR ?? path.join(process.cwd(), "data"));
const databasePath = path.resolve(process.env.RMS_DB_PATH ?? path.join(dataDir, "rms.db"));
const backupDir = path.resolve(process.env.RMS_BACKUP_DIR ?? path.join(dataDir, "..", "backups"));
const retentionDays = Number(process.env.RMS_BACKUP_RETENTION_DAYS ?? "30");

if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
  throw new Error("RMS_BACKUP_RETENTION_DAYS must be an integer from 1 to 3650");
}
if (!fs.existsSync(databasePath) || fs.statSync(databasePath).size === 0) {
  throw new Error(`Cannot back up a missing or empty database: ${databasePath}`);
}

fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const finalPath = path.join(backupDir, `rms-${stamp}.db`);
const temporaryPath = `${finalPath}.tmp-${process.pid}`;
const source = new DatabaseSync(databasePath);
source.exec("PRAGMA busy_timeout = 5000");

try {
  // VACUUM INTO writes a complete transactionally consistent snapshot from a
  // live WAL database. A plain copy of the main file can miss committed frames.
  const quotedTemporaryPath = temporaryPath.replaceAll("'", "''");
  source.exec(`VACUUM INTO '${quotedTemporaryPath}'`);
  const verification = new DatabaseSync(temporaryPath, { readOnly: true });
  try {
    const result = verification.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (result.integrity_check !== "ok") throw new Error(`Backup integrity check failed: ${result.integrity_check}`);
  } finally {
    verification.close();
  }
  fs.chmodSync(temporaryPath, 0o600);
  const descriptor = fs.openSync(temporaryPath, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporaryPath, finalPath);

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(backupDir)) {
    if (!/^rms-\d{4}-\d{2}-\d{2}T.*\.db$/.test(name)) continue;
    const candidate = path.join(backupDir, name);
    if (candidate !== finalPath && fs.statSync(candidate).mtimeMs < cutoff) fs.unlinkSync(candidate);
  }

  // stdout is consumed by scripts/backup.sh for the optional off-site copy.
  console.log(finalPath);
} finally {
  source.close();
  if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
}
