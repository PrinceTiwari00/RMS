"""Database connection helpers. SQLite stands in for the local embedded
database on POS terminals (blueprint §1: SQLite/IndexedDB, offline-first)."""

import sqlite3
import uuid
from pathlib import Path

SCHEMA_PATH = Path(__file__).parent / "schema.sql"


def new_uuid() -> str:
    """Client-generated UUID v4 — distributed IDs, no auto-increment (blueprint §1)."""
    return str(uuid.uuid4())


def connect(path: str = ":memory:") -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    """Create or migrate the local schema safely on every app startup."""
    conn.executescript(SCHEMA_PATH.read_text())
    order_columns = {row["name"] for row in conn.execute("PRAGMA table_info(orders)")}
    if "table_id" not in order_columns:
        conn.execute("ALTER TABLE orders ADD COLUMN table_id TEXT REFERENCES tables(id)")
    payment_columns = {row["name"] for row in conn.execute("PRAGMA table_info(payments)")}
    if "created_at" not in payment_columns:
        conn.execute("ALTER TABLE payments ADD COLUMN created_at TIMESTAMP")
    conn.commit()


def money(x: float) -> float:
    """Round to DECIMAL(10,2) precision."""
    return round(float(x) + 0.0, 2)
