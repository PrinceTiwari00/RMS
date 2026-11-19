# RMS — Restaurant Management System

RMS is a restaurant operations system built with Next.js, React and SQLite. It
combines front-of-house service, kitchen displays, back-office reporting, and
customer self-service in one Node.js application.

It runs two levels of administration on one deployment:

- a **platform super admin** at `/platform` who creates restaurant accounts,
  suspends them, and resets a restaurant's administrator PIN;
- a **restaurant admin** (the `manager` role) plus staff at `/login` who run
  everything inside their own store.

Each restaurant owns a separate SQLite database, so isolation is physical rather
than a `WHERE tenant_id = ?` convention. See
**[docs/MULTI_TENANT.md](docs/MULTI_TENANT.md)** for the architecture, API and
operations.

All money is stored as integer paisa. Menu prices and modifier prices are
snapshotted onto each order line, and the same domain pricing engine is used by
the POS, guest cart, checkout, and reports.

## Run locally

Requirements: **Node.js 22.22.3 or newer** (the app uses the built-in `node:sqlite`
driver) and npm.

For a clean client/production workspace (no sample staff, sales or menu):

```bash
npm ci
cp .env.example .env
# Set RMS_SECRET_KEY and RMS_SETUP_TOKEN to independently generated random values.
npm run build
npm start
```

Open `/platform`, create the platform owner using the setup token, then create a
**blank** restaurant and its manager PIN. Remove `RMS_SETUP_TOKEN` after setup.
The old `/setup` page redirects to this tenant-aware provisioning flow.
For local development, `npm run dev` starts without automatically adding demo data.

Demo fixtures remain available **only for explicit development/testing use**:

```bash
RMS_ENV=demo npm run db:seed
RMS_ENV=demo npm run dev
# Destructive reset of a disposable demo volume only:
RMS_ENV=demo RMS_ALLOW_RESET=1 npm run db:reset
```

Never reuse a demo volume for clients. Production refuses to boot a volume with
known demo identities or seed markers. Existing real restaurant data is never
automatically deleted. See [production readiness](docs/PRODUCTION_READINESS.md)
for the verification results, limitations and handover checklist.

## System guide

Download the [8-page system and workflow guide (PDF)](docs/RMS-System-Guide.pdf)
for the feature map, staff and guest journeys, back-office diagrams and current
integration limitations. To regenerate it, install `reportlab==4.4.9` in a Python
virtual environment and run `python scripts/generate-system-guide.py`.

## Main workspaces

- `/platform` — super admin console: create restaurants, hand over the admin PIN,
  suspend/reactivate, change plan and contacts, reset a restaurant admin PIN,
  manage platform operators, and read the platform audit log
- `/login` — staff PIN pad bound to a restaurant code
- `/pos` — tickets, menu modifiers, send/fire, and checkout
- `/floor` and `/host` — live floor plan, waitlist, and reservations
- `/kds/grill`, `/expo`, and `/prep` — station boards, the pass, and prep sheets
- `/admin/*` — menu, inventory, recipes, purchasing, waste, floor-plan editing,
  product mix, executive reporting, and Z-reports
- `/admin/users` — the restaurant admin's staff, PIN and permission management
- `/admin/settings` — six-section configuration portal for store identity,
  hours, service periods, taxes, gratuity, service-style presets, hardware,
  RBAC, messaging, vendor EDI, and delivery-provider credentials
- `/cfd` — read-only customer-facing display with a live ticket and payment QR;
  use `/cfd?terminal=term-pos-2` for the second register and
  `/cfd?tenant=<restaurant-code>` on a multi-restaurant deployment
- `/t/[token]` — public QR table ordering, live kitchen status, and guest
  checkout. A seeded example is `/t/t01-m1`.

The guest token grants access only to its assigned table's active QR ticket.
The CFD and QR pages use relative API URLs, so they work behind a reverse proxy
without hardcoding a browser-facing backend origin.

### Configuration portal

Settings are validated and saved atomically with an audit entry. Full-service,
quick-service, and bar/nightclub presets change only workflow controls, never
menu or financial history. KDS category routes are snapshotted onto new order
lines, and offline payments are blocked outside demo mode until gateway capture exists.
Role-matrix changes take effect on the next authenticated API request.

In explicit demo mode, printer discovery is a manager-initiated, bounded scan of
one IPv4 `/24`. Outside demo mode discovery is disabled and device checks require
an exact literal IP in `RMS_HARDWARE_ALLOWED_IPS`. Checks establish TCP only; they do
not claim ESC/POS compatibility or EMV settlement. Live marketplace ingestion,
SMS/email delivery, SFTP, and certified card processing still require the
relevant provider onboarding and connector runtime.

Integration secrets are masked in API responses and omitted from audit details.
Non-empty deployment variables such as `RMS_TWILIO_AUTH_TOKEN` and
`RMS_SENDGRID_API_KEY` override stored credentials without writing them to
SQLite. Protect `.env`, the SQLite file, and backups, and use HTTPS.

## Platform administration

`/platform` is a separate authority: email + password, its own cookie and CSRF
token, and no restaurant permission. Creating a restaurant there provisions an
isolated database, the role matrix, station list, store identity and a `manager`
employee, then shows the restaurant code, sign-in link and PIN once.

Production first-run is one of:

- `/platform` with `RMS_SETUP_TOKEN` (recommended), or
- `RMS_PLATFORM_EMAIL` / `RMS_PLATFORM_PASSWORD` supplied at boot, or
- `/setup` now redirects to `/platform` so new stores are registered correctly.

Suspending a restaurant blocks its staff sign-in and API calls immediately without
touching its data. `RMS_TENANT_DIRECTORY=0` hides restaurant names on the PIN pad.

Each restaurant carries a plan (`free` / `standard` / `pro`) that caps modules and
active staff. Effective permissions are the role matrix intersected with the
plan, re-evaluated per request, and seat limits block adding or reactivating
staff. Both the platform console and `/admin/users` show seat usage. Sign-in on
the PIN pad and the platform console is rate limited (five failures → 15 minute
block). See **[docs/MULTI_TENANT.md](docs/MULTI_TENANT.md)**.

## Hosting on Render

See **[docs/RENDER_DEPLOYMENT.md](docs/RENDER_DEPLOYMENT.md)** and `render.yaml` for
one-click Blueprint deployment (Node `22.22.3`, `/var/data` persistent disk,
auto-generated secrets, and `/api/health` check) as well as a Free-tier demo setup.

## Single-instance AWS deployment

The repository includes a non-root production Dockerfile, single-container
Compose configuration, Nginx/Certbot configuration, environment template, and
consistent SQLite backup automation. Follow **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**
for the complete EC2, HTTPS, first-run setup, update, and restore procedure.

Use a fresh production data directory. Production startup migrates the control
plane and every restaurant database but never seeds demo accounts or orders, and
requires a stable random `RMS_SECRET_KEY`.
An empty workspace is initialized once at `/setup` with `RMS_SETUP_TOKEN`, a
restaurant profile, and a new hashed manager PIN. Blank the setup token after
initialization and recreate the container.

For a direct standalone run, keep secrets outside Next's build-time `.env`
discovery and use `RMS_ENV_FILE=/secure/path/rms.env npm run start`. The start
script prepares standalone assets and resolves `RMS_DATA_DIR` to an absolute
path. The post-build/start cleanup removes any traced `data`, `backups`, or
`.env*` files from standalone output. The backup wrapper accepts the same
`RMS_ENV_FILE` variable.

This baseline is one EC2 instance with local persistent storage and one SQLite
writer. It does not provide certified card settlement, automatic restaurant-LAN
access, high availability, or horizontal scaling. Migrate to PostgreSQL and
redesign shared state before running multiple application instances.

## Verify

```bash
npm run typecheck
npm test
npm run build
RMS_ENV=demo npm run start   # explicit local demo mode
```

The test suite covers domain arithmetic, state machines, permissions, seed
integrity, signed sessions, the mandatory CSRF-header regression, and
multi-restaurant isolation (provisioning, physical data separation, suspension,
PIN reset and platform-staff token scoping), plan entitlements and sign-in
throttling. The production build compiles every
App Router page and API route.

## Security and deployment boundary

- Staff authentication uses an HMAC-signed, HTTP-only session cookie.
- Authenticated mutations require the readable CSRF cookie **and** an explicit
  matching `x-csrf-token` header. The server never substitutes the Cookie header
  for that proof.
- Permissions are re-read from the database on every request, then capped by the
  restaurant's plan.
- PIN and password sign-in are rate limited per client + restaurant/email; a
  success clears the counter.
- Set `RMS_ENV=production` and a stable, random `RMS_SECRET_KEY` of at least 32
  characters outside Git. Production cookies are Secure and SameSite=Lax.
- SQLite is instance-local. `control.db` and the per-restaurant databases must be
  backed up and restored together; `npm run db:backup` produces one consistent
  snapshot directory with a manifest. Use durable storage and a tested restore.
- Platform (super admin) accounts and restaurant staff sessions are separate
  cookies with separate scopes; neither can be used as the other.
- A restaurant is isolated by its own database file. There is no cross-tenant
  query path in the service layer.
- Guest card/wallet checkout records a tender; it does **not** integrate with or
  independently verify a payment gateway. Demo mode labels this explicitly.
  Do not treat it as real payment settlement.
- This remains an MVP, not a certified fiscal POS. Multi-restaurant hosting is a
  single-instance SQLite architecture: migrate to PostgreSQL and redesign shared
  state before running more than one application instance.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/domain` | Framework-free money, pricing, KDS, table, inventory, labour, and checkout rules |
| `src/db` | Per-restaurant SQLite schema, control-plane schema, connection scoping, migrations, and demo seed |
| `src/server` | Authenticated services, tenant registry/provisioning, platform accounts, and the pattern-based API route registry |
| `src/app/api/[...path]` | Single HTTP entrypoint for authentication, CSRF, validation, and dispatch |
| `src/app` | Platform console, staff, kitchen, customer-display, login, and QR guest screens |
| `src/components` | Shared POS/guest controls and local SVG/chart primitives |
| `tests` | Vitest domain, seed-integrity, and session-security tests |
