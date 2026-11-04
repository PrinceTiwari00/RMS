import sqlite3

import pytest

from rms import inventory, menu, orders


def test_price_at_time_locked_against_menu_price_change(conn):
    item = menu.add_menu_item(conn, "Cheeseburger", 10.00)
    order = orders.create_order(conn)
    orders.add_item(conn, order, item, quantity=2)
    menu.update_price(conn, item, 15.00)  # global price change
    orders.send_to_kitchen(conn, order)
    # Historical financial data stays immutable: still 2 x 10.00
    assert orders.compute_subtotal(conn, order) == 20.00


def test_subtotal_includes_modifier_price_at_time(conn):
    item = menu.add_menu_item(conn, "Coffee", 3.00)
    mod = menu.add_modifier(conn, item, "Oat Milk", 0.75)
    order = orders.create_order(conn)
    orders.add_item(conn, order, item, quantity=2, modifier_ids=[mod])
    assert orders.compute_subtotal(conn, order) == 7.50  # 2 x (3.00 + 0.75)


def test_order_lifecycle(conn):
    item = menu.add_menu_item(conn, "Fries", 4.50)
    order = orders.create_order(conn)
    orders.add_item(conn, order, item)
    orders.send_to_kitchen(conn, order)
    assert conn.execute("SELECT status FROM orders WHERE id = ?", (order,)).fetchone()[0] \
        == "sent_to_kitchen"
    subtotal = orders.close_order(conn, order)
    assert subtotal == 4.50
    assert conn.execute("SELECT status FROM orders WHERE id = ?", (order,)).fetchone()[0] == "closed"


def test_cannot_add_item_to_closed_order(conn):
    item = menu.add_menu_item(conn, "Fries", 4.50)
    order = orders.create_order(conn)
    orders.add_item(conn, order, item)
    orders.close_order(conn, order)
    with pytest.raises(ValueError):
        orders.add_item(conn, order, item)


def test_unavailable_item_rejected(conn):
    item = menu.add_menu_item(conn, "Special", 9.00, is_available=False)
    order = orders.create_order(conn)
    with pytest.raises(ValueError):
        orders.add_item(conn, order, item)


def test_invalid_quantity_or_modifier_does_not_create_partial_line(conn):
    item = menu.add_menu_item(conn, "Coffee", 3.00)
    other_item = menu.add_menu_item(conn, "Tea", 2.50)
    modifier = menu.add_modifier(conn, other_item, "Lemon", 0.25)
    order = orders.create_order(conn)

    for quantity in (0, -1, 1.5, True):
        with pytest.raises(ValueError, match="quantity"):
            orders.add_item(conn, order, item, quantity=quantity)
    with pytest.raises(ValueError, match="modifier"):
        orders.add_item(conn, order, item, modifier_ids=[modifier])

    assert conn.execute("SELECT COUNT(*) FROM order_items WHERE order_id = ?",
                        (order,)).fetchone()[0] == 0


def test_order_lifecycle_transitions_are_guarded(conn):
    item = menu.add_menu_item(conn, "Fries", 4.50)
    order = orders.create_order(conn)
    with pytest.raises(ValueError):
        orders.send_to_kitchen(conn, "missing-order")
    orders.add_item(conn, order, item)
    orders.send_to_kitchen(conn, order)
    with pytest.raises(ValueError):
        orders.send_to_kitchen(conn, order)  # cannot send the same ticket twice


def test_close_order_rolls_back_stock_and_status_when_ledger_write_fails(conn):
    item = menu.add_menu_item(conn, "Burger", 10.00)
    stock = inventory.add_inventory_item(conn, "Buns", "ea", current_stock=10)
    inventory.add_recipe_component(conn, item, stock, 1)
    order = orders.create_order(conn)
    orders.add_item(conn, order, item, quantity=2)
    conn.execute(
        "CREATE TRIGGER fail_sale_ledger BEFORE INSERT ON inventory_transactions "
        "WHEN NEW.reason = 'sale' BEGIN "
        "SELECT RAISE(ABORT, 'ledger unavailable'); END")
    conn.commit()

    with pytest.raises(sqlite3.IntegrityError, match="ledger unavailable"):
        orders.close_order(conn, order)

    assert inventory.get_stock(conn, stock) == 10.0
    assert conn.execute("SELECT status FROM orders WHERE id = ?",
                        (order,)).fetchone()[0] == "open"
    assert conn.execute("SELECT COUNT(*) FROM inventory_transactions").fetchone()[0] == 0
