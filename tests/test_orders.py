import pytest

from rms import menu, orders


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
