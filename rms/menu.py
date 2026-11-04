"""Menu domain — menu items and modifiers (blueprint §2)."""

from .db import new_uuid, money


def add_menu_item(conn, name: str, base_price: float, is_available: bool = True,
                  course: str = "entree", default_station: str = "grill") -> str:
    item_id = new_uuid()
    conn.execute(
        "INSERT INTO menu_items (id, name, base_price, is_available, course, default_station)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (item_id, name, money(base_price), is_available, course, default_station),
    )
    conn.commit()
    return item_id


def add_modifier(conn, menu_item_id: str, name: str, price_adjustment: float = 0.0) -> str:
    mod_id = new_uuid()
    conn.execute(
        "INSERT INTO modifiers (id, menu_item_id, name, price_adjustment) VALUES (?, ?, ?, ?)",
        (mod_id, menu_item_id, name, money(price_adjustment)),
    )
    conn.commit()
    return mod_id


def get_menu_item(conn, menu_item_id: str):
    return conn.execute("SELECT * FROM menu_items WHERE id = ?", (menu_item_id,)).fetchone()


def update_price(conn, menu_item_id: str, new_price: float) -> None:
    """Menu prices may change globally; historical orders keep price_at_time (blueprint §1)."""
    conn.execute("UPDATE menu_items SET base_price = ? WHERE id = ?",
                 (money(new_price), menu_item_id))
    conn.commit()
