#!/usr/bin/env python3
"""End-to-end RMS demo — walks the blueprint §14 operational workflow:
Order Entry -> Kitchen Routing -> Dish Assembly (Expo) -> Payment Auth
-> Ledger & Stock (Inventory / POs). Run: python3 demo.py"""

from datetime import datetime, timedelta

from rms import db, edi, inventory, kds, labor, menu, orders, payments, purchasing, sync, tables


def hr(t): print(f"\n=== {t} ===")

conn = db.connect(":memory:")
db.init_db(conn)

hr("1. MENU & RECIPE SETUP (BOM)")
beef = inventory.add_inventory_item(conn, "Ground Beef", "oz", current_stock=20, vendor_id=None,
                                    avg_daily_usage=2, max_daily_usage=4, lead_time_days=2,
                                    max_lead_time_days=5, par_level=100, pack_size=800)
bun = inventory.add_inventory_item(conn, "Bun", "ea", current_stock=10,
                                   avg_daily_usage=2, max_daily_usage=4, lead_time_days=2,
                                   max_lead_time_days=5, par_level=40, pack_size=24)
conn.execute("INSERT INTO vendors (id, name, preferred, edi_enabled) VALUES ('v1', 'Sysco', 1, 1)")
conn.execute("UPDATE inventory_items SET vendor_id='v1'")
conn.commit()
burger = menu.add_menu_item(conn, "Cheeseburger", 10.00, course="entree", default_station="grill")
fries = menu.add_menu_item(conn, "Fries", 4.50, course="appetizer", default_station="pantry")
wine = menu.add_menu_item(conn, "House Wine", 8.00, course="drink", default_station="bar")
extra_cheese = menu.add_modifier(conn, burger, "Extra Cheese", 1.50)
inventory.add_recipe_component(conn, burger, beef, 6.0)
inventory.add_recipe_component(conn, burger, bun, 1.0)
for n, p in [("Cheeseburger", 10.00), ("Fries", 4.50), ("House Wine", 8.00)]:
    print(f"  - {n}: ${p:.2f}")

hr("2. ORDER ENTRY (POS, offline-first) — price locked at time of sale")
t = tables.add_table(conn, "T12")
tables.seat_party(conn, t)
order = orders.create_order(conn)
oi_burger = orders.add_item(conn, order, burger, quantity=2, modifier_ids=[extra_cheese])
oi_fries = orders.add_item(conn, order, fries)
oi_wine = orders.add_item(conn, order, wine)
sync.enqueue_order_created(conn, {"id": order})
menu.update_price(conn, burger, 12.00)  # price changes AFTER the sale
print(f"  table T12 status: {tables.get_table(conn, t)['status']} ({tables.table_color(conn, t)})")
print(f"  synced queue entries pending: {len(sync.pending(conn))}")

hr("3. KITCHEN ROUTING (KDS)")
orders.send_to_kitchen(conn, order)
tables.mark_ordered(conn, t)
routing = kds.route_order(conn, order)
for station, items in routing.items():
    print(f"  {station}: {len(items)} item(s)")
print(f"  expo: {kds.expo_status(conn, order)['items']}")
kds.mark_item_ready(conn, oi_fries)
kds.mark_item_ready(conn, oi_wine)
print(f"  after bar/pantry ready, all_ready={kds.expo_status(conn, order)['all_ready']} (entree on HOLD)")
kds.fire_entrees(conn, order)
kds.mark_item_ready(conn, oi_burger)
print(f"  after 'Fire Entrees' + grill ready, all_ready={kds.expo_status(conn, order)['all_ready']} -> bump ticket")

hr("4. PAYMENT (EMV terminal, tokenized)")
subtotal = orders.compute_subtotal(conn, order)
print(f"  subtotal (locked prices, incl. modifier): ${subtotal:.2f}  [burger still billed at $10.00]")
pay = payments.pre_authorize(conn, order, subtotal, tip=round(subtotal * 0.20, 2))
print(f"  pre-auth + 20% tip captured: ${conn.execute('SELECT amount FROM payments WHERE id=?', (pay,)).fetchone()[0]:.2f}")

hr("5. TICKET CLOSE -> LEDGER & STOCK DEDUCTION")
tables.mark_billed(conn, t)
final = orders.close_order(conn, order)
tables.pay_and_leave(conn, t)
print(f"  order closed, final subtotal: ${final:.2f}; table now: {tables.get_table(conn, t)['status']} ({tables.table_color(conn, t)})")
print(f"  Ground Beef stock: 20 -> {inventory.get_stock(conn, beef):.2f} oz (2 x 6 oz)")
print(f"  Buns stock: 10 -> {inventory.get_stock(conn, bun):.2f}")
print(f"  ledger rows: {[dict(r) for r in conn.execute('SELECT inventory_item_id, delta, reason FROM inventory_transactions')]}")

hr("6. AUTOMATED DRAFT PO (stock below reorder point)")
po_ids = purchasing.generate_draft_pos(conn, unit_price=32.50)
for po in po_ids:
    row = conn.execute("SELECT * FROM purchase_orders WHERE id=?", (po,)).fetchone()
    lines = conn.execute("SELECT * FROM po_items WHERE po_id=?", (po,)).fetchall()
    print(f"  draft PO {po[:8]}.. vendor={row['vendor_id']} status={row['status']}")
    for l in lines:
        name = conn.execute("SELECT name FROM inventory_items WHERE id=?", (l['inventory_item_id'],)).fetchone()[0]
        print(f"    {name}: {l['quantity_packs']} packs")
purchasing.approve_po(conn, po_ids[0])

hr("7. EDI 850 TO VENDOR (SFTP)")
doc = edi.build_edi_850({"po_num": "PO-1001", "sender": "REST001", "receiver": "SYSCO",
                         "items": [{"qty": 1, "price": "32.50", "sku": "BEEF-50LB"}]},
                        now=datetime(2026, 11, 4, 16, 55))
print(doc)

hr("8. LABOR COST (shift close)")
role = labor.add_role(conn, "Server", 15.00)
emp = labor.add_employee(conn, "Ana", role, pin="1234")
entry = labor.clock_in(conn, emp, "1234", at=datetime(2026, 11, 4, 9, 0))
shift = labor.clock_out(conn, entry, at=datetime(2026, 11, 4, 19, 30))
gross = labor.gross_pay(shift["regular_hours"], shift["overtime_hours"], shift["hourly_rate"])
total = labor.total_labor_cost(gross)
print(f"  shift: {shift['regular_hours']} reg + {shift['overtime_hours']} OT @ ${shift['hourly_rate']}/hr")
print(f"  gross ${gross:.2f} -> burdened ${total:.2f} -> labor cost {labor.labor_cost_pct(total, final * 20):.2f}% of ${final*20:.2f} sales (target 25-35%)")

hr("9. OFFLINE SYNC FLUSH (connectivity restored)")
sent = []
n = sync.flush(conn, lambda p: sent.append(p["sync_id"]) or True)
print(f"  flushed {n} queued mutation(s): {sent}; pending now: {len(sync.pending(conn))}")

print("\nDEMO COMPLETE — full §14 lifecycle executed successfully.")
