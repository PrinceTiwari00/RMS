"""RMS web application: local-first restaurant operations MVP.

The browser UI is served by Flask, while the existing ``rms`` modules remain
responsible for business rules and SQLite persistence. Demo mode is intended
for local evaluation; production mode requires an admin password and a strong
session secret (and still requires a proper deployment/security review).
"""

from __future__ import annotations

import hmac
import math
import os
import secrets
import sqlite3
import threading
from pathlib import Path

from flask import Flask, g, jsonify, request, send_from_directory, session

from rms import db, inventory, kds, menu, orders, payments, tables
from rms.purchasing import reorder_point

ROOT = Path(__file__).parent


def _json_body() -> dict:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise ValueError("request body must be a JSON object")
    return payload


def _seed_demo_data(conn) -> None:
    """Create a small sample restaurant the first time an empty DB is opened."""
    vendor = conn.execute("SELECT id FROM vendors WHERE name = 'Sample Produce & Foods'").fetchone()
    if vendor is None:
        vendor_id = db.new_uuid()
        conn.execute("INSERT INTO vendors (id, name, preferred) VALUES (?, ?, 1)",
                     (vendor_id, "Sample Produce & Foods"))
        conn.commit()
    else:
        vendor_id = vendor["id"]

    stock = {row["name"]: row["id"] for row in
             conn.execute("SELECT id, name FROM inventory_items").fetchall()}
    if not stock:
        stock["Ground beef"] = inventory.add_inventory_item(
            conn, "Ground beef", "oz", 360, vendor_id,
            avg_daily_usage=24, max_daily_usage=36, lead_time_days=2,
            max_lead_time_days=3, par_level=480, pack_size=80)
        stock["Burger buns"] = inventory.add_inventory_item(
            conn, "Burger buns", "each", 36, vendor_id,
            avg_daily_usage=6, max_daily_usage=10, lead_time_days=2,
            max_lead_time_days=3, par_level=60, pack_size=12)
        stock["Potatoes"] = inventory.add_inventory_item(
            conn, "Potatoes", "oz", 200, vendor_id,
            avg_daily_usage=18, max_daily_usage=28, lead_time_days=2,
            max_lead_time_days=3, par_level=360, pack_size=40)
        stock["Lemons"] = inventory.add_inventory_item(
            conn, "Lemons", "each", 24, vendor_id,
            avg_daily_usage=3, max_daily_usage=5, lead_time_days=2,
            max_lead_time_days=3, par_level=36, pack_size=6)

    existing_menu = conn.execute("SELECT id, name FROM menu_items").fetchall()
    menu_ids = {row["name"]: row["id"] for row in existing_menu}
    if not existing_menu:
        menu_ids["House Burger"] = menu.add_menu_item(
            conn, "House Burger", 12.50, course="entree", default_station="grill")
        menu_ids["Crispy Fries"] = menu.add_menu_item(
            conn, "Crispy Fries", 4.50, course="appetizer", default_station="fry")
        menu_ids["Garden Salad"] = menu.add_menu_item(
            conn, "Garden Salad", 8.00, course="appetizer", default_station="pantry")
        menu_ids["House Lemonade"] = menu.add_menu_item(
            conn, "House Lemonade", 3.50, course="drink", default_station="bar")
        menu.add_modifier(conn, menu_ids["House Burger"], "Add cheese", 1.25)
        menu.add_modifier(conn, menu_ids["House Burger"], "No onion", 0)

    if conn.execute("SELECT COUNT(*) FROM recipes").fetchone()[0] == 0:
        recipes = {
            "House Burger": [("Ground beef", 6), ("Burger buns", 1)],
            "Crispy Fries": [("Potatoes", 6)],
            "House Lemonade": [("Lemons", 0.5)],
        }
        for item_name, ingredients in recipes.items():
            if item_name not in menu_ids:
                continue
            for ingredient, qty in ingredients:
                if ingredient in stock:
                    inventory.add_recipe_component(
                        conn, menu_ids[item_name], stock[ingredient], qty)

    if conn.execute("SELECT COUNT(*) FROM tables").fetchone()[0] == 0:
        for label in ("A1", "A2", "A3", "B1", "B2", "Patio 1"):
            tables.add_table(conn, label)


def _order_snapshot(conn, order_row) -> dict:
    items = conn.execute(
        "SELECT oi.*, mi.name AS item_name, mi.course, mi.default_station"
        " FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id"
        " WHERE oi.order_id = ?", (order_row["id"],)).fetchall()
    line_items = []
    for item in items:
        modifiers = conn.execute(
            "SELECT oim.price_at_time, m.name FROM order_item_modifiers oim"
            " JOIN modifiers m ON m.id = oim.modifier_id"
            " WHERE oim.order_item_id = ?", (item["id"],)).fetchall()
        unit_price = float(item["price_at_time"] or 0) + sum(
            float(mod["price_at_time"] or 0) for mod in modifiers)
        line_items.append({
            "id": item["id"], "menu_item_id": item["menu_item_id"],
            "name": item["item_name"], "quantity": item["quantity"],
            "unit_price": round(unit_price, 2),
            "line_total": round(unit_price * item["quantity"], 2),
            "course": item["course"], "station": item["default_station"],
            "kds_status": item["kds_status"],
            "modifiers": [{"name": mod["name"],
                           "price": float(mod["price_at_time"] or 0)} for mod in modifiers],
        })
    return {
        "id": order_row["id"], "status": order_row["status"],
        "table_id": order_row["table_id"], "table_label": order_row["table_label"],
        "created_at": order_row["created_at"],
        "subtotal": orders.compute_subtotal(conn, order_row["id"]),
        "items": line_items,
        "all_ready": kds.expo_status(conn, order_row["id"])["all_ready"],
    }


def _state(conn) -> dict:
    menu_rows = conn.execute("SELECT * FROM menu_items ORDER BY name").fetchall()
    menu_items = []
    for row in menu_rows:
        item = dict(row)
        item["base_price"] = float(item["base_price"])
        item["is_available"] = bool(item["is_available"])
        item["modifiers"] = [dict(mod) for mod in conn.execute(
            "SELECT id, name, price_adjustment FROM modifiers WHERE menu_item_id = ? ORDER BY name",
            (item["id"],)).fetchall()]
        for mod in item["modifiers"]:
            mod["price_adjustment"] = float(mod["price_adjustment"] or 0)
        menu_items.append(item)

    order_rows = conn.execute(
        "SELECT o.*, t.label AS table_label FROM orders o"
        " LEFT JOIN tables t ON t.id = o.table_id"
        " WHERE o.status != 'closed' ORDER BY o.created_at DESC").fetchall()
    active_orders = [_order_snapshot(conn, row) for row in order_rows]
    orders_by_table = {order["table_id"]: order for order in active_orders if order["table_id"]}

    table_rows = conn.execute("SELECT * FROM tables ORDER BY label").fetchall()
    table_data = []
    for row in table_rows:
        item = dict(row)
        item["active_order"] = orders_by_table.get(item["id"])
        table_data.append(item)

    inventory_rows = conn.execute(
        "SELECT i.*, v.name AS vendor_name FROM inventory_items i"
        " LEFT JOIN vendors v ON v.id = i.vendor_id ORDER BY i.name").fetchall()
    stock_data = []
    low_stock = 0
    for row in inventory_rows:
        item = dict(row)
        item["current_stock"] = float(item["current_stock"] or 0)
        item["reorder_point"] = round(float(reorder_point(row)), 2)
        item["low_stock"] = item["current_stock"] <= item["reorder_point"]
        low_stock += int(item["low_stock"])
        stock_data.append(item)

    sales = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) FROM payments"
        " WHERE status = 'captured' AND date(created_at) = date('now', 'localtime')").fetchone()[0]
    return {
        "menu": menu_items,
        "tables": table_data,
        "orders": active_orders,
        "inventory": stock_data,
        "metrics": {
            "sales_today": round(float(sales or 0), 2),
            "open_orders": len(active_orders),
            "occupied_tables": sum(row["status"] != "available" for row in table_data),
            "low_stock": low_stock,
        },
    }


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__, static_folder=str(ROOT / "static"), static_url_path="/assets")
    environment = os.environ.get("RMS_ENV", "demo").lower()
    demo_mode = environment != "production"
    app.config.update(
        SECRET_KEY=os.environ.get("RMS_SECRET_KEY") or secrets.token_hex(32),
        DATABASE=os.environ.get("RMS_DB_PATH", str(ROOT / "rms.db")),
        DEMO_MODE=demo_mode,
        ADMIN_PASSWORD=os.environ.get("RMS_ADMIN_PASSWORD", ""),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=not demo_mode,
        JSON_SORT_KEYS=False,
    )
    if test_config:
        app.config.update(test_config)
    if not app.config["DEMO_MODE"]:
        if len(app.config["ADMIN_PASSWORD"]) < 16:
            raise RuntimeError("RMS_ADMIN_PASSWORD must be at least 16 characters in production")
        if not os.environ.get("RMS_SECRET_KEY") and not (test_config and test_config.get("SECRET_KEY")):
            raise RuntimeError("set a stable RMS_SECRET_KEY in production")
        if len(app.config["SECRET_KEY"]) < 32:
            raise RuntimeError("RMS_SECRET_KEY must be at least 32 characters in production")

    @app.before_request
    def protect_production_routes():
        if app.config["DEMO_MODE"]:
            return None
        if request.path in ("/health", "/api/session", "/api/login") or request.path.startswith("/assets/") or request.path == "/":
            return None
        if request.path.startswith("/api/") and not session.get("authenticated"):
            return jsonify({"error": "authentication required"}), 401
        if request.method not in ("GET", "HEAD", "OPTIONS") and request.path.startswith("/api/"):
            expected = session.get("csrf_token", "")
            supplied = request.headers.get("X-CSRF-Token", "")
            if not expected or not hmac.compare_digest(expected, supplied):
                return jsonify({"error": "invalid CSRF token"}), 403
        return None

    initialized = False
    initialization_lock = threading.Lock()

    def connection():
        nonlocal initialized
        if "db" not in g:
            conn = db.connect(app.config["DATABASE"])
            if not initialized:
                try:
                    with initialization_lock:
                        if not initialized:
                            db.init_db(conn)
                            _seed_demo_data(conn)
                            initialized = True
                except Exception:
                    conn.close()
                    raise
            g.db = conn
        return g.db

    @app.teardown_appcontext
    def close_connection(_error=None):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    @app.get("/")
    def home():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/health")
    def health():
        return jsonify({"service": "rms", "status": "ok"})

    @app.get("/api/session")
    def session_info():
        if session.get("authenticated"):
            return jsonify({"authenticated": True, "demo_mode": app.config["DEMO_MODE"],
                            "csrf_token": session.get("csrf_token")})
        return jsonify({"authenticated": app.config["DEMO_MODE"],
                        "demo_mode": app.config["DEMO_MODE"], "csrf_token": None})

    @app.post("/api/login")
    def login():
        payload = _json_body()
        password = str(payload.get("password", ""))
        if not app.config["DEMO_MODE"] and hmac.compare_digest(
                password, app.config["ADMIN_PASSWORD"]):
            session.clear()
            session["authenticated"] = True
            session["csrf_token"] = secrets.token_urlsafe(32)
            return jsonify({"authenticated": True})
        return jsonify({"error": "invalid credentials"}), 401

    @app.post("/api/logout")
    def logout():
        session.clear()
        return jsonify({"authenticated": False})

    @app.get("/api/state")
    def get_state():
        return jsonify(_state(connection()))

    @app.post("/api/orders")
    def new_order():
        conn = connection()
        payload = _json_body()
        table_id = payload.get("table_id")
        table = tables.get_table(conn, table_id) if table_id else None
        if table is None or table["status"] != "available":
            raise ValueError("choose an available table to start a ticket")
        conn.execute("SAVEPOINT start_table_order")
        try:
            tables.seat_party(conn, table_id, commit=False)
            order_id = orders.create_order(conn, table_id, commit=False)
            conn.execute("RELEASE SAVEPOINT start_table_order")
            conn.commit()
        except Exception:
            conn.execute("ROLLBACK TO SAVEPOINT start_table_order")
            conn.execute("RELEASE SAVEPOINT start_table_order")
            raise
        return jsonify({"id": order_id}), 201

    @app.post("/api/orders/<order_id>/items")
    def add_order_item(order_id):
        payload = _json_body()
        item_id = orders.add_item(
            connection(), order_id, str(payload.get("menu_item_id", "")),
            quantity=payload.get("quantity", 1),
            modifier_ids=payload.get("modifier_ids", []))
        return jsonify({"id": item_id}), 201

    @app.delete("/api/orders/<order_id>/items/<item_id>")
    def delete_order_item(order_id, item_id):
        orders.remove_item(connection(), order_id, item_id)
        return jsonify({"removed": True})

    @app.post("/api/orders/<order_id>/send")
    def send_order(order_id):
        conn = connection()
        row = conn.execute("SELECT table_id FROM orders WHERE id = ?", (order_id,)).fetchone()
        if row is None:
            raise ValueError("order not found")
        conn.execute("SAVEPOINT send_kitchen_ticket")
        try:
            orders.send_to_kitchen(conn, order_id, commit=False)
            kds.route_order(conn, order_id, commit=False)
            if row["table_id"]:
                tables.mark_ordered(conn, row["table_id"], commit=False)
            conn.execute("RELEASE SAVEPOINT send_kitchen_ticket")
            conn.commit()
        except Exception:
            conn.execute("ROLLBACK TO SAVEPOINT send_kitchen_ticket")
            conn.execute("RELEASE SAVEPOINT send_kitchen_ticket")
            raise
        return jsonify({"sent": True})

    @app.post("/api/orders/<order_id>/fire")
    def fire_order(order_id):
        conn = connection()
        row = conn.execute("SELECT status FROM orders WHERE id = ?", (order_id,)).fetchone()
        if row is None or row["status"] != "sent_to_kitchen":
            raise ValueError("ticket must be sent to the kitchen before firing")
        kds.fire_entrees(conn, order_id)
        return jsonify({"fired": True})

    @app.post("/api/kitchen/items/<item_id>/ready")
    def ready_kitchen_item(item_id):
        kds.mark_item_ready(connection(), item_id)
        return jsonify({"ready": True})

    @app.post("/api/orders/<order_id>/checkout")
    def checkout_order(order_id):
        conn = connection()
        conn.execute("SAVEPOINT checkout_order")
        try:
            row = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
            if row is None or row["status"] != "sent_to_kitchen":
                raise ValueError("only an active kitchen ticket can be checked out")
            status = kds.expo_status(conn, order_id)
            if not status["all_ready"]:
                raise ValueError("all kitchen items must be ready before checkout")
            subtotal = orders.compute_subtotal(conn, order_id)
            if subtotal <= 0:
                raise ValueError("an empty ticket cannot be checked out")
            payment_id = payments.record_cash_payment(conn, order_id, subtotal, commit=False)
            orders.close_order(conn, order_id, commit=False)
            if row["table_id"]:
                changed = conn.execute(
                    "UPDATE tables SET status = 'billed' WHERE id = ? AND status = 'ordered'",
                    (row["table_id"],)).rowcount
                if not changed:
                    raise ValueError("table is not ready to be billed")
                conn.execute("UPDATE tables SET status = 'dirty' WHERE id = ?", (row["table_id"],))
            conn.execute("RELEASE SAVEPOINT checkout_order")
            conn.commit()
            return jsonify({"paid": True, "payment_id": payment_id, "total": subtotal})
        except Exception:
            conn.execute("ROLLBACK TO SAVEPOINT checkout_order")
            conn.execute("RELEASE SAVEPOINT checkout_order")
            raise

    @app.post("/api/tables/<table_id>/clean")
    def clean_table(table_id):
        tables.clean(connection(), table_id)
        return jsonify({"clean": True})

    @app.post("/api/inventory/<item_id>/adjust")
    def adjust_inventory(item_id):
        payload = _json_body()
        try:
            quantity = float(payload.get("quantity", 0))
        except (TypeError, ValueError):
            raise ValueError("quantity must be a positive number") from None
        reason = payload.get("reason", "restock")
        if not math.isfinite(quantity) or quantity <= 0:
            raise ValueError("quantity must be a positive number")
        if reason not in ("restock", "waste"):
            raise ValueError("reason must be restock or waste")
        delta = quantity if reason == "restock" else -quantity
        tx_id = inventory.adjust_stock(connection(), item_id, delta, reason)
        return jsonify({"transaction_id": tx_id})

    @app.errorhandler(ValueError)
    def invalid_request(error):
        return jsonify({"error": str(error)}), 400

    @app.errorhandler(sqlite3.IntegrityError)
    def integrity_error(_error):
        return jsonify({"error": "request conflicts with current data"}), 409

    @app.errorhandler(404)
    def not_found(_error):
        if request.path.startswith("/api/"):
            return jsonify({"error": "not found"}), 404
        return "Not found", 404

    return app


app = create_app()
application = app

if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "0.0.0.0"),
            port=int(os.environ.get("PORT", "8000")), debug=False)
