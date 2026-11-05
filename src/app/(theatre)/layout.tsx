"use client";

/**
 * Theatre-mode shell for the back-of-house and customer displays.
 *
 * Full-bleed, dark and high-contrast: these screens are read from metres away
 * under kitchen lighting, and the customer display faces the guest. The sidebar
 * is replaced by a single slim rail so nothing competes with the tickets.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { Avatar, Icon, Spinner, type IconName } from "@/components/ui";
import { formatMoneyShort } from "@/domain/money";

interface RailItem {
  href: string;
  icon: IconName;
  label: string;
  permission: string;
}

const RAIL: RailItem[] = [
  { href: "/expo", icon: "expo", label: "Expo", permission: "kds.bump" },
  { href: "/kds/grill", icon: "kitchen", label: "Kitchen", permission: "kds.view" },
  { href: "/prep", icon: "prep", label: "Prep", permission: "kds.prep" },
  { href: "/cfd", icon: "display", label: "Display", permission: "guest.cfd" },
  { href: "/pos", icon: "pos", label: "POS", permission: "pos.open" },
  { href: "/floor", icon: "floor", label: "Floor", permission: "host.seat" },
];

export default function TheatreLayout({ children }: { children: React.ReactNode }) {
  const { state, loading, allowed, signOut } = useStore();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && state && !state.user.id) router.replace("/login");
  }, [loading, state, router]);

  if (loading || !state) {
    return (
      <div className="stage flex min-h-screen items-center justify-center gap-3 text-stage-soft">
        <Spinner />
        <span className="text-sm font-semibold">Loading kitchen display…</span>
      </div>
    );
  }
  if (!state.user.id) return null;

  const items = RAIL.filter((item) => allowed(item.permission as never));

  return (
    <div className="stage flex min-h-screen">
      {/* Slim icon rail — tap targets stay large enough for gloved hands. */}
      <nav className="flex w-[64px] shrink-0 flex-col items-center gap-1 border-r border-stage-rule bg-stage-raised py-3">
        <Link
          href="/pos"
          title="Back to the POS"
          className="mb-2 flex size-10 items-center justify-center rounded-xl bg-brand-500 text-sm font-black text-white"
        >
          TK
        </Link>
        {items.map((item) => {
          const active = pathname === item.href || (item.href.startsWith("/kds/") && pathname.startsWith("/kds/"));
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              className="flex size-12 flex-col items-center justify-center gap-0.5 rounded-xl transition-colors"
              style={{
                background: active ? "var(--color-stage-card)" : "transparent",
                color: active ? "var(--color-stage-ink)" : "var(--color-stage-soft)",
              }}
            >
              <Icon name={item.icon} className="size-5" />
              <span className="text-[9px] font-bold uppercase tracking-wide">{item.label}</span>
            </Link>
          );
        })}

        <div className="mt-auto flex flex-col items-center gap-2">
          <div className="tnum text-center">
            <p className="text-[11px] font-extrabold text-stage-ink">{formatMoneyShort(state.metrics.netSalesToday)}</p>
            <p className="text-[9px] text-stage-soft">today</p>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            title={`Sign out ${state.user.name}`}
            aria-label="Sign out"
            className="rounded-xl p-1 text-stage-soft transition-colors hover:text-late"
          >
            <Avatar name={state.user.name} initials={state.user.initials} color={state.user.color} size={32} />
          </button>
        </div>
      </nav>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
