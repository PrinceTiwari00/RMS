"use client";

/**
 * The staff application shell: a role-gated sidebar, a live metrics strip and
 * the page content.
 *
 * Navigation entries are filtered by the signed-in employee's effective
 * permissions, so a cook never sees the executive dashboard and a server never
 * sees the floor-plan builder. Back-of-house routes opt out of the shell
 * entirely and render full-bleed in "theatre mode".
 */
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import { Avatar, Chip, Icon, Spinner, toast, type IconName, type Tone } from "@/components/ui";
import { formatMoneyShort } from "@/domain/money";
import { today } from "@/domain/time";
import type { Permission } from "@/domain/permissions";

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  permission: Permission | null;
  /** Extra badge count pulled from the live metrics. */
  badge?: (metrics: NonNullable<ReturnType<typeof useStore>["state"]>["metrics"]) => number | string | null;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: "Front of house",
    items: [
      { href: "/pos", label: "POS Terminal", icon: "pos", permission: "pos.open" },
      {
        href: "/floor",
        label: "Floor Plan",
        icon: "floor",
        permission: "host.seat",
        badge: (metrics) => metrics.dirtyTables || null,
      },
      {
        href: "/host",
        label: "Host Stand",
        icon: "host",
        permission: "host.waitlist",
        badge: (metrics) => metrics.waitlistCount || null,
      },
    ],
  },
  {
    label: "Back of house",
    items: [
      {
        href: "/kds/grill",
        label: "Kitchen Display",
        icon: "kitchen",
        permission: "kds.view",
        badge: (metrics) => metrics.pendingKds || null,
      },
      { href: "/expo", label: "Expo Board", icon: "expo", permission: "kds.bump" },
      { href: "/prep", label: "Prep Sheets", icon: "prep", permission: "kds.prep" },
    ],
  },
  {
    label: "Configuration",
    items: [
      { href: "/admin/menu", label: "Menu & Modifiers", icon: "menu", permission: "admin.menu" },
      { href: "/admin/floorplan", label: "Floor Plan Builder", icon: "floor", permission: "admin.floorplan" },
      { href: "/admin/users", label: "Users & Permissions", icon: "users", permission: "admin.users" },
      { href: "/admin/qrcodes", label: "QR Codes", icon: "qr", permission: "admin.settings" },
      { href: "/admin/settings", label: "Settings", icon: "settings", permission: "admin.settings" },
    ],
  },
  {
    label: "Inventory & supply",
    items: [
      {
        href: "/admin/inventory",
        label: "Inventory",
        icon: "inventory",
        permission: "admin.inventory",
        badge: (metrics) => metrics.lowStock || null,
      },
      { href: "/admin/recipes", label: "Recipe Costing", icon: "recipe", permission: "admin.recipes" },
      { href: "/admin/vendors", label: "Vendors & Orders", icon: "vendor", permission: "admin.purchasing" },
      { href: "/admin/waste", label: "Waste & Counts", icon: "waste", permission: "admin.waste" },
    ],
  },
  {
    label: "Labour",
    items: [
      { href: "/admin/schedule", label: "Shift Scheduler", icon: "schedule", permission: "admin.schedule" },
      { href: "/admin/timeclock", label: "Time Clock", icon: "clock", permission: "admin.timeclock" },
    ],
  },
  {
    label: "Analytics",
    items: [
      { href: "/admin/executive", label: "Executive Dashboard", icon: "chart", permission: "reports.executive" },
      { href: "/admin/pmix", label: "Product Mix", icon: "matrix", permission: "reports.pmix" },
      { href: "/admin/zreport", label: "Z-Report", icon: "report", permission: "reports.zreport" },
    ],
  },
  {
    label: "Displays",
    items: [{ href: "/cfd", label: "Customer Display", icon: "display", permission: "guest.cfd" }],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { state, loading, allowed, signOut, refresh } = useStore();
  const pathname = usePathname();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);

  // Bounce to the PIN pad if the session died underneath us.
  useEffect(() => {
    if (!loading && state && !state.user.id) router.replace("/login");
  }, [loading, state, router]);

  // Close the mobile drawer on navigation.
  useEffect(() => setNavOpen(false), [pathname]);

  // Shared staff terminals lock after the configured inactivity window. This
  // deliberately lives in the staff shell: kitchen theatre displays and public
  // guest ordering do not inherit the register's lock timer.
  useEffect(() => {
    const seconds = state?.settings.autoLockSeconds ?? 0;
    if (!state?.user.id || seconds <= 0) return;
    let timer: number;
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        toast("Terminal locked after inactivity", "neutral");
        void signOut();
      }, seconds * 1000);
    };
    const events = ["pointerdown", "keydown", "touchstart", "mousemove"] as const;
    for (const event of events) window.addEventListener(event, reset, { passive: true });
    reset();
    return () => {
      window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, reset);
    };
  }, [state?.settings.autoLockSeconds, state?.user.id, signOut]);

  if (loading || !state) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 text-ink-faint">
        <Spinner />
        <span className="text-sm font-semibold">Loading Terai Kitchen…</span>
      </div>
    );
  }

  if (!state.user.id) return null;

  const metrics = state.metrics;
  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.permission || allowed(item.permission)),
  })).filter((group) => group.items.length);

  const station = pathname.startsWith("/kds/") ? pathname.split("/")[2] : null;

  return (
    <div className="flex min-h-screen">
      {/* ---------------------------------------------------------------- sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[248px] shrink-0 flex-col border-r border-rule bg-paper-raised transition-transform lg:static lg:translate-x-0 ${
          navOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2.5 border-b border-rule px-4 py-3.5">
          <span className="flex size-9 items-center justify-center overflow-hidden rounded-xl bg-brand-500 text-base font-black text-white">
            {state.settings.logoDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={state.settings.logoDataUrl} alt="" className="size-full bg-white object-contain" />
            ) : (
              state.restaurant.name.slice(0, 2).toUpperCase()
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold leading-tight text-ink">{state.restaurant.name}</p>
            <p className="truncate text-[11px] text-ink-faint">{state.restaurant.tagline}</p>
          </div>
        </div>

        <nav className="scroll-y flex-1 px-2.5 py-3">
          {groups.map((group) => (
            <div key={group.label} className="mb-4">
              <p className="mb-1 px-2 text-[10px] font-bold uppercase tracking-[0.09em] text-ink-faint">{group.label}</p>
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const active =
                    pathname === item.href ||
                    (item.href.startsWith("/kds/") && pathname.startsWith("/kds/")) ||
                    (item.href.startsWith("/admin/") && pathname === item.href);
                  const badge = item.badge ? item.badge(metrics) : null;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-semibold transition-colors ${
                          active ? "bg-brand-500 text-white" : "text-ink-soft hover:bg-paper-sunken hover:text-ink"
                        }`}
                      >
                        <Icon name={item.icon} className="size-[18px] shrink-0" />
                        <span className="truncate">{item.label}</span>
                        {badge !== null && badge !== undefined && badge !== 0 && (
                          <span
                            className="tnum ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                            style={{
                              background: active ? "rgba(255,255,255,0.24)" : "var(--color-ember-100)",
                              color: active ? "#fff" : "var(--color-ember-700)",
                            }}
                          >
                            {badge}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          {/* Per-station shortcuts for the kitchen crew. */}
          {allowed("kds.view") && (
            <div className="mb-4">
              <p className="mb-1 px-2 text-[10px] font-bold uppercase tracking-[0.09em] text-ink-faint">Stations</p>
              <ul className="flex flex-col gap-0.5">
                {state.stations.map((entry) => (
                  <li key={entry.id}>
                    <Link
                      href={`/kds/${entry.id}`}
                      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold transition-colors ${
                        station === entry.id ? "bg-stage text-white" : "text-ink-soft hover:bg-paper-sunken hover:text-ink"
                      }`}
                    >
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: entry.color }} />
                      {entry.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </nav>

        <div className="border-t border-rule px-3 py-3">
          <div className="flex items-center gap-2.5">
            <Avatar name={state.user.name} initials={state.user.initials} color={state.user.color} size={34} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-bold text-ink">{state.user.name}</p>
              <p className="truncate text-[11px] text-ink-faint">{state.user.roleTitle}</p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              title="Sign out"
              aria-label="Sign out"
              className="rounded-lg p-1.5 text-ink-faint hover:bg-paper-sunken hover:text-late"
            >
              <Icon name="logout" className="size-[18px]" />
            </button>
          </div>
        </div>
      </aside>

      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-ink/40 lg:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}

      {/* ------------------------------------------------------------------ main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-rule bg-paper-raised/95 px-4 py-2.5 backdrop-blur">
          <button
            type="button"
            aria-label="Open navigation"
            className="rounded-lg p-1.5 text-ink-soft hover:bg-paper-sunken lg:hidden"
            onClick={() => setNavOpen(true)}
          >
            <Icon name="menu" className="size-5" />
          </button>

          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint sm:inline">
              {today()}
            </span>
            <Chip tone={metrics.openOrders + metrics.sentOrders > 0 ? "brand" : "neutral"} dot>
              {metrics.openOrders + metrics.sentOrders} open ticket{metrics.openOrders + metrics.sentOrders === 1 ? "" : "s"}
            </Chip>
            <Chip tone={metrics.dirtyTables > 0 ? "warn" : "neutral"}>
              {metrics.occupiedTables}/{metrics.totalTables} tables
            </Chip>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <LiveBadge tone={metrics.lateKds > 0 ? "late" : "ok"}>
              {metrics.lateKds > 0 ? `${metrics.lateKds} late` : "Kitchen on time"}
            </LiveBadge>
            <div className="hidden text-right sm:block">
              <p className="tnum text-sm font-extrabold leading-none text-ink">{formatMoneyShort(metrics.netSalesToday)}</p>
              <p className="text-[11px] text-ink-faint">
                {metrics.checksToday} checks · avg {formatMoneyShort(metrics.averageCheck)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refresh().then(() => toast("Refreshed", "ok"))}
              title="Refresh now"
              aria-label="Refresh now"
              className="rounded-lg p-1.5 text-ink-faint hover:bg-paper-sunken hover:text-ink"
            >
              <Icon name="refresh" className="size-[18px]" />
            </button>
          </div>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function LiveBadge({ children, tone }: { children: ReactNode; tone: Tone }) {
  return <Chip tone={tone} dot>{children}</Chip>;
}

