# Platform, super admin and restaurant accounts

RMS now has two levels of identity:

| Level | Who | Signs in at | Can do | Cannot do |
| --- | --- | --- | --- | --- |
| **Platform** | Super admin / platform operator | `/platform` (email + password) | Create restaurants, hand over the admin PIN, rename a restaurant, change its plan, suspend/reactivate it, reset the restaurant admin PIN, add other platform operators, read the platform audit log | Read a restaurant's orders, staff, inventory or money; open the POS; sign in with a staff PIN |
| **Restaurant** | Restaurant admin (`manager` role) and staff | `/login` (restaurant code + PIN) | Everything inside their own store: menu, floor, staff and permissions, inventory, purchasing, labour, reports, settings | See another restaurant, or reach the platform console |

The restaurant admin is not a new role: provisioning creates a `manager`
employee, and the seeded role matrix already grants every restaurant-level
permission (`admin.*`, `reports.*`, `pos.*`, `host.*`, `kds.*`, `guest.cfd`). That
keeps the existing permission model as the single source of truth.

## Why one database per restaurant

The alternative — a `tenant_id` column on all ~40 tables — would mean touching
every query, every foreign key and every report, with a permanent risk that one
`WHERE` clause gets forgotten and leaks another restaurant's data.

Instead:

```
data/
├── control.db                     platform accounts + restaurant registry
└── tenants/
    ├── terai-kitchen/
    │   └── rms.db                 that restaurant's whole world
    └── himalayan-grill/
        └── rms.db
```

Isolation is enforced by the filesystem: a query physically cannot return another
restaurant's rows. The existing service layer is unchanged — `all/get/run` simply
resolve to the restaurant named by the request's async context.

```
request
  → /api/[...path]
      → resolve tenant (signed session tid → tenant cookie → ?tenant= → QR token → single store)
      → withTenant(tenant)  ── AsyncLocalStorage
          → staff session, CSRF, permissions
              → service code (all/get/run)  → data/tenants/<code>/rms.db
```

## How a restaurant is created

1. The platform owner opens `/platform` and fills in the restaurant form.
2. `createTenant()` validates the code, name and PIN, writes the registry row in
   `control.db`, then, inside the new database:
   - runs the full schema migration,
   - seeds the role matrix (8 roles) and KDS station list,
   - writes store identity (`restaurant_name`, tagline, time zone, currency, PIN length),
   - creates a `manager` employee with the scrypt-hashed admin PIN.
3. The console shows the **restaurant code**, the **sign-in link** and the
   **PIN once**. The PIN is never returned again; use *Reset admin PIN* for a new one.
4. The owner signs in at `/login`, picks the restaurant code, and manages their store.
   Subsequent sessions carry the tenant id inside the HMAC-signed cookie, so no
   client header can point a session at a different restaurant.

Provisioning is all-or-nothing: a failure deletes the registry row and the partial
database directory.

## API surface

Platform routes live under `/api/platform/*` and are authorized **only** by the
`rms_platform` cookie plus the `x-platform-csrf-token` header:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `platform/status` | setup state, demo credentials in demo mode |
| POST | `platform/setup` | create the first platform account (token-gated) |
| POST | `platform/signin`, `platform/signout`, GET `platform/session` | operator session |
| GET / POST | `platform/tenants` | list / provision restaurants |
| GET / PATCH | `platform/tenants/:id` | inspect / rename, re-plan, suspend, reactivate |
| POST | `platform/tenants/:id/reset-admin` | set a new restaurant admin PIN |
| GET / POST / PATCH | `platform/accounts[/:id]` | other operators |
| GET | `platform/audit` | platform audit trail |

Staff routes are unchanged (`/api/session/signin`, `/api/bootstrap`, …). Sign-in now
accepts a `restaurant` code in the body; public guests resolve their restaurant from
the QR token.

## Tenant resolution for the public pages

| Surface | How the restaurant is found |
| --- | --- |
| Staff session | `tid` claim in the signed cookie (authoritative) |
| `/login` | restaurant picker → `session/signin` body |
| `/t/<token>` and `/api/guest/*` | the QR token is looked up across active restaurants |
| `/cfd?tenant=<code>` | query parameter, then the `rms_tenant` cookie it sets |
| Guest/CFD with no hint and one active restaurant | that restaurant |

`RMS_TENANT_DIRECTORY=0` hides the restaurant list on the PIN pad (codes must be
typed) for deployments that don't want to publish store names.

## Security boundaries

- Platform and staff sessions are different cookies, different CSRF tokens and
  different token scopes; a platform token is rejected as a staff session and
  vice-versa.
- The platform console sees only registry metadata and aggregate counts. It opens a
  restaurant database solely to reset the admin PIN (and writes an audit row in the
  control plane when it does).
- Suspending a restaurant blocks sign-in and every authenticated API call for that
  tenant, including already-issued cookies; the data is untouched.
- A restaurant manager cannot escalate to platform: there is no permission string,
  no route and no UI that reaches `/api/platform/*`.
- Platform passwords are scrypt-hashed; restaurant PINs are unchanged (scrypt,
  demo-only plaintext hints).
- Audit trails are split: each restaurant keeps its own `audit_log`; the control
  plane keeps `platform_audit` and `tenant_admin_resets`.

## Environment

| Variable | Purpose |
| --- | --- |
| `RMS_DATA_DIR` | root for `control.db` and `tenants/` |
| `RMS_CONTROL_DB_PATH` | optional override for the registry database |
| `RMS_SETUP_TOKEN` | one-time token for `/platform` or `/setup` first run |
| `RMS_PLATFORM_EMAIL`, `RMS_PLATFORM_PASSWORD`, `RMS_PLATFORM_NAME` | create the first platform account at boot |
| `RMS_TENANT_DIRECTORY` | `0` hides restaurant names on the PIN pad |

Demo mode (`RMS_ENV` unset or `demo`) seeds a platform owner
`owner@rms.local` / `rms-super-admin` and the sample restaurant `terai-kitchen`
(PIN `2468`). Production never seeds either.

## Operations

```bash
npm run db:seed    # control plane + demo restaurant, idempotent
npm run db:reset   # erase control.db, tenants/ and the legacy db, rebuild demo
npm run db:backup  # one timestamped directory with every database + manifest

# Provision without opening a browser (same service as the console):
npm run tenant:create -- --name "Himalayan Grill" --admin "Sita Gurung" --pin 778899 \
  --plan standard --email sita@example.com
```

- Back up and restore `control.db` **together** with `tenants/` — a registry row
  points at exactly one restaurant database.
- Deleting a restaurant's directory without the registry row leaves a dangling
  account; use the service/`destroyTenant()` deliberately.
- Each restaurant database is still a single-writer SQLite file. One container
  remains the deployment model; move to PostgreSQL before running more than one
  application instance.

## Limits and next steps

- A restaurant's "plan" is a label today; it does not yet gate features or seats.
  Add per-plan permission caps in `permissionsFor()` when billing arrives.
- Provisioning runs inside the request. It is fast for a blank store (a few
  hundred ms) but grows with sample data; move it to a background job if bulk
  onboarding is needed.
- No self-service signup: creating a restaurant is always a platform action.
- No per-restaurant custom domain or subdomain routing yet; the restaurant code is
  the routing key. Subdomain → tenant mapping can be added in
  `resolveRequestTenant()` without touching the rest of the app.
