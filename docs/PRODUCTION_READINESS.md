# Production readiness review

Review date: 2026-11-19. This is a repository/code review and local verification,
not a penetration test or certification of a live deployment.

## Implemented fixes

- Added the missing `/admin/schedule` and `/admin/timeclock` pages. They use the
  existing permission-checked labour APIs. Scheduling supports weekly navigation,
  adding/deleting shifts, publishing, copying the prior week and deciding swaps.
  Time Clock supports live attendance, manager punches, reason-required corrections
  and overtime approval. Empty/error states do not use fabricated records.
- Sessions now enforce expiry on the server (12 hours for staff, 8 for platform),
  reject future/malformed issue timestamps, unknown scopes and extra token segments.
- Staff cannot clock another employee in/out without `admin.timeclock`.
- Expired staff bootstrap state is cleared and the staff shell redirects to login.
- Guest QR tokens and explicit restaurant links take priority over stale convenience
  cookies. Deleted signed tenants do not fall through to another restaurant;
  suspended restaurants cannot open a new events stream or server staff context.
- Guest events no longer include unrelated tenant-wide non-quiz events.
- Hardware checks outside demo mode require exact literal IPs in
  `RMS_HARDWARE_ALLOWED_IPS`. Network discovery is disabled outside demo mode.
- Added nosniff, referrer/privacy headers, API no-store headers and removed the
  framework identification header. Existing preview embedding remains possible.
- Updated vulnerable test dependencies; added `vite-node` explicitly because the
  database CLI scripts must not depend on its incidental installation by Vitest.
  The old unsupported `next lint` command now runs the TypeScript check (this is
  not a full ESLint ruleset).
- Removed tracked obsolete Python bytecode.
- `/setup` now redirects to `/platform`; the previous browser workflow wrote a
  legacy database that was not registered for tenant-aware staff sign-in.
- Docker Compose now forwards the documented platform provisioning, directory
  and approved-device configuration variables.

## Demo data handling

Normal startup no longer automatically installs demo accounts or sample records.
`RMS_ENV=demo` is required explicitly, and production seed/reset commands are
blocked. A disposable reset additionally requires `RMS_ALLOW_RESET=1`.

The example environment uses `RMS_ENV=production` and hides the tenant directory.
Production startup refuses known demo owner identities and `rms-demo` seed markers
in the legacy or registered restaurant databases. It does **not** delete databases:
back up any mixed/live volume before deciding how to migrate legitimate records.

No restaurant databases were tracked in Git. The local registry inspected during
this review contained zero restaurants and zero platform accounts. Development
seed source and automated test fixtures remain available only for explicit demo
use; these are not client business data. No remote deployment database was
accessed or erased.

## Important integration limitations — not ready for live automated use

The following paths previously claimed success without contacting a provider.
They are now disabled or honestly report their state:

| Feature | Current production behaviour | Required before enabling |
| --- | --- | --- |
| Guest wallet/card self-pay | Rejected; guest instructed to pay staff | Real provider initiation, signed callbacks, idempotent reconciliation and amount/currency checks |
| Offline card forwarding | Rejected; new offline card authorizations blocked | Real processor capture/decline handling and reconciliation |
| Email receipts | Stored as `queued`, never falsely `sent` | Delivery worker/provider integration, retries and delivery status updates |
| Automated vendor email/SFTP and retries | Rejected, no fabricated successful delivery | Implement real transports and verify delivery before marking sent |

Entering credentials on the settings page alone does not implement these
integrations. Purchase-order documents can be exported, but an end-to-end
production dispatch/receiving workflow still needs a real transport or an audited
manual-dispatch implementation. Staff checkout records externally collected
payments; it is not itself a card processor. Never treat a receipt row as proof
that a gateway settled funds. Printers, payment terminals, SMS and delivery-provider
connections require separate real-device/provider acceptance testing.

## Verification performed

- `npm test`: **94 tests passed** across 10 files, including the existing
  ten-stage service workflow and new production security/navigation regressions.
- `npm run typecheck`: passed.
- `npm run build`: passed; both missing page routes appear in the standalone build.
- `npm audit`: **0 reported vulnerabilities** at review time, including dev tools.
- `git diff --check`: passed.
- HTTP smoke test against the production standalone server with a fresh isolated
  data directory: health/setup state, owner setup token, blank restaurant
  provisioning, CSRF rejection, manager sign-in/bootstrap, labour API responses,
  both new page responses, clock-in/out, payment-forwarding rejection and
  authentication rejection after sign-out all passed. SQLite inspection confirmed
  one provisioned manager and no menu items, inventory, orders or payments.
- Browser visual/accessibility testing and actual external integrations were not
  exercised. A successful HTTP response is not proof of full browser interaction.

## Client handover checklist

1. Use Node 22.22.3 or a compatible current LTS, a clean persistent data volume,
   `RMS_ENV=production`, and a stable independently generated `RMS_SECRET_KEY`.
2. Set a separate random `RMS_SETUP_TOKEN`; create the platform owner at
   `/platform`, create a **blank** restaurant and hand over its unique manager PIN.
   Remove the setup token and restart. Do not run demo seeding on client volumes.
3. Configure the client's real menu, prices, taxes, service charge, currency,
   timezone, tables, staff and opening inventory. Verify legal receipt/tax rules.
4. Terminate HTTPS, restrict direct backend access and ensure the trusted reverse
   proxy overwrites client-address forwarding headers. In-memory sign-in throttles
   reset on restart; use edge rate limiting for an internet-facing installation.
5. Use one application instance with persistent local SQLite storage. Configure
   backups for the control plane and all tenant databases; perform a restore drill.
6. Complete or explicitly exclude the integrations listed above from the client
   scope. Do not present disabled automated integrations as working features.
7. Perform browser/UAT checks with client roles: order → kitchen → checkout →
   receipt → stock/report reconciliation, shift publishing, attendance corrections,
   permissions, guest QR ordering and store isolation. Test configured hardware.
8. Restrict network/device allowlists and filesystem access, monitor logs and
   errors, and review dependency advisories before the actual release.

**Status:** code fixes and clean-workspace demonstration are verified locally.
Live production sign-off remains conditional on deployment configuration,
provider/device integration, backup recovery and client acceptance testing.
