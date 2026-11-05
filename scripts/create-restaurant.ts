/**
 * Provision a restaurant from the command line.
 *
 *   npm run tenant:create -- --name "Himalayan Grill" --admin "Sita Gurung" --pin 778899
 *   npm run tenant:create -- --name "South Cafe" --code south-cafe --admin "Bikash" --pin 4321 --plan free
 *
 * The same service the platform console uses, so the validation, isolation and
 * audit behaviour are identical. Run it on the host that owns RMS_DATA_DIR while
 * the application is stopped, or accept that the app must be restarted to drop its
 * cached connection list (it opens the new database lazily on first request).
 */
import { migrateControl } from "@/db/client";
import { createTenant, publicTenant } from "@/server/tenant";
import { platformAudit } from "@/server/platform";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const name = arg("name");
const adminName = arg("admin");
const adminPin = arg("pin");
if (!name || !adminName || !adminPin) {
  console.error(
    [
      "Usage: npm run tenant:create -- --name <restaurant> --admin <owner name> --pin <4 or 6 digits>",
      "       [--code <slug>] [--tagline <text>] [--plan free|standard|pro] [--email <owner email>]",
    ].join("\n"),
  );
  process.exit(1);
}

migrateControl();
const { tenant, adminPin: pin } = createTenant({
  name,
  code: arg("code"),
  tagline: arg("tagline"),
  adminName,
  adminPin,
  plan: arg("plan"),
  contactEmail: arg("email"),
  contactName: adminName,
  notes: "Created from the command line",
});

platformAudit(
  { id: "cli", email: `cli:${process.env.USER ?? "operator"}` },
  "platform.tenant.create",
  tenant,
  `${tenant.name} (${tenant.code}) · CLI`,
);

const view = publicTenant(tenant);
console.log(`[rms] restaurant created: ${view.name} (code ${view.code})`);
console.log(`[rms] administrator: ${view.adminName} · PIN ${pin}`);
console.log(`[rms] sign-in link: /login?restaurant=${encodeURIComponent(view.code)}`);
console.log(`[rms] database: ${tenant.dbFile}`);
