"""Recipe costing & inventory deduction (blueprint §9, §14 step 5).

Selling a Cheeseburger deducts raw components via the BOM (recipes) junction
table; every deduction writes an immutable ledger row.
"""

from .db import new_uuid, money


def add_inventory_item(conn, name: str, unit_of_measure: str, current_stock: float = 0.0,
                       vendor_id: str | None = None, **kwargs) -> str:
    item_id = new_uuid()
    conn.execute(
        "INSERT INTO inventory_items (id, name, unit_of_measure, current_stock,"
        " avg_daily_usage, max_daily_usage, lead_time_days, max_lead_time_days,"
        " par_level, pack_size, vendor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (item_id, name, unit_of_measure, money(current_stock),
         kwargs.get("avg_daily_usage", 0), kwargs.get("max_daily_usage", 0),
         kwargs.get("lead_time_days", 0), kwargs.get("max_lead_time_days", 0),
         kwargs.get("par_level", 0), kwargs.get("pack_size", 1), vendor_id),
    )
    conn.commit()
    return item_id


def add_recipe_component(conn, menu_item_id: str, inventory_item_id: str,
                         quantity_required: float) -> None:
    conn.execute(
        "INSERT INTO recipes (menu_item_id, inventory_item_id, quantity_required)"
        " VALUES (?, ?, ?)",
        (menu_item_id, inventory_item_id, quantity_required),
    )
    conn.commit()


def _record_ledger(conn, inventory_item_id: str, delta: float, reason: str,
                   reference_id: str | None) -> str:
    tx_id = new_uuid()
    conn.execute(
        "INSERT INTO inventory_transactions (id, inventory_item_id, delta, reason, reference_id)"
        " VALUES (?, ?, ?, ?, ?)",
        (tx_id, inventory_item_id, delta, reason, reference_id),
    )
    return tx_id


def deduct_for_order(conn, order_id: str) -> list:
    """On ticket closure, deduct raw ingredients per the BOM and log each
    deduction immutably. Returns the ledger entries created."""
    entries = []
    items = conn.execute("SELECT * FROM order_items WHERE order_id = ?", (order_id,)).fetchall()
    for item in items:
        components = conn.execute(
            "SELECT * FROM recipes WHERE menu_item_id = ?", (item["menu_item_id"],)).fetchall()
        for comp in components:
            delta = -1 * round(comp["quantity_required"] * item["quantity"], 4)
            conn.execute(
                "UPDATE inventory_items SET current_stock = current_stock + ? WHERE id = ?",
                (delta, comp["inventory_item_id"]))
            tx_id = _record_ledger(conn, comp["inventory_item_id"], delta, "sale", order_id)
            entries.append({"transaction_id": tx_id,
                            "inventory_item_id": comp["inventory_item_id"],
                            "delta": delta})
    conn.commit()
    return entries


def adjust_stock(conn, inventory_item_id: str, delta: float, reason: str,
                 reference_id: str | None = None) -> str:
    """Manual adjustment (waste/theft/restock) — also immutably logged."""
    conn.execute("UPDATE inventory_items SET current_stock = current_stock + ? WHERE id = ?",
                 (delta, inventory_item_id))
    tx_id = _record_ledger(conn, inventory_item_id, delta, reason, reference_id)
    conn.commit()
    return tx_id


def get_stock(conn, inventory_item_id: str) -> float:
    row = conn.execute("SELECT current_stock FROM inventory_items WHERE id = ?",
                       (inventory_item_id,)).fetchone()
    return money(row["current_stock"])
