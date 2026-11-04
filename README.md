# RMS — Restaurant Management System

RMS combines the restaurant domain modules with a browser-based operations MVP.
The web app uses the existing SQLite-backed domain logic for table service,
kitchen tickets, inventory movements, and cash checkout.

## Product workflow

1. Open an available table and start a ticket.
2. Add menu items and optional modifiers; the prices are snapshotted on the line.
3. Send the ticket to the kitchen. Appetizers and drinks start immediately;
   entrees remain on HOLD until fired.
4. Mark each kitchen item READY, then complete a cash checkout.
5. The sale closes atomically with recipe stock deductions and ledger entries;
   the table becomes dirty until reset.
6. Review stock and record received quantities or waste adjustments.

The first run seeds a small sample menu, floor plan, recipes, inventory, and
vendor. The UI is responsive and uses local assets only.

## Run locally

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt pytest
RMS_ENV=demo python3 app.py
```

Open `http://localhost:8000`. The demo database is `rms.db` in the repository
and is ignored by Git. Delete that file to reset demo data. Tests:

```bash
python -m pytest -q
```

## Deployment and safety boundary

The `Procfile` starts Gunicorn in **production mode**, which fails closed unless
both `RMS_ADMIN_PASSWORD` (at least 16 characters) and `RMS_SECRET_KEY` (at
least 32 characters, stable across restarts) are configured. Set those only in
your deployment platform's secret/environment settings, never in Git. Production
API requests require the administrator session and CSRF token; session cookies
are HTTP-only, SameSite=Lax, and Secure.

This is a usable single-store MVP, not yet a production POS deployment:

- Production login is a single shared administrator password; there are no
  staff roles, individual audit identities, or login rate limiting.
- The app uses an instance-local SQLite file. A hosted instance can be replaced
  or scaled, so use a durable/shared database adapter and tested backups before
  recording real restaurant transactions in the cloud.
- Checkout is cash-only. No card numbers or card tokens are collected by this
  UI; tax, tips, refunds, discounts, and split payments are not implemented.
- The browser app requires connectivity to its server. The `rms.sync` module
  models a local sync queue, but full browser-side offline POS operation is not
  wired into this interface.
- AWS infrastructure was not created. Confirm the project's selected Region
  before provisioning any regional resources.

## Domain modules

| Module | Capability |
|---|---|
| `rms/menu.py` | Menu items and modifiers |
| `rms/orders.py` | Order lifecycle and price-at-time snapshots |
| `rms/sync.py` | Offline sync queue and FIFO flush |
| `rms/tables.py` | Floor-plan state machine |
| `rms/kds.py` | Kitchen routing, entree HOLD, item READY, expo state |
| `rms/inventory.py` | Recipe deduction and inventory transaction ledger |
| `rms/purchasing.py` | Reorder calculations and approve → send → receive PO workflow |
| `rms/payments.py` | EMV/store-and-forward domain helpers plus cash checkout record |
| `rms/printing.py` | ESC/POS ticket buffer and backup-printer routing |
| `rms/queues.py` | Retryable job queue and dead-letter handling |
| `rms/labor.py` | Clock-in/out and labor cost calculations |
| `rms/edi.py` | ANSI X12 EDI 850 generation |
