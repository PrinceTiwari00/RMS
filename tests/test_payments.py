import pytest

from rms import orders, payments


def test_pre_authorize_captures_amount_plus_tip(conn):
    pay = order = orders.create_order(conn)
    pay = payments.pre_authorize(conn, order, 20.00, tip=5.00)
    row = conn.execute("SELECT * FROM payments WHERE id = ?", (pay,)).fetchone()
    assert row["amount"] == 25.00 and row["status"] == "authorized"


def test_tip_adjust_captures_final_total(conn):
    pay = order = orders.create_order(conn)
    pay = payments.create_payment(conn, order, 30.00)
    total = payments.tip_adjust(conn, pay, tip=6.00)
    assert total == 36.00
    row = conn.execute("SELECT status FROM payments WHERE id = ?", (pay,)).fetchone()
    assert row["status"] == "captured"


def test_store_and_forward_respects_risk_limit(conn):
    o1 = orders.create_order(conn)
    payments.store_and_forward(conn, o1, "tok_a", 400.00)
    o2 = orders.create_order(conn)
    payments.store_and_forward(conn, o2, "tok_b", 99.99)
    with pytest.raises(ValueError):  # 400 + 99.99 + 1 > $500 limit
        o3 = orders.create_order(conn)
        payments.store_and_forward(conn, o3, "tok_c", 1.00)
    pay = conn.execute("SELECT id FROM payments WHERE order_id = ?", (o2,)).fetchone()["id"]
    payments.forward_stored(conn, pay)
    assert conn.execute("SELECT status FROM payments WHERE id = ?", (pay,)).fetchone()[0] == "captured"


def test_no_raw_card_numbers_stored(conn):
    pay = order = orders.create_order(conn)
    pay = payments.store_and_forward(conn, order, "tok_visa_4242", 10.00)
    row = conn.execute("SELECT card_token FROM payments WHERE id = ?", (pay,)).fetchone()
    assert row["card_token"] == "tok_visa_4242"  # tokenized only, never a PAN
