"""Table management — floor plan state machine (blueprint §5).

available (green) -> seated (blue) -> ordered (amber) -> billed (purple)
                  -> dirty (red) -> available
"""

from .db import new_uuid

TABLE_COLORS = {
    "available": "green",
    "seated": "blue",
    "ordered": "amber",
    "billed": "purple",
    "dirty": "red",
}

ALLOWED_TRANSITIONS = {
    "available": {"seated"},
    "seated": {"ordered"},
    "ordered": {"billed"},
    "billed": {"dirty"},
    "dirty": {"available"},
}


def add_table(conn, label: str) -> str:
    table_id = new_uuid()
    conn.execute("INSERT INTO tables (id, label, status) VALUES (?, ?, 'available')",
                 (table_id, label))
    conn.commit()
    return table_id


def get_table(conn, table_id: str):
    return conn.execute("SELECT * FROM tables WHERE id = ?", (table_id,)).fetchone()


def _transition(conn, table_id: str, to_status: str) -> None:
    table = get_table(conn, table_id)
    if table is None:
        raise ValueError(f"table {table_id} not found")
    if to_status not in ALLOWED_TRANSITIONS[table["status"]]:
        raise ValueError(
            f"illegal table transition {table['status']} -> {to_status}")
    conn.execute("UPDATE tables SET status = ? WHERE id = ?", (to_status, table_id))
    conn.commit()


def seat_party(conn, table_id: str) -> None:      # Available -> Seated (tap to open ticket)
    _transition(conn, table_id, "seated")


def mark_ordered(conn, table_id: str) -> None:     # Seated -> Ordered (items sent to kitchen)
    _transition(conn, table_id, "ordered")


def mark_billed(conn, table_id: str) -> None:      # Ordered -> Billed (check printed)
    _transition(conn, table_id, "billed")


def pay_and_leave(conn, table_id: str) -> None:    # Billed -> Dirty (guest paid and left)
    _transition(conn, table_id, "dirty")


def clean(conn, table_id: str) -> None:            # Dirty -> Available (reset)
    _transition(conn, table_id, "available")


def table_color(conn, table_id: str) -> str:
    return TABLE_COLORS[get_table(conn, table_id)["status"]]
