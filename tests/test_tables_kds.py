import pytest

from rms import kds, menu, orders, tables


def test_table_state_machine_and_colors(conn):
    t = tables.add_table(conn, "T12")
    assert tables.table_color(conn, t) == "green"
    tables.seat_party(conn, t)
    assert tables.table_color(conn, t) == "blue"
    tables.mark_ordered(conn, t)
    assert tables.table_color(conn, t) == "amber"
    tables.mark_billed(conn, t)
    assert tables.table_color(conn, t) == "purple"
    tables.pay_and_leave(conn, t)
    assert tables.table_color(conn, t) == "red"
    tables.clean(conn, t)
    assert tables.table_color(conn, t) == "green"


def test_illegal_transition_rejected(conn):
    t = tables.add_table(conn, "T1")
    with pytest.raises(ValueError):
        tables.mark_billed(conn, t)  # available -> billed not allowed


def test_kds_routing_courses_and_expo_bump(conn):
    burger = menu.add_menu_item(conn, "Burger", 10.0, course="entree", default_station="grill")
    wine = menu.add_menu_item(conn, "Wine", 8.0, course="drink", default_station="bar")
    salad = menu.add_menu_item(conn, "Salad", 7.0, course="appetizer", default_station="pantry")
    order = orders.create_order(conn)
    oi_burger = orders.add_item(conn, order, burger)
    oi_wine = orders.add_item(conn, order, wine)
    oi_salad = orders.add_item(conn, order, salad)

    routing = kds.route_order(conn, order)
    assert set(routing) == {"grill", "bar", "pantry"}
    # Appetizer routes immediately; entree holds.
    assert kds.expo_status(conn, order)["items"][oi_salad] == "PENDING"
    assert kds.expo_status(conn, order)["items"][oi_burger] == "HOLD"

    kds.mark_item_ready(conn, oi_salad)
    kds.mark_item_ready(conn, oi_wine)
    assert kds.expo_status(conn, order)["all_ready"] is False  # entree still held

    kds.fire_entrees(conn, order)
    kds.mark_item_ready(conn, oi_burger)
    status = kds.expo_status(conn, order)
    assert status["all_ready"] is True  # expeditor may now bump the master ticket
