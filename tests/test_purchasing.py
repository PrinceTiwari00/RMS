import math

import pytest

from rms import inventory, purchasing


def _item(**kw):
    base = dict(avg_daily_usage=10, max_daily_usage=20, lead_time_days=2,
                max_lead_time_days=5, par_level=400, pack_size=50,
                current_stock=30, vendor_id="v1")
    base.update(kw)
    return base


def test_safety_stock_formula():
    # (20 x 5) - (10 x 2) = 80
    assert purchasing.safety_stock(_item()) == 80


def test_reorder_point_formula():
    # (10 x 2) + 80 = 100
    assert purchasing.reorder_point(_item()) == 100


def test_order_qty_packs_ceil_with_pack_conversion():
    # ceil((400 - 30) / 50) = ceil(7.4) = 8 packs
    assert purchasing.order_qty_packs(_item()) == math.ceil(370 / 50) == 8
    assert purchasing.order_qty_packs(_item(current_stock=500)) == 0


def test_draft_pos_pooled_by_vendor_and_held_in_draft(conn):
    conn.execute("INSERT INTO vendors (id, name, edi_enabled) VALUES ('v1', 'Sysco', 1)")
    conn.execute("INSERT INTO vendors (id, name) VALUES ('v2', 'Local Farm')")
    conn.commit()
    beef = inventory.add_inventory_item(
        conn, "Ground Beef", "oz", current_stock=30, vendor_id="v1",
        avg_daily_usage=10, max_daily_usage=20, lead_time_days=2,
        max_lead_time_days=5, par_level=400, pack_size=50)
    lettuce = inventory.add_inventory_item(
        conn, "Lettuce", "head", current_stock=1, vendor_id="v2",
        avg_daily_usage=5, max_daily_usage=8, lead_time_days=1,
        max_lead_time_days=2, par_level=20, pack_size=10)

    po_ids = purchasing.generate_draft_pos(conn, unit_price=4.25)
    assert len(po_ids) == 2  # one draft PO per vendor
    for po_id in po_ids:
        status = conn.execute("SELECT status, vendor_id FROM purchase_orders WHERE id = ?",
                              (po_id,)).fetchone()
        assert status["status"] == "draft"
        line = conn.execute("SELECT * FROM po_items WHERE po_id = ?", (po_id,)).fetchone()
        expected = beef if status["vendor_id"] == "v1" else lettuce
        assert line["inventory_item_id"] == expected
    purchasing.approve_po(conn, po_ids[0])
    assert conn.execute("SELECT status FROM purchase_orders WHERE id = ?",
                        (po_ids[0],)).fetchone()[0] == "approved"


def test_send_and_receive_po_restock_inventory_once(conn):
    conn.execute("INSERT INTO vendors (id, name) VALUES ('vendor', 'Local Farm')")
    conn.commit()
    item = inventory.add_inventory_item(
        conn, "Flour", "lb", current_stock=10, vendor_id="vendor",
        avg_daily_usage=2, max_daily_usage=2, lead_time_days=10,
        max_lead_time_days=10, par_level=30, pack_size=5)
    po_id = purchasing.generate_draft_pos(conn)[0]

    with pytest.raises(ValueError):
        purchasing.receive_po(conn, po_id)  # draft POs cannot be received

    purchasing.approve_po(conn, po_id)
    purchasing.mark_po_sent(conn, po_id)
    received = purchasing.receive_po(conn, po_id)

    assert inventory.get_stock(conn, item) == 30.0  # four 5 lb packs added
    assert len(received) == 1 and received[0]["delta"] == 20.0
    row = conn.execute(
        "SELECT delta, reason, reference_id FROM inventory_transactions"
        " WHERE reference_id = ?", (po_id,)).fetchone()
    assert tuple(row) == (20.0, "restock", po_id)
    assert conn.execute("SELECT status FROM purchase_orders WHERE id = ?",
                        (po_id,)).fetchone()[0] == "received"
    with pytest.raises(ValueError):
        purchasing.receive_po(conn, po_id)  # cannot double-count a delivery
    assert inventory.get_stock(conn, item) == 30.0


def test_receive_po_is_atomic_when_any_line_is_invalid(conn):
    conn.execute("INSERT INTO vendors (id, name) VALUES ('vendor', 'Local Farm')")
    conn.commit()
    first = inventory.add_inventory_item(conn, "Rice", "lb", current_stock=2)
    second = inventory.add_inventory_item(conn, "Oil", "gal", current_stock=3)
    po_id = "po-invalid-line"
    conn.execute("INSERT INTO purchase_orders (id, vendor_id, status)"
                 " VALUES (?, 'vendor', 'sent')", (po_id,))
    conn.execute("INSERT INTO po_items (id, po_id, inventory_item_id, quantity_packs, unit_price)"
                 " VALUES ('line-ok', ?, ?, 2, 1)", (po_id, first))
    conn.execute("UPDATE inventory_items SET pack_size = 0 WHERE id = ?", (second,))
    conn.execute("INSERT INTO po_items (id, po_id, inventory_item_id, quantity_packs, unit_price)"
                 " VALUES ('line-invalid', ?, ?, 2, 1)", (po_id, second))
    conn.commit()

    with pytest.raises(ValueError, match="pack size"):
        purchasing.receive_po(conn, po_id)

    assert inventory.get_stock(conn, first) == 2.0
    assert conn.execute("SELECT COUNT(*) FROM inventory_transactions").fetchone()[0] == 0
    assert conn.execute("SELECT status FROM purchase_orders WHERE id = ?",
                        (po_id,)).fetchone()[0] == "sent"
