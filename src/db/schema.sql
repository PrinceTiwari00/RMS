-- RMS — Restaurant Management System schema
-- SQLite (node:sqlite). Primary keys are client-generated UUID v4 TEXT.
-- All money columns are INTEGER minor units (paisa; 1 NPR = 100 paisa) so that
-- pricing, VAT and reporting never suffer binary floating point drift.
-- Stock quantities are REAL because recipes use fractional units (oz, kg, litres).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================ BUSINESS CONFIG
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS terminals (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  area      TEXT NOT NULL DEFAULT 'main',
  kind      TEXT NOT NULL DEFAULT 'pos',      -- pos | kds | cfd | host
  is_active INTEGER NOT NULL DEFAULT 1
);

-- ================================================================== RBAC / HR
CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,            -- manager | server | cashier | cook | expo | bartender | host
  title       TEXT NOT NULL,
  hourly_rate INTEGER NOT NULL DEFAULT 0,      -- paisa
  is_system   INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS employees (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role_id    TEXT REFERENCES roles(id),
  pin        TEXT NOT NULL,
  initials   TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '#137c70',
  phone      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  hire_date  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_employees_pin ON employees(pin);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  actor_name  TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- ====================================================================== MENU
CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT '🍽',
  color      TEXT NOT NULL DEFAULT '#137c70',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS menu_items (
  id           TEXT PRIMARY KEY,
  category_id  TEXT REFERENCES categories(id),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price        INTEGER NOT NULL DEFAULT 0,     -- paisa, VAT-exclusive list price
  cost         INTEGER NOT NULL DEFAULT 0,     -- paisa, target portion cost
  course       TEXT NOT NULL DEFAULT 'entree', -- appetizer | entree | drink | dessert
  station      TEXT NOT NULL DEFAULT 'grill',
  allergens               TEXT NOT NULL DEFAULT '',
  prep_minutes            INTEGER NOT NULL DEFAULT 8,
  spice_level             INTEGER NOT NULL DEFAULT 0,   -- 0=none, 1=mild, 2=medium, 3=hot
  upsell_item_id          TEXT,
  upsell_discount_percent INTEGER NOT NULL DEFAULT 20,
  emoji                   TEXT NOT NULL DEFAULT '🍽',
  is_available            INTEGER NOT NULL DEFAULT 1,   -- 0 == "86ed"
  is_featured             INTEGER NOT NULL DEFAULT 0,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_menu_category ON menu_items(category_id, sort_order);

CREATE TABLE IF NOT EXISTS modifier_groups (
  id           TEXT PRIMARY KEY,
  menu_item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  min_select   INTEGER NOT NULL DEFAULT 0,
  max_select   INTEGER NOT NULL DEFAULT 0,     -- 0 == unlimited
  is_required  INTEGER NOT NULL DEFAULT 0,     -- forced modifier group
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS modifiers (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  menu_item_id     TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  price            INTEGER NOT NULL DEFAULT 0, -- paisa adjustment (+/-)
  is_default       INTEGER NOT NULL DEFAULT 0,
  is_available     INTEGER NOT NULL DEFAULT 1,
  sort_order       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_modifiers_group ON modifiers(group_id, sort_order);

CREATE TABLE IF NOT EXISTS prep_sheets (
  id           TEXT PRIMARY KEY,
  menu_item_id TEXT NOT NULL UNIQUE REFERENCES menu_items(id) ON DELETE CASCADE,
  station      TEXT NOT NULL DEFAULT 'grill',
  allergens    TEXT NOT NULL DEFAULT '',
  plating      TEXT NOT NULL DEFAULT '',
  steps        TEXT NOT NULL DEFAULT '[]',     -- JSON array of {text, seconds?}
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ================================================================ FLOOR PLAN
CREATE TABLE IF NOT EXISTS sections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#137c70',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tables (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  section_id TEXT REFERENCES sections(id),
  capacity   INTEGER NOT NULL DEFAULT 4,
  shape      TEXT NOT NULL DEFAULT 'round',    -- round | square | rect | booth | bar
  x          REAL NOT NULL DEFAULT 0,          -- percentage of canvas width  (0..100)
  y          REAL NOT NULL DEFAULT 0,          -- percentage of canvas height (0..100)
  w          REAL NOT NULL DEFAULT 12,
  h          REAL NOT NULL DEFAULT 12,
  rotation   REAL NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'available',-- available|seated|ordered|billed|dirty
  guests     INTEGER NOT NULL DEFAULT 0,
  server_id  TEXT REFERENCES employees(id),
  seated_at  TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tables_section ON tables(section_id);

-- ==================================================================== ORDERS
CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  check_number   INTEGER,
  table_id       TEXT REFERENCES tables(id),
  terminal_id    TEXT REFERENCES terminals(id),
  server_id      TEXT REFERENCES employees(id),
  status         TEXT NOT NULL DEFAULT 'open', -- open|sent|closed|voided
  channel        TEXT NOT NULL DEFAULT 'dine_in', -- dine_in|takeout|delivery|qr
  guests         INTEGER NOT NULL DEFAULT 1,
  subtotal       INTEGER NOT NULL DEFAULT 0,   -- snapshot at close (paisa)
  discount       INTEGER NOT NULL DEFAULT 0,
  vat            INTEGER NOT NULL DEFAULT 0,
  service_charge INTEGER NOT NULL DEFAULT 0,
  tip            INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  qr_token       TEXT,
  session_id     TEXT,
  guest_id       TEXT,
  approval_status TEXT NOT NULL DEFAULT 'approved', -- pending_staff|approved
  approved_at    TEXT,
  approved_by    TEXT,
  guest_name     TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '',
  business_date  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at        TEXT,
  fired_at       TEXT,
  closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_id);
CREATE INDEX IF NOT EXISTS idx_orders_bdate ON orders(business_date);

CREATE TABLE IF NOT EXISTS order_items (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id   TEXT REFERENCES menu_items(id),
  name_snapshot  TEXT NOT NULL,
  quantity       INTEGER NOT NULL DEFAULT 1,
  price_at_time  INTEGER NOT NULL,             -- CRITICAL: price locked at time of sale
  course         TEXT NOT NULL DEFAULT 'entree',
  station        TEXT NOT NULL DEFAULT 'grill',
  seat           INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  kds_status     TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|HOLD|READY
  is_void        INTEGER NOT NULL DEFAULT 0,
  void_reason    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at        TEXT,
  ready_at       TEXT,
  bumped_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_station ON order_items(station, kds_status);

CREATE TABLE IF NOT EXISTS order_item_modifiers (
  id            TEXT PRIMARY KEY,
  order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id   TEXT REFERENCES modifiers(id),
  group_name    TEXT NOT NULL DEFAULT '',
  name_snapshot TEXT NOT NULL,
  price_at_time INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_oim_item ON order_item_modifiers(order_item_id);

CREATE TABLE IF NOT EXISTS order_discounts (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id TEXT REFERENCES order_items(id),
  kind          TEXT NOT NULL DEFAULT 'amount', -- amount | percent
  value         INTEGER NOT NULL DEFAULT 0,     -- paisa, or basis points for percent
  amount        INTEGER NOT NULL DEFAULT 0,     -- resolved paisa
  reason        TEXT NOT NULL DEFAULT '',
  approved_by   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS voids (
  id            TEXT PRIMARY KEY,
  order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
  order_item_id TEXT,
  item_name     TEXT NOT NULL DEFAULT '',
  amount        INTEGER NOT NULL DEFAULT 0,
  reason        TEXT NOT NULL DEFAULT '',
  voided_by     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  business_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_voids_bdate ON voids(business_date);

-- ================================================================== PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
  method        TEXT NOT NULL DEFAULT 'cash',   -- cash|card|gift_card|wallet|esewa|khalti|comp
  amount        INTEGER NOT NULL DEFAULT 0,     -- tendered paisa
  tip           INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'captured', -- authorized|captured|stored|refunded
  label         TEXT NOT NULL DEFAULT '',       -- e.g. "Guest 1 of 3"
  auth_code     TEXT,
  last4         TEXT,
  card_token    TEXT,                           -- tokenised only, never a raw PAN
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  business_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_bdate ON payments(business_date);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- =========================================================== HOST / WAITLIST
CREATE TABLE IF NOT EXISTS waitlist_parties (
  id             TEXT PRIMARY KEY,
  guest_name     TEXT NOT NULL,
  phone          TEXT NOT NULL DEFAULT '',
  party_size     INTEGER NOT NULL DEFAULT 2,
  status         TEXT NOT NULL DEFAULT 'waiting', -- waiting|notified|seated|no_show|cancelled
  quoted_minutes INTEGER NOT NULL DEFAULT 20,
  notes          TEXT NOT NULL DEFAULT '',
  table_id       TEXT REFERENCES tables(id),
  business_date  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at    TEXT,
  seated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_waitlist_bdate ON waitlist_parties(business_date, created_at);

CREATE TABLE IF NOT EXISTS reservations (
  id             TEXT PRIMARY KEY,
  guest_name     TEXT NOT NULL,
  phone          TEXT NOT NULL DEFAULT '',
  party_size     INTEGER NOT NULL DEFAULT 2,
  reservation_at TEXT NOT NULL,               -- ISO local datetime
  status         TEXT NOT NULL DEFAULT 'confirmed', -- confirmed|seated|cancelled|no_show
  table_id       TEXT REFERENCES tables(id),
  source         TEXT NOT NULL DEFAULT 'phone',
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reservations_at ON reservations(reservation_at);

CREATE TABLE IF NOT EXISTS guest_alerts (
  id         TEXT PRIMARY KEY,
  party_id   TEXT NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'sms',
  message    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'queued',  -- queued|sent|failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ================================================================= INVENTORY
CREATE TABLE IF NOT EXISTS vendors (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  contact_name   TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  payment_terms  TEXT NOT NULL DEFAULT 'net_15',
  min_order      INTEGER NOT NULL DEFAULT 0,  -- paisa
  lead_time_days INTEGER NOT NULL DEFAULT 2,
  edi_enabled    INTEGER NOT NULL DEFAULT 0,
  cutoff_time    TEXT NOT NULL DEFAULT '17:00',
  preferred      INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id                  TEXT PRIMARY KEY,
  sku                 TEXT NOT NULL DEFAULT '',
  name                TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'produce',
  unit                TEXT NOT NULL DEFAULT 'kg',
  current_stock       REAL NOT NULL DEFAULT 0,
  unit_cost           INTEGER NOT NULL DEFAULT 0,   -- paisa per base unit
  storage_location    TEXT NOT NULL DEFAULT 'walk-in',
  avg_daily_usage     REAL NOT NULL DEFAULT 0,
  max_daily_usage     REAL NOT NULL DEFAULT 0,
  lead_time_days      REAL NOT NULL DEFAULT 2,
  max_lead_time_days  REAL NOT NULL DEFAULT 3,
  par_level           REAL NOT NULL DEFAULT 0,
  pack_size           REAL NOT NULL DEFAULT 1,      -- base units per purchase pack
  low_stock_threshold REAL NOT NULL DEFAULT 0,
  vendor_id           TEXT REFERENCES vendors(id),
  is_active           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_inventory_vendor ON inventory_items(vendor_id);

CREATE TABLE IF NOT EXISTS recipes (
  menu_item_id     TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity_required REAL NOT NULL DEFAULT 0,
  is_modifier       INTEGER NOT NULL DEFAULT 0,
  -- '' for the base recipe; a modifiers.id when this component is only consumed
  -- if that modifier is chosen. Deliberately not a FK: the empty sentinel would
  -- violate it, and orphaned modifier rows are harmless in a BOM.
  modifier_id       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (menu_item_id, inventory_item_id, modifier_id)
);
CREATE INDEX IF NOT EXISTS idx_recipes_modifier ON recipes(modifier_id);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id                TEXT PRIMARY KEY,
  inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  delta             REAL NOT NULL,
  reason            TEXT NOT NULL,            -- sale|waste|restock|adjustment|count
  reference_id      TEXT,
  actor             TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  business_date     TEXT
);
CREATE INDEX IF NOT EXISTS idx_inv_tx_item ON inventory_transactions(inventory_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS waste_log (
  id                TEXT PRIMARY KEY,
  inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity          REAL NOT NULL,
  reason            TEXT NOT NULL DEFAULT 'spoiled', -- spoiled|dropped|expired|overcook|theft|other
  notes             TEXT NOT NULL DEFAULT '',
  logged_by         TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  business_date     TEXT
);
CREATE INDEX IF NOT EXISTS idx_waste_bdate ON waste_log(business_date);

CREATE TABLE IF NOT EXISTS inventory_counts (
  id                TEXT PRIMARY KEY,
  inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  expected          REAL NOT NULL DEFAULT 0,
  counted           REAL NOT NULL DEFAULT 0,
  variance          REAL NOT NULL DEFAULT 0,
  counted_by        TEXT NOT NULL DEFAULT '',
  applied           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  business_date     TEXT
);

-- =========================================================== PURCHASE ORDERS
CREATE TABLE IF NOT EXISTS purchase_orders (
  id            TEXT PRIMARY KEY,
  po_number     TEXT NOT NULL,
  vendor_id     TEXT NOT NULL REFERENCES vendors(id),
  status        TEXT NOT NULL DEFAULT 'draft', -- draft|approved|sent|received|cancelled
  expected_date TEXT,
  notes         TEXT NOT NULL DEFAULT '',
  total         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at   TEXT,
  sent_at       TEXT,
  received_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS po_items (
  id                TEXT PRIMARY KEY,
  po_id             TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id),
  quantity_packs    REAL NOT NULL DEFAULT 1,
  unit_price        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS po_transmissions (
  id          TEXT PRIMARY KEY,
  po_id       TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL DEFAULT 'pdf_email', -- pdf_email | edi_sftp
  destination TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued',    -- queued|sent|failed|dead
  attempts    INTEGER NOT NULL DEFAULT 0,
  reference   TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ==================================================================== LABOR
CREATE TABLE IF NOT EXISTS shifts (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  starts_at     TEXT NOT NULL,                  -- ISO local datetime
  ends_at       TEXT NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 30,
  note          TEXT NOT NULL DEFAULT '',
  station       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|published|cancelled|completed
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shifts_start ON shifts(starts_at);

CREATE TABLE IF NOT EXISTS availability (
  id          TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  weekday     INTEGER NOT NULL,                 -- 0 = Sunday
  starts      TEXT NOT NULL DEFAULT '09:00',
  ends        TEXT NOT NULL DEFAULT '22:00',
  unavailable INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shift_swaps (
  id           TEXT PRIMARY KEY,
  shift_id     TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  requested_to TEXT NOT NULL DEFAULT '',
  reason       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|approved|denied
  decided_by   TEXT,
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_entries (
  id             TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  clock_in       TEXT NOT NULL,
  clock_out      TEXT,
  break_minutes  INTEGER NOT NULL DEFAULT 0,
  regular_hours  REAL NOT NULL DEFAULT 0,
  overtime_hours REAL NOT NULL DEFAULT 0,
  hourly_rate    INTEGER NOT NULL DEFAULT 0,    -- copied at clock-in (immutable history)
  business_date  TEXT,
  edited         INTEGER NOT NULL DEFAULT 0,
  edit_reason    TEXT,
  edited_by      TEXT,
  ot_approved    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_time_entries_bdate ON time_entries(business_date);

-- ============================================== BUSINESS DAY / Z-REPORT / QR
CREATE TABLE IF NOT EXISTS business_days (
  id             TEXT PRIMARY KEY,
  business_date  TEXT NOT NULL UNIQUE,
  opened_at      TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at      TEXT,
  opening_float  INTEGER NOT NULL DEFAULT 0,
  expected_cash  INTEGER NOT NULL DEFAULT 0,
  counted_cash   INTEGER,
  variance       INTEGER,
  status         TEXT NOT NULL DEFAULT 'open',  -- open|closed
  notes          TEXT NOT NULL DEFAULT '',
  closed_by      TEXT
);

CREATE TABLE IF NOT EXISTS cash_counts (
  id              TEXT PRIMARY KEY,
  business_day_id TEXT NOT NULL REFERENCES business_days(id) ON DELETE CASCADE,
  denomination    TEXT NOT NULL,
  expected_count  INTEGER NOT NULL DEFAULT 0,
  counted_count   INTEGER NOT NULL DEFAULT 0,
  counted_by      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS z_reports (
  id              TEXT PRIMARY KEY,
  business_day_id TEXT NOT NULL REFERENCES business_days(id) ON DELETE CASCADE,
  business_date   TEXT NOT NULL,
  generated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  payload         TEXT NOT NULL DEFAULT '{}'    -- frozen JSON snapshot
);

CREATE TABLE IF NOT EXISTS qr_tokens (
  token      TEXT PRIMARY KEY,
  table_id   TEXT REFERENCES tables(id) ON DELETE CASCADE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  scans      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ======================================= TABLE SESSIONS, ENGAGEMENT & REVIEWS
CREATE TABLE IF NOT EXISTS table_sessions (
  id         TEXT PRIMARY KEY,
  table_id   TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  qr_token   TEXT,
  status     TEXT NOT NULL DEFAULT 'active',  -- active|closed
  opened_at  TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_table_sessions_table ON table_sessions(table_id, status);

CREATE TABLE IF NOT EXISTS table_guests (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  initials           TEXT NOT NULL DEFAULT 'G',
  color              TEXT NOT NULL DEFAULT '#e85a2a',
  loyalty_account_id TEXT,
  joined_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_table_guests_session ON table_guests(session_id);

CREATE TABLE IF NOT EXISTS service_requests (
  id                 TEXT PRIMARY KEY,
  table_id           TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  session_id         TEXT REFERENCES table_sessions(id) ON DELETE SET NULL,
  guest_id           TEXT,
  guest_name         TEXT NOT NULL DEFAULT '',
  request_type       TEXT NOT NULL DEFAULT 'call_waiter', -- call_waiter|water|napkins|bill|cutlery|other
  note               TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'open',        -- open|acknowledged|resolved
  assigned_waiter_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at    TEXT,
  resolved_at        TEXT,
  resolved_by        TEXT
);
CREATE INDEX IF NOT EXISTS idx_service_requests_status ON service_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_requests_table ON service_requests(table_id, status);

CREATE TABLE IF NOT EXISTS guest_reviews (
  id         TEXT PRIMARY KEY,
  order_id   TEXT REFERENCES orders(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES table_sessions(id) ON DELETE SET NULL,
  table_id   TEXT REFERENCES tables(id) ON DELETE SET NULL,
  guest_name TEXT NOT NULL DEFAULT '',
  rating     INTEGER NOT NULL,
  tags       TEXT NOT NULL DEFAULT '',
  comment    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_guest_reviews_order ON guest_reviews(order_id);

CREATE TABLE IF NOT EXISTS loyalty_accounts (
  id              TEXT PRIMARY KEY,
  phone           TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL DEFAULT '',
  points          INTEGER NOT NULL DEFAULT 0,
  lifetime_points INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loyalty_phone ON loyalty_accounts(phone);
CREATE INDEX IF NOT EXISTS idx_loyalty_email ON loyalty_accounts(email);

CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
  order_id     TEXT REFERENCES orders(id) ON DELETE SET NULL,
  points_delta INTEGER NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_receipts (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  subject         TEXT NOT NULL,
  html_body       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'sent', -- sent|queued|demo
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quiz_matches (
  id                  TEXT PRIMARY KEY,
  mode                TEXT NOT NULL DEFAULT 'in_table', -- in_table|table_vs_table
  session_id          TEXT REFERENCES table_sessions(id) ON DELETE SET NULL,
  challenger_table_id TEXT REFERENCES tables(id) ON DELETE SET NULL,
  opponent_table_id   TEXT REFERENCES tables(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'active',   -- waiting|active|finished
  current_round       INTEGER NOT NULL DEFAULT 1,
  total_rounds        INTEGER NOT NULL DEFAULT 5,
  question_ids        TEXT NOT NULL DEFAULT '[]',
  round_started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quiz_participants (
  id           TEXT PRIMARY KEY,
  match_id     TEXT NOT NULL REFERENCES quiz_matches(id) ON DELETE CASCADE,
  guest_id     TEXT,
  table_id     TEXT REFERENCES tables(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  avatar_color TEXT NOT NULL DEFAULT '#e85a2a',
  score        INTEGER NOT NULL DEFAULT 0,
  joined_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quiz_participants_match ON quiz_participants(match_id);

CREATE TABLE IF NOT EXISTS quiz_answers (
  id             TEXT PRIMARY KEY,
  match_id       TEXT NOT NULL REFERENCES quiz_matches(id) ON DELETE CASCADE,
  round_number   INTEGER NOT NULL,
  participant_id TEXT NOT NULL REFERENCES quiz_participants(id) ON DELETE CASCADE,
  selected_index INTEGER NOT NULL,
  is_correct     INTEGER NOT NULL DEFAULT 0,
  points_earned  INTEGER NOT NULL DEFAULT 0,
  answered_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id, round_number, participant_id)
);
