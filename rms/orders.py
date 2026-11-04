"""Order domain — lifecycle open -> sent_to_kitchen -> closed, with
price_at_time locked on every line item and modifier (blueprint §1, §2, §14)."""

from .db import new_uuid, money
from .menu import get_menu_item

ORDER_STATUSES = ("open", "sent_to_kitchen", "closed")


def create_order(conn) -> str:
    order_id = new_uuid()
    conn.execute("INSERT INTO orders (id, status) VALUES (?, 'open')", (order_id,))
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

    item_id = new_uuid()
    price_at_time = money(item["base_price"])  # CRITICAL: lock price at time of sale
    conn.execute(
        "INSERT INTO order_items (id, order_id, menu_item_id, quantity, price_at_time)"
        " VALUES (?, ?, ?, ?, ?)",
        (item_id, order_id, menu_item_id, quantity, price_at_time),
    )
    for mod_id in modifier_ids or []:
        mod = conn.execute("SELECT * FROM modifiers WHERE id = ? AND menu_item_id = ?",
                           (mod_id, menu_item_id)).fetchone()
        if mod is None:
            raise ValueError(f"modifier {mod_id} not valid for item {menu_item_id}")
        conn.execute(
            "INSERT INTO order_item_modifiers (id, order_item_id, modifier_id, price_at_time)"
            " VALUES (?, ?, ?, ?)",
            (new_uuid(), item_id, mod_id, money(mod["price_adjustment"])),
        )
    conn.commit()
    return item_id


def _line_total(conn, order_item) -> float:
    mods = conn.execute(
        "SELECT price_at_time FROM order_item_modifiers WHERE order_item_id = ?",
        (order_item["id"],)).fetchall()
    unit = money(order_item["price_at_time"]) + sum(money(m["price_at_time"]) for m in mods)
    return money(unit * order_item["quantity"])


def compute_subtotal(conn, order_id: str) -> float:
    items = conn.execute("SELECT * FROM order_items WHERE order_id = ?", (order_id,)).fetchall()
    return money(sum(_line_total(conn, i) for i in items))


def send_to_kitchen(conn, order_id: str) -> None:
    conn.execute("UPDATE orders SET status = 'sent_to_kitchen', subtotal = ? WHERE id = ?",
                 (compute_subtotal(conn, order_id), order_id))
    conn.commit()


def close_order(conn, order_id: str) -> float:
    """Close the ticket: lock subtotal and trigger post-order ledger updates
    (recipe-based stock deduction + immutable audit log) — blueprint §14 step 5."""
    from .inventory import deduct_for_order
    order = conn.execute("SELECT status FROM orders WHERE id = ?", (order_id,)).fetchone()
    if order is None or order["status"] == "closed":
        raise ValueError("order is not closable")
    subtotal = compute_subtotal(conn, order_id)
    deduct_for_order(conn, order_id)
    conn.execute("UPDATE orders SET status = 'closed', subtotal = ? WHERE id = ?",
                 (subtotal, order_id))
    conn.commit()
    return subtotal
