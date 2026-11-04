# RMS

Offline-first Restaurant Management System, implemented per the **RMS Technical Blueprint**.

## Architecture principles (blueprint §1)

- **Offline-first resilience** — POS terminals use a local embedded database (SQLite here); writes are queued in `sync_queue` and flushed via idempotent endpoints when connectivity returns.
- **Distributed UUIDs** — every entity uses client-generated UUID v4; auto-increment is forbidden.
- **Price-at-time mutability** — order line items and modifiers lock `price_at_time`; menu prices can change without touching historical financials.

## Modules

| Module | Blueprint section |
|---|---|
| `rms/menu.py` | §2 Menu domain, modifiers |
| `rms/orders.py` | §2/§14 Order lifecycle `open → sent_to_kitchen → closed`, `price_at_time` |
| `rms/sync.py` | §3 Offline sync queue + JSON payload + idempotent FIFO flush |
| `rms/tables.py` | §5 Floor-plan state machine (green/blue/amber/purple/red) |
| `rms/kds.py` | §6 KDS routing, entree HOLD, item-level READY, expo bump |
| `rms/inventory.py` | §9 BOM recipe deduction + immutable `inventory_transactions` ledger |
| `rms/purchasing.py` | §10 Safety stock / reorder point / pack math, vendor-pooled draft POs |
| `rms/labor.py` | §11 Gross pay, 1.18 burden factor, labor cost %, rate copied at clock-in |
| `rms/edi.py` | §13 ANSI X12 EDI 850 generation |

## Run

```bash
pip install pytest
python3 -m pytest -q
```
