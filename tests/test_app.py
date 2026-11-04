from app import create_app


def _client(tmp_path, **config):
    app = create_app({
        "TESTING": True,
        "DEMO_MODE": True,
        "DATABASE": str(tmp_path / "restaurant.db"),
        **config,
    })
    return app.test_client()


def test_home_and_health_are_served(tmp_path):
    client = _client(tmp_path)
    home = client.get("/")
    health = client.get("/health")
    assert home.status_code == 200 and b"Point of sale" in home.data
    assert health.get_json() == {"service": "rms", "status": "ok"}


def test_state_seeds_demo_menu_tables_and_inventory(tmp_path):
    response = _client(tmp_path).get("/api/state")
    data = response.get_json()
    assert response.status_code == 200
    assert {item["name"] for item in data["menu"]} >= {"House Burger", "Crispy Fries"}
    assert len(data["tables"]) == 6
    assert data["inventory"]


def test_full_cash_order_kitchen_checkout_and_table_reset(tmp_path):
    client = _client(tmp_path)
    state = client.get("/api/state").get_json()
    table = next(row for row in state["tables"] if row["status"] == "available")
    burger = next(row for row in state["menu"] if row["name"] == "House Burger")
    fries = next(row for row in state["menu"] if row["name"] == "Crispy Fries")
    cheese = next(mod for mod in burger["modifiers"] if mod["name"] == "Add cheese")

    response = client.post("/api/orders", json={"table_id": table["id"]})
    assert response.status_code == 201
    order_id = response.get_json()["id"]
    client.post(f"/api/orders/{order_id}/items", json={
        "menu_item_id": burger["id"], "quantity": 1, "modifier_ids": [cheese["id"]]})
    client.post(f"/api/orders/{order_id}/items", json={"menu_item_id": fries["id"], "quantity": 1})

    assert client.post(f"/api/orders/{order_id}/send", json={}).status_code == 200
    assert client.post(f"/api/orders/{order_id}/checkout", json={}).status_code == 400
    state = client.get("/api/state").get_json()
    order = next(row for row in state["orders"] if row["id"] == order_id)
    burger_line = next(item for item in order["items"] if item["name"] == "House Burger")
    fries_line = next(item for item in order["items"] if item["name"] == "Crispy Fries")
    assert burger_line["kds_status"] == "HOLD"
    assert fries_line["kds_status"] == "PENDING"

    assert client.post(f"/api/kitchen/items/{fries_line['id']}/ready", json={}).status_code == 200
    assert client.post(f"/api/orders/{order_id}/fire", json={}).status_code == 200
    assert client.post(f"/api/kitchen/items/{burger_line['id']}/ready", json={}).status_code == 200
    paid = client.post(f"/api/orders/{order_id}/checkout", json={})
    assert paid.status_code == 200
    assert paid.get_json()["total"] == 18.25

    state = client.get("/api/state").get_json()
    assert not state["orders"]
    assert next(row for row in state["tables"] if row["id"] == table["id"])["status"] == "dirty"
    assert state["metrics"]["sales_today"] == 18.25
    assert client.post(f"/api/tables/{table['id']}/clean", json={}).status_code == 200
    state = client.get("/api/state").get_json()
    assert next(row for row in state["tables"] if row["id"] == table["id"])["status"] == "available"


def test_production_api_requires_login_and_csrf(tmp_path):
    app = create_app({
        "TESTING": True,
        "DEMO_MODE": False,
        "DATABASE": str(tmp_path / "production.db"),
        "ADMIN_PASSWORD": "a-long-demo-password-123",
        "SECRET_KEY": "s" * 48,
    })
    client = app.test_client()
    assert client.get("/api/state").status_code == 401
    login = client.post("/api/login", json={"password": "a-long-demo-password-123"})
    assert login.status_code == 200
    assert client.post("/api/orders", json={"table_id": "x"}).status_code == 403
    csrf = client.get("/api/session").get_json()["csrf_token"]
    assert csrf
    assert client.get("/api/state").status_code == 200
    assert client.post("/api/orders", json={"table_id": "x"},
                       headers={"X-CSRF-Token": csrf}).status_code == 400
