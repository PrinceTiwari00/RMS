"""Payment gateway integration (EMV) — blueprint §4.

PCI-DSS semi-integrated architecture: the POS never handles raw card numbers;
a smart terminal (Stripe WisePOS E / Square Terminal style) tokenizes.
Supports pre-authorization (quick service), tip adjust (table service), and
store-and-forward offline payments up to a business-defined risk limit.
"""

from .db import new_uuid, money

# Business-defined store-and-forward risk limit (blueprint §4: e.g. $500 total).
OFFLINE_RISK_LIMIT = 500.00


def record_cash_payment(conn, order_id: str, amount: float, *, commit: bool = True) -> str:
    """Record a cash tender; no card data or gateway interaction is involved."""
    amount = money(amount)
    if amount <= 0:
        raise ValueError("payment amount must be positive")
    payment_id = new_uuid()
    conn.execute(
        "INSERT INTO payments (id, order_id, amount, method, status)"
        " VALUES (?, ?, ?, 'cash', 'captured')",
        (payment_id, order_id, amount),
    )
    if commit:
        conn.commit()
    return payment_id


def create_payment(conn, order_id: str, amount: float, method: str = "emv") -> str:
    pay_id = new_uuid()
    conn.execute(
        "INSERT INTO payments (id, order_id, amount, method, status) VALUES (?, ?, ?, ?, 'authorized')",
        (pay_id, order_id, money(amount), method),
    )
    conn.commit()
    return pay_id


def pre_authorize(conn, order_id: str, amount: float, tip: float = 0.0) -> str:
    """Quick service: card dipped, terminal prompts for tip, auth captured immediately."""
    return create_payment(conn, order_id, money(amount + tip))


def tip_adjust(conn, payment_id: str, tip: float) -> float:
    """Table service: card was authorized for the base amount; at shift close the
    POS captures the final total via tip-adjust. Returns the new captured total."""
    row = conn.execute("SELECT * FROM payments WHERE id = ?", (payment_id,)).fetchone()
    if row is None or row["status"] not in ("authorized", "captured"):
        raise ValueError("payment not adjustable")
    new_total = money(row["amount"] + money(tip))
    conn.execute("UPDATE payments SET amount = ?, status = 'captured' WHERE id = ?",
                 (new_total, payment_id))
    conn.commit()
    return new_total


def store_and_forward(conn, order_id: str, encrypted_token: str, amount: float) -> str:
    """Offline payment: terminal encrypts and stores the card token locally until
    internet is restored, up to the store-and-forward risk limit."""
    held = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM payments"
        " WHERE status = 'stored'").fetchone()["total"]
    if money(held + amount) > OFFLINE_RISK_LIMIT:
        raise ValueError(
            f"store-and-forward risk limit ${OFFLINE_RISK_LIMIT:.2f} exceeded")
    pay_id = new_uuid()
    conn.execute(
        "INSERT INTO payments (id, order_id, amount, method, status, card_token)"
        " VALUES (?, ?, ?, 'emv_offline', 'stored', ?)",
        (pay_id, order_id, money(amount), encrypted_token),
    )
    conn.commit()
    return pay_id


def forward_stored(conn, payment_id: str) -> None:
    """Connectivity restored: stored payment is transmitted and captured."""
    conn.execute("UPDATE payments SET status = 'captured' WHERE id = ? AND status = 'stored'",
                 (payment_id,))
    conn.commit()
