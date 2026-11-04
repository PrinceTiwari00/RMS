"""Order domain — lifecycle open -> sent_to_kitchen -> closed, with
price_at_time locked on every line item and modifier (blueprint §1, §2, §14)."""

from .db import new_uuid, money
from .menu import get_menu_item

ORDER_STATUSES = ("open", "sent_to_kitchen", "closed")


def create_order(conn, table_id: str | None = None, *, commit: bool = True) -> str:
    order_id = new_uuid()
    conn.execute("INSERT INTO orders (id, status, table_id) VALUES (?, 'open', ?)",
                 (order_id, table_id))
    if commit:
        conn.commit()
    return order_id


def add_item(conn, order_id: str, menu_item_id: str, quantity: int = 1,
             modifier_ids: list | None = None) -> str:
    """Add a line item, locking the current base price into price_at_time."""
    item = get_menu_item(conn, menu_item_id)
    if item is None:
        raise ValueError(f"menu item {menu_item_id} not found")
    if not item["is_available"]:
        raise ValueError(f"menu item {item['name']} is not available")
    order = conn.execute("SELECT status FROM orders WHERE id = ?", (order_id,)).fetchone()
    if order is None or order["status"] != "open":
        raise ValueError("items can only be added to an open order")

    if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity <= 0:
        raise ValueError("quantity must be a positive integer")

    modifiers = []
    for mod_id in modifier_ids or []:
        mod = conn.execute("SELECT * FROM modifiers WHERE id = ? AND menu_item_id = ?",
                           (mod_id, menu_item_id)).fetchone()
        if mod is None:
            raise ValueError(f"modifier {mod_id} not valid for item {menu_item_id}")
        modifiers.append(mod)

    item_id = new_uuid()
    price_at_time = money(item["base_price"])  # CRITICAL: lock price at time of sale
    conn.execute(
        "INSERT INTO order_items (id, order_id, menu_item_id, quantity, price_at_time)"
        " VALUES (?, ?, ?, ?, ?)",
        (item_id, order_id, menu_item_id, quantity, price_at_time),
    )
    for mod_id, mod in zip(modifier_ids or [], modifiers):
        conn.execute(
            "INSERT INTO order_item_modifiers (id, order_item_id, modifier_id, price_at_time)"
            " VALUES (?, ?, ?, ?)",
            (new_uuid(), item_id, mod_id, money(mod["price_adjustment"])),
        )
    conn.commit()
    return item_id


def remove_item(conn, order_id: str, order_item_id: str) -> None:
    """Remove a line (and its modifiers) while an order is still open."""
    order = conn.execute("SELECT status FROM orders WHERE id = ?", (order_id,)).fetchone()
    item = conn.execute(
        "SELECT id FROM order_items WHERE id = ? AND order_id = ?",
        (order_item_id, order_id)).fetchone()
    if order is None or order["status"] != "open" or item is None:
        raise ValueError("line can only be removed from its open order")
    conn.execute("DELETE FROM order_item_modifiers WHERE order_item_id = ?", (order_item_id,))
    conn.execute("DELETE FROM order_items WHERE id = ?", (order_item_id,))
    conn.commit()


def _line_total(conn, order_item) -> float:
    mods = conn.execute(
        "SELECT price_at_time FROM order_item_modifiers WHERE order_item_id = ?",
        (order_item["id"],)).fetchall()
    unit = money(order_item["price_at_time"]) + sum(money(m["price_at_time"]) for m in mods)
    return money(unit * order_item["quantity"])


def compute_subtotal(conn, order_id: str) -> float:
    items = conn.execute("SELECT * FROM order_items WHERE order_id = ?", (order_id,)).fetchall()
    return money(sum(_line_total(conn, i) for i in items))


def send_to_kitchen(conn, order_id: str, *, commit: bool = True) -> None:
    """Lock the subtotal and transition a non-empty open order to the kitchen."""
    count = conn.execute("SELECT COUNT(*) FROM order_items WHERE order_id = ?",
                         (order_id,)).fetchone()[0]
    if count == 0:
        raise ValueError("an empty order cannot be sent to the kitchen")
    subtotal = compute_subtotal(conn, order_id)
    changed = conn.execute(
        "UPDATE orders SET status = 'sent_to_kitchen', subtotal = ?"
        " WHERE id = ? AND status = 'open'", (subtotal, order_id)).rowcount
    if not changed:
        raise ValueError("only an open order can be sent to the kitchen")
    if commit:
        conn.commit()


def close_order(conn, order_id: str, *, commit: bool = True) -> float:
    """Close a ticket and atomically apply its inventory ledger deductions.

    Set ``commit=False`` when composing checkout with other writes in an outer
    transaction; the caller then owns the final commit or rollback.
    """
    from .inventory import _deduct_for_order

    conn.execute("SAVEPOINT close_order")
    try:
        order = conn.execute("SELECT status FROM orders WHERE id = ?", (order_id,)).fetchone()
        if order is None or order["status"] not in ("open", "sent_to_kitchen"):
            raise ValueError("order is not closable")

        subtotal = compute_subtotal(conn, order_id)
        _deduct_for_order(conn, order_id)
        changed = conn.execute(
            "UPDATE orders SET status = 'closed', subtotal = ?"
            " WHERE id = ? AND status IN ('open', 'sent_to_kitchen')",
            (subtotal, order_id)).rowcount
        if not changed:
            raise ValueError("order is no longer closable")
        conn.execute("RELEASE SAVEPOINT close_order")
        if commit:
            conn.commit()
        return subtotal
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT close_order")
        conn.execute("RELEASE SAVEPOINT close_order")
        raise
