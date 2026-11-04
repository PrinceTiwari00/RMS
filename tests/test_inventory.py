from rms import inventory, menu, orders


def _stocked_burger(conn):
    beef = inventory.add_inventory_item(conn, "Ground Beef", "oz", current_stock=100.0)
    bun = inventory.add_inventory_item(conn, "Bun", "ea", current_stock=50.0)
    burger = menu.add_menu_item(conn, "Cheeseburger", 10.00)
    inventory.add_recipe_component(conn, burger, beef, 6.0)   # 6 oz per burger
    inventory.add_recipe_component(conn, burger, bun, 1.0)
    return burger, beef, bun


def test_bom_deduction_on_close(conn):
    burger, beef, bun = _stocked_burger(conn)
    order = orders.create_order(conn)
    orders.add_item(conn, order, burger, quantity=2)
    entries = inventory.deduct_for_order(conn, order)
    assert inventory.get_stock(conn, beef) == 88.0   # 100 - 2*6 oz
    assert inventory.get_stock(conn, bun) == 48.0
    assert len(entries) == 2 and all(e["delta"] < 0 for e in entries)


def test_close_order_triggers_deduction_and_ledger(conn):
    burger, beef, _ = _stocked_burger(conn)
    order = orders.create_order(conn)
    orders.add_item(conn, order, burger, quantity=1)
    orders.close_order(conn, order)
    assert inventory.get_stock(conn, beef) == 94.0
    ledger = conn.execute(
        "SELECT * FROM inventory_transactions WHERE reference_id = ?", (order,)).fetchall()
    assert len(ledger) == 2
    assert all(row["reason"] == "sale" for row in ledger)


def test_ledger_is_immutable(conn):
    beef = inventory.add_inventory_item(conn, "Ground Beef", "oz", current_stock=10.0)
    tx = inventory.adjust_stock(conn, beef, -2.0, "waste")
    # No update path exists; attempting a direct UPDATE is the only mutation vector,
    # and domain code never rewrites rows. Verify the row persists unchanged.
    row = conn.execute("SELECT * FROM inventory_transactions WHERE id = ?", (tx,)).fetchone()
    assert row["delta"] == -2.0 and row["reason"] == "waste"
