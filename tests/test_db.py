from rms.db import connect, init_db


def test_init_db_is_idempotent_and_migrates_web_app_columns():
    conn = connect(":memory:")
    conn.execute("CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT NOT NULL, subtotal NUMERIC, created_at TIMESTAMP)")
    conn.execute("CREATE TABLE payments (id TEXT PRIMARY KEY, order_id TEXT, amount NUMERIC NOT NULL, method TEXT, status TEXT, card_token TEXT)")

    init_db(conn)
    init_db(conn)

    order_columns = {row["name"] for row in conn.execute("PRAGMA table_info(orders)")}
    payment_columns = {row["name"] for row in conn.execute("PRAGMA table_info(payments)")}
    assert "table_id" in order_columns
    assert "created_at" in payment_columns
    conn.close()
