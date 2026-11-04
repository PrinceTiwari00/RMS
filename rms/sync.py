"""Offline-first synchronization queue (blueprint §3).

When the internet drops, mutations are appended to a local sync queue; a
background worker flushes the queue to the cloud API via idempotent endpoints
when connectivity returns.
"""

import json
import uuid
from datetime import datetime, timezone

from .db import new_uuid


def enqueue(conn, entity_type: str, entity_id: str, action: str, payload: dict,
            client_timestamp: str | None = None) -> str:
    """Append a mutation to the local sync queue using the blueprint payload shape."""
    sync_id = "sync_" + uuid.uuid4().hex[:12]
    sync_payload = {
        "sync_id": sync_id,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "action": action,
        "payload": payload,
        "client_timestamp": client_timestamp or datetime.now(timezone.utc).isoformat(),
    }
    conn.execute(
        "INSERT INTO sync_queue (sync_id, entity_type, entity_id, action, payload,"
        " client_timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        (sync_id, entity_type, entity_id, action,
         json.dumps(sync_payload), sync_payload["client_timestamp"]),
    )
    conn.commit()
    return sync_id


def pending(conn) -> list:
    """Unsynced queue entries, oldest first (FIFO flush)."""
    rows = conn.execute(
        "SELECT * FROM sync_queue WHERE synced = 0 ORDER BY client_timestamp").fetchall()
    return [dict(r) | {"payload": json.loads(r["payload"])} for r in rows]


def mark_synced(conn, sync_id: str) -> None:
    conn.execute("UPDATE sync_queue SET synced = 1 WHERE sync_id = ?", (sync_id,))
    conn.commit()


def flush(conn, sender) -> int:
    """Background worker: flush queued mutations through an idempotent endpoint.

    `sender` is a callable taking the sync payload dict and returning True on
    success. Returns the number of entries successfully synced.
    """
    synced = 0
    for entry in pending(conn):
        if sender(entry["payload"]):
            mark_synced(conn, entry["sync_id"])
            synced += 1
    return synced


def enqueue_order_created(conn, order: dict) -> str:
    return enqueue(conn, "order", order["id"], "CREATE", order)
