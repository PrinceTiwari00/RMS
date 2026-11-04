import math

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
