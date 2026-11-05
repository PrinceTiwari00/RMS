# RMS — Restaurant Management System

RMS is a single-store restaurant operations MVP built with Next.js, React and
SQLite. It combines front-of-house service, kitchen displays, back-office
reporting, and customer self-service in one Node.js application.

All money is stored as integer paisa. Menu prices and modifier prices are
snapshotted onto each order line, and the same domain pricing engine is used by
the POS, guest cart, checkout, and reports.

## Run locally

Requirements: **Node.js 22.5 or newer** (the app uses the built-in `node:sqlite`
driver) and npm.

```bash
npm ci
npm run db:seed
npm run dev
```

Open `http://localhost:3000`. The database is created at `data/rms.db` and is
ignored by Git. Seeding is idempotent; to erase and rebuild the demo restaurant:

```bash
npm run db:reset
```

The seeded manager is **Rajesh Kumar Sah**, with demo PIN **2468**. Other staff
PINs are shown on the PIN pad in demo mode. Never use demo credentials or the
built-in development secret for a real deployment.

## Main workspaces

- `/pos` — tickets, menu modifiers, send/fire, and checkout
- `/floor` and `/host` — live floor plan, waitlist, and reservations
- `/kds/grill`, `/expo`, and `/prep` — station boards, the pass, and prep sheets
- `/admin/*` — menu, inventory, recipes, purchasing, waste, floor-plan editing,
  product mix, executive reporting, and Z-reports
- `/admin/settings` — six-section configuration portal for store identity,
  hours, service periods, taxes, gratuity, service-style presets, hardware,
  RBAC, messaging, vendor EDI, and delivery-provider credentials
- `/cfd` — read-only customer-facing display with a live ticket and payment QR;
  use `/cfd?terminal=term-pos-2` for the second register
- `/t/[token]` — public QR table ordering, live kitchen status, and guest
  checkout. A seeded example is `/t/t01-m1`.

The guest token grants access only to its assigned table's active QR ticket.
The CFD and QR pages use relative API URLs, so they work behind a reverse proxy
without hardcoding a browser-facing backend origin.

### Configuration portal

Settings are validated and saved atomically with an audit entry. Full-service,
quick-service, and bar/nightclub presets change only workflow controls, never
menu or financial history. KDS category routes are snapshotted onto new order
lines, and the offline-payment switch and risk cap are enforced at checkout.
Role-matrix changes take effect on the next authenticated API request.

Printer discovery is a manager-initiated, bounded scan of one explicitly entered
IPv4 `/24` on port 9100. Device checks establish a TCP connection only; they do
not claim ESC/POS compatibility or EMV settlement. Live marketplace ingestion,
SMS/email delivery, SFTP, and certified card processing still require the
relevant provider onboarding and connector runtime.

Integration secrets are masked in API responses and omitted from audit details.
Non-empty deployment variables such as `RMS_TWILIO_AUTH_TOKEN` and
`RMS_SENDGRID_API_KEY` override stored credentials without writing them to
SQLite. Protect `.env`, the SQLite file, and backups, and use HTTPS.

## Single-instance AWS deployment

The repository includes a non-root production Dockerfile, single-container
Compose configuration, Nginx/Certbot configuration, environment template, and
consistent SQLite backup automation. Follow **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**
for the complete EC2, HTTPS, first-run setup, update, and restore procedure.

Use a fresh production database. Production startup runs migrations but never
seeds demo accounts or orders, and requires a stable random `RMS_SECRET_KEY`.
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
integrity, signed sessions, and the mandatory CSRF-header regression. The
production build compiles every App Router page and API route.

## Security and deployment boundary

- Staff authentication uses an HMAC-signed, HTTP-only session cookie.
- Authenticated mutations require the readable CSRF cookie **and** an explicit
  matching `x-csrf-token` header. The server never substitutes the Cookie header
  for that proof.
- Permissions are re-read from the database on every request.
- Set `RMS_ENV=production` and a stable, random `RMS_SECRET_KEY` of at least 32
  characters outside Git. Production cookies are Secure and SameSite=Lax.
- SQLite is instance-local. Use durable storage, tested backups, and a suitable
  database strategy before recording real transactions in a hosted environment.
- Guest card/wallet checkout records a tender; it does **not** integrate with or
  independently verify a payment gateway. Demo mode labels this explicitly.
  Do not treat it as real payment settlement.
- This remains an MVP, not a certified fiscal POS or a multi-tenant/cloud sync
  deployment.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/domain` | Framework-free money, pricing, KDS, table, inventory, labour, and checkout rules |
| `src/db` | SQLite schema, connection, migrations, and demo seed |
| `src/server` | Authenticated services and the pattern-based API route registry |
| `src/app/api/[...path]` | Single HTTP entrypoint for authentication, CSRF, validation, and dispatch |
| `src/app` | Staff, kitchen, customer-display, login, and QR guest screens |
| `src/components` | Shared POS/guest controls and local SVG/chart primitives |
| `tests` | Vitest domain, seed-integrity, and session-security tests |
