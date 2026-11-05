import { redirect } from "next/navigation";
import { ensureDatabase } from "@/db/boot";
import { currentEmployeeId } from "@/lib/session";
import { loadUser } from "@/server/identity";
import { can } from "@/domain/permissions";

export const dynamic = "force-dynamic";

/**
 * Landing route.
 *
 * There is no generic "home" screen: each role has its own natural starting
 * point, so an authenticated employee is sent to the first screen their
 * permissions actually allow. That keeps a cook out of the POS and a server out
 * of the kitchen board without anybody having to configure a homepage.
 */
export default async function IndexPage() {
  ensureDatabase();
  const employeeId = await currentEmployeeId();
  const user = employeeId ? loadUser(employeeId) : null;
  if (!user) redirect("/login");

  const landing: { href: string; permission: Parameters<typeof can>[1] | null }[] = [
    { href: "/pos", permission: "pos.open" },
    { href: "/floor", permission: "host.seat" },
    { href: "/host", permission: "host.waitlist" },
    { href: "/kds/grill", permission: "kds.view" },
    { href: "/expo", permission: "kds.bump" },
    { href: "/prep", permission: "kds.prep" },
    { href: "/admin/menu", permission: "admin.menu" },
    { href: "/admin/inventory", permission: "admin.inventory" },
    { href: "/admin/schedule", permission: "admin.schedule" },
    { href: "/admin/executive", permission: "reports.executive" },
    { href: "/admin/settings", permission: "admin.settings" },
    { href: "/cfd", permission: "guest.cfd" },
  ];

  const target = landing.find((entry) => !entry.permission || can(user.permissions, entry.permission));
  redirect(target ? target.href : "/login");
}
