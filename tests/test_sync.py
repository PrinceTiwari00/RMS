from rms import sync


def test_enqueue_uses_blueprint_payload_shape(conn):
    order_id = "ord_uuid_12345"
    sync_id = sync.enqueue(conn, "order", order_id, "CREATE", {"total": 42.0},
                           client_timestamp="2026-10-28T15:30:00Z")
    assert sync_id.startswith("sync_")
    entry = sync.pending(conn)[0]
    payload = entry["payload"]
    assert payload == {
        "sync_id": sync_id,
        "entity_type": "order",
        "entity_id": order_id,
        "action": "CREATE",
        "payload": {"total": 42.0},
        "client_timestamp": "2026-10-28T15:30:00Z",
    }


def test_flush_is_idempotent_and_fifo(conn):
    calls = []
    for i in range(3):
        sync.enqueue(conn, "order", f"ord_{i}", "CREATE", {"n": i},
                     client_timestamp=f"2026-10-28T15:3{i}:00Z")

    # First flush attempt: server rejects the 2nd entry -> only 1 & 3 sync? No:
    # worker stops marking only successful ones; failed entry stays queued.
    def sender(payload):
        calls.append(payload["entity_id"])
        return payload["entity_id"] != "ord_1"

    assert sync.flush(conn, sender) == 2
    remaining = sync.pending(conn)
    assert [r["entity_id"] for r in remaining] == ["ord_1"]

    # Retry later (connectivity restored): the failed entry flushes, no duplicates.
    assert sync.flush(conn, lambda p: True) == 1
    assert sync.pending(conn) == []
    assert len(calls) == 3
