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
- `/cfd` — read-only customer-facing display with a live ticket and payment QR;
  use `/cfd?terminal=term-pos-2` for the second register
- `/t/[token]` — public QR table ordering, live kitchen status, and guest
  checkout. A seeded example is `/t/t01-m1`.

The guest token grants access only to its assigned table's active QR ticket.
The CFD and QR pages use relative API URLs, so they work behind a reverse proxy
without hardcoding a browser-facing backend origin.

## Verify

```bash
npm run typecheck
npm test
npm run build
npm run start
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
