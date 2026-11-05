import { AppShell } from "@/components/AppShell";

/**
 * Staff shell for the front-of-house and back-office screens.
 *
 * The route group keeps these URLs clean (`/pos`, `/admin/menu`) while giving
 * them a common chrome. Back-of-house screens deliberately live in a separate
 * group: a kitchen display must be full-bleed and high-contrast, with no sidebar
 * competing for attention in a bright, wet room.
 */
export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
