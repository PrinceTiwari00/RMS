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


def _transition(conn, table_id: str, to_status: str, *, commit: bool = True) -> None:
    table = get_table(conn, table_id)
    if table is None:
        raise ValueError(f"table {table_id} not found")
    from_status = table["status"]
    if to_status not in ALLOWED_TRANSITIONS[from_status]:
        raise ValueError(f"illegal table transition {from_status} -> {to_status}")
    changed = conn.execute(
        "UPDATE tables SET status = ? WHERE id = ? AND status = ?",
        (to_status, table_id, from_status)).rowcount
    if not changed:
        raise ValueError("table status changed concurrently; refresh and retry")
    if commit:
        conn.commit()


def seat_party(conn, table_id: str, *, commit: bool = True) -> None:      # Available -> Seated
    _transition(conn, table_id, "seated", commit=commit)


def mark_ordered(conn, table_id: str, *, commit: bool = True) -> None:     # Seated -> Ordered
    _transition(conn, table_id, "ordered", commit=commit)


def mark_billed(conn, table_id: str, *, commit: bool = True) -> None:      # Ordered -> Billed
    _transition(conn, table_id, "billed", commit=commit)


def pay_and_leave(conn, table_id: str, *, commit: bool = True) -> None:    # Billed -> Dirty
    _transition(conn, table_id, "dirty", commit=commit)


def clean(conn, table_id: str) -> None:            # Dirty -> Available (reset)
    _transition(conn, table_id, "available")


def table_color(conn, table_id: str) -> str:
    return TABLE_COLORS[get_table(conn, table_id)["status"]]
