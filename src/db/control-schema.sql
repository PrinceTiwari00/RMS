-- RMS control plane — platform (super admin) accounts and the restaurant registry.
--
-- This database sits ABOVE the per-restaurant SQLite files. It deliberately
-- stores no menu, order, employee or money data: each restaurant owns its own
-- `data/tenants/<code>/rms.db`, which keeps tenant boundaries physical instead
-- of relying on a `tenant_id` filter in every one of the ~40 tables.
--
-- A restaurant row is the provisioning record and the kill switch (status). The
-- restaurant's own manager role is its administrator; the platform admin can
-- reset that manager's PIN but cannot read the restaurant's operational data
-- through the control plane.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS platform_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_signin_at TEXT
);

CREATE TABLE IF NOT EXISTS tenants (
  id                 TEXT PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE COLLATE NOCASE, -- URL-safe restaurant key, e.g. "terai-kitchen"
  name               TEXT NOT NULL,
  tagline            TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'active',      -- active | suspended
  plan               TEXT NOT NULL DEFAULT 'standard',    -- free | standard | pro
  contact_name       TEXT NOT NULL DEFAULT '',
  contact_email      TEXT NOT NULL DEFAULT '',
  contact_phone      TEXT NOT NULL DEFAULT '',
  notes              TEXT NOT NULL DEFAULT '',
  -- Relative to RMS_DATA_DIR so a mounted volume can move without breaking the
  -- registry. Absolute paths are rejected by provisioning.
  db_file            TEXT NOT NULL,
  admin_employee_id  TEXT NOT NULL DEFAULT '',
  admin_name         TEXT NOT NULL DEFAULT '',
  pin_length         INTEGER NOT NULL DEFAULT 4,
  created_by         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  suspended_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_audit (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  actor_email TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  tenant_id   TEXT,
  tenant_code TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit(created_at DESC);

-- A restaurant admin reset must be traceable even if the restaurant database is
-- later restored from backup.
CREATE TABLE IF NOT EXISTS tenant_admin_resets (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  actor_id    TEXT,
  reason      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
