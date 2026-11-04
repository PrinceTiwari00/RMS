"""Automated Purchase Order generation (blueprint §10).

A daily CRON job evaluates stock against reorder thresholds, accounting for
vendor packaging sizes, pools draft POs by preferred vendor, and holds them in
draft for GM approval before the vendor cutoff. Approved orders can be sent and
received; receiving updates the stock balance and immutable inventory ledger in
one transaction.
"""

import math

from .db import new_uuid, money
from .inventory import _record_ledger


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
    changed = conn.execute(
        "UPDATE purchase_orders SET status = 'approved' WHERE id = ? AND status = 'draft'",
        (po_id,)).rowcount
    if not changed:
        raise ValueError("purchase order is not a draft")
    conn.commit()


def mark_po_sent(conn, po_id: str) -> None:
    """Record dispatch to the vendor; only approved orders may be sent."""
    changed = conn.execute(
        "UPDATE purchase_orders SET status = 'sent' WHERE id = ? AND status = 'approved'",
        (po_id,)).rowcount
    if not changed:
        raise ValueError("purchase order is not approved")
    conn.commit()


def receive_po(conn, po_id: str) -> list[dict]:
    """Receive every pack on a sent PO, update stock, and write restock ledger rows.

    This operation is atomic and can only be performed once. Each received
    quantity is converted from vendor packs into the inventory item's base unit
    using ``pack_size``. Returns the inventory transaction records created.
    """
    conn.execute("SAVEPOINT receive_purchase_order")
    try:
        po = conn.execute(
            "SELECT status FROM purchase_orders WHERE id = ?", (po_id,)).fetchone()
        if po is None or po["status"] != "sent":
            raise ValueError("purchase order must be sent before receiving")

        lines = conn.execute(
            "SELECT p.inventory_item_id, p.quantity_packs, i.pack_size"
            " FROM po_items p JOIN inventory_items i ON i.id = p.inventory_item_id"
            " WHERE p.po_id = ?", (po_id,)).fetchall()
        if not lines:
            raise ValueError("cannot receive an empty purchase order")

        entries = []
        for line in lines:
            packs = float(line["quantity_packs"])
            pack_size = float(line["pack_size"])
            if packs <= 0 or pack_size <= 0:
                raise ValueError("purchase quantity and pack size must be positive")
            delta = money(packs * pack_size)
            conn.execute(
                "UPDATE inventory_items SET current_stock = current_stock + ? WHERE id = ?",
                (delta, line["inventory_item_id"]))
            tx_id = _record_ledger(
                conn, line["inventory_item_id"], delta, "restock", po_id)
            entries.append({"transaction_id": tx_id,
                            "inventory_item_id": line["inventory_item_id"],
                            "delta": delta})

        changed = conn.execute(
            "UPDATE purchase_orders SET status = 'received'"
            " WHERE id = ? AND status = 'sent'", (po_id,)).rowcount
        if not changed:
            raise ValueError("purchase order is no longer available to receive")
        conn.execute("RELEASE SAVEPOINT receive_purchase_order")
        conn.commit()
        return entries
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT receive_purchase_order")
        conn.execute("RELEASE SAVEPOINT receive_purchase_order")
        raise
