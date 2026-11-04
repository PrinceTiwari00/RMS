"""Automated Purchase Order generation (blueprint §10).

A daily CRON job evaluates stock against reorder thresholds, accounting for
vendor packaging sizes, pools draft POs by preferred vendor, and holds them in
draft for GM approval before the vendor cutoff.
"""

import math

from .db import new_uuid, money


def safety_stock(item) -> float:
    """Safety Stock = (Max Daily Usage x Max Lead Time) - (Avg Daily Usage x Avg Lead Time)"""
    return (item["max_daily_usage"] * item["max_lead_time_days"]
            - item["avg_daily_usage"] * item["lead_time_days"])


def reorder_point(item) -> float:
    """Reorder Point = (Avg Daily Usage x Lead Time) + Safety Stock"""
    return item["avg_daily_usage"] * item["lead_time_days"] + safety_stock(item)


def order_qty_packs(item) -> int:
    """Order Qty (Packs) = ceil((Par Level - Current Stock) / Pack Conversion Factor)"""
    if item["current_stock"] >= item["par_level"]:
        return 0
    return math.ceil((item["par_level"] - item["current_stock"]) / item["pack_size"])


def items_below_reorder_point(conn) -> list:
    rows = conn.execute("SELECT * FROM inventory_items").fetchall()
    return [r for r in rows if r["current_stock"] <= reorder_point(r)]


def generate_draft_pos(conn, unit_price: float = 0.0) -> list:
    """Create draft POs pooled by vendor for every item at/below its ROP.
    Returns the list of draft PO ids."""
    by_vendor: dict = {}
    for item in items_below_reorder_point(conn):
        if item["vendor_id"] is None:
            continue
        packs = order_qty_packs(item)
        if packs <= 0:
            continue
        by_vendor.setdefault(item["vendor_id"], []).append((item, packs))

    po_ids = []
    for vendor_id, lines in by_vendor.items():
        po_id = new_uuid()
        conn.execute("INSERT INTO purchase_orders (id, vendor_id, status) VALUES (?, ?, 'draft')",
                     (po_id, vendor_id))
        for item, packs in lines:
            conn.execute(
                "INSERT INTO po_items (id, po_id, inventory_item_id, quantity_packs, unit_price)"
                " VALUES (?, ?, ?, ?, ?)",
                (new_uuid(), po_id, item["id"], packs, money(unit_price)))
        po_ids.append(po_id)
    conn.commit()
    return po_ids


def approve_po(conn, po_id: str) -> None:
    """GM reviews/adjusts and approves the draft before the vendor cutoff."""
    conn.execute("UPDATE purchase_orders SET status = 'approved' WHERE id = ? AND status = 'draft'",
                 (po_id,))
    conn.commit()
