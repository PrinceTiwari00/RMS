"""Kitchen Display System routing (blueprint §6, §14 step 2-3).

A guest ticket is split into per-station instructions. Appetizers route
immediately; entrees sit in HOLD until "Fire Entrees". Cooks mark individual
line items READY; the Expo screen only completes the master ticket when every
sub-station item is READY.
"""

from .menu import get_menu_item


def route_order(conn, order_id: str) -> dict:
    """On ORDER_FIRED, map each line item to its prep station. Returns
    {station: [order_item_id, ...]}."""
    routing = {}
    items = conn.execute("SELECT * FROM order_items WHERE order_id = ?", (order_id,)).fetchall()
    for item in items:
        menu = get_menu_item(conn, item["menu_item_id"])
        station = menu["default_station"]
        # Course timing: appetizers route immediately, entrees HOLD until fired.
        kds_status = "PENDING" if menu["course"] == "appetizer" else "HOLD"
        conn.execute("UPDATE order_items SET kds_status = ? WHERE id = ?",
                     (kds_status, item["id"]))
        routing.setdefault(station, []).append(item["id"])
    conn.commit()
    return routing


def fire_entrees(conn, order_id: str) -> None:
    """Server taps 'Fire Entrees': HOLD -> PENDING."""
    conn.execute("UPDATE order_items SET kds_status = 'PENDING'"
                 " WHERE order_id = ? AND kds_status = 'HOLD'", (order_id,))
    conn.commit()


def mark_item_ready(conn, order_item_id: str) -> None:
    """Prep cook double-taps a line item to mark it READY."""
    conn.execute("UPDATE order_items SET kds_status = 'READY' WHERE id = ?",
                 (order_item_id,))
    conn.commit()


def expo_status(conn, order_id: str) -> dict:
    """Expo view: per-item checkmarks plus whether the master ticket may bump."""
    items = conn.execute(
        "SELECT id, kds_status FROM order_items WHERE order_id = ?", (order_id,)).fetchall()
    statuses = {i["id"]: i["kds_status"] for i in items}
    all_ready = bool(statuses) and all(s == "READY" for s in statuses.values())
    return {"items": statuses, "all_ready": all_ready}
