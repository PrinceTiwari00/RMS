-- RMS Foundational Database Schema
-- Offline-first Restaurant Management System (see "RMS Technical Blueprint")
-- All primary keys are client-generated UUID v4 (TEXT). Auto-increment is forbidden.

-- MENU DOMAIN
CREATE TABLE menu_items (
    id TEXT PRIMARY KEY,                      -- UUID v4
    name VARCHAR(100) NOT NULL,
    base_price NUMERIC NOT NULL,              -- DECIMAL(10,2)
    is_available BOOLEAN DEFAULT TRUE,
    course VARCHAR(20) DEFAULT 'entree',      -- 'appetizer' | 'entree' | 'drink' (KDS routing)
    default_station VARCHAR(50) DEFAULT 'grill'
);
CREATE TABLE modifiers (
    id TEXT PRIMARY KEY,
    menu_item_id TEXT REFERENCES menu_items(id),
    name VARCHAR(100) NOT NULL,
    price_adjustment NUMERIC DEFAULT 0.00
);

-- ORDER DOMAIN
CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    status VARCHAR(20) NOT NULL,              -- 'open', 'sent_to_kitchen', 'closed'
    subtotal NUMERIC,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT REFERENCES orders(id),
    menu_item_id TEXT REFERENCES menu_items(id),
    quantity INT DEFAULT 1,
    price_at_time NUMERIC NOT NULL,           -- CRITICAL: locks price at time of sale
    kds_status VARCHAR(10) DEFAULT 'PENDING'  -- 'PENDING' | 'HOLD' | 'READY'
);
CREATE TABLE order_item_modifiers (
    id TEXT PRIMARY KEY,
    order_item_id TEXT REFERENCES order_items(id),
    modifier_id TEXT REFERENCES modifiers(id),
    price_at_time NUMERIC NOT NULL           -- modifier price locked at time of sale
);

-- TABLE MANAGEMENT (floor plan state machine)
CREATE TABLE tables (
    id TEXT PRIMARY KEY,
    label VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'available'  -- available|seated|ordered|billed|dirty
);

-- OFFLINE-FIRST SYNC QUEUE
CREATE TABLE sync_queue (
    sync_id TEXT PRIMARY KEY,                 -- e.g. "sync_987654"
    entity_type VARCHAR(50) NOT NULL,         -- e.g. "order"
    entity_id TEXT NOT NULL,
    action VARCHAR(10) NOT NULL,              -- 'CREATE' | 'UPDATE' | 'DELETE'
    payload TEXT NOT NULL,                    -- JSON sync payload
    client_timestamp TEXT NOT NULL,
    synced INTEGER DEFAULT 0
);

-- INVENTORY & RECIPE (BOM) DOMAIN
CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    preferred INTEGER DEFAULT 0,
    edi_enabled INTEGER DEFAULT 0,            -- EDI 850 over SFTP vs PDF email
    cutoff_time VARCHAR(5) DEFAULT '17:00'
);
CREATE TABLE inventory_items (
    id TEXT PRIMARY KEY,
    name VARCHAR(100),                        -- e.g. "Ground Beef"
    unit_of_measure VARCHAR(20),              -- e.g. "oz"
    current_stock NUMERIC DEFAULT 0,
    avg_daily_usage NUMERIC DEFAULT 0,
    max_daily_usage NUMERIC DEFAULT 0,
    lead_time_days NUMERIC DEFAULT 0,         -- avg lead time
    max_lead_time_days NUMERIC DEFAULT 0,
    par_level NUMERIC DEFAULT 0,
    pack_size NUMERIC DEFAULT 1,              -- pack conversion factor (e.g. 800 oz per 50lb case)
    vendor_id TEXT REFERENCES vendors(id)
);
CREATE TABLE recipes (                        -- Bill of Materials junction
    menu_item_id TEXT REFERENCES menu_items(id),
    inventory_item_id TEXT REFERENCES inventory_items(id),
    quantity_required NUMERIC,                -- e.g. 6.00 oz
    PRIMARY KEY (menu_item_id, inventory_item_id)
);
CREATE TABLE inventory_transactions (         -- immutable audit ledger
    id TEXT PRIMARY KEY,
    inventory_item_id TEXT REFERENCES inventory_items(id),
    delta NUMERIC NOT NULL,                   -- negative for deductions
    reason VARCHAR(50) NOT NULL,              -- 'sale' | 'waste' | 'adjustment' | 'restock'
    reference_id TEXT,                        -- e.g. order id
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PURCHASE ORDERS
CREATE TABLE purchase_orders (
    id TEXT PRIMARY KEY,
    vendor_id TEXT REFERENCES vendors(id),
    status VARCHAR(20) NOT NULL DEFAULT 'draft',  -- draft | approved | sent
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE po_items (
    id TEXT PRIMARY KEY,
    po_id TEXT REFERENCES purchase_orders(id),
    inventory_item_id TEXT REFERENCES inventory_items(id),
    quantity_packs NUMERIC NOT NULL,
    unit_price NUMERIC NOT NULL
);

-- LABOR DOMAIN
CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    hourly_rate NUMERIC NOT NULL
);
CREATE TABLE employees (
    id TEXT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    role_id TEXT REFERENCES roles(id),
    pin VARCHAR(10)
);
CREATE TABLE time_clock_entries (
    id TEXT PRIMARY KEY,
    employee_id TEXT REFERENCES employees(id),
    clock_in TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    clock_out TIMESTAMP,
    regular_hours NUMERIC DEFAULT 0,
    overtime_hours NUMERIC DEFAULT 0,
    hourly_rate NUMERIC NOT NULL              -- copied from role at clock-in (immutable history)
);
