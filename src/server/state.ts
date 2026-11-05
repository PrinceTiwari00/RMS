/**
 * Bootstrap state — the single payload the client fetches on load.
 *
 * Everything the shell needs to render without a waterfall of requests: the
 * signed-in user, their permissions, the menu, the live floor, open tickets and
 * the headline metrics. The screens then poll their own narrow endpoints.
 */
import { get } from "@/db/client";
import { getSettings, getStations } from "@/server/settings";
import { getCategories, getMenu } from "@/server/menu";
import { getSections, getTables, floorStats } from "@/server/floor";
import { getActiveOrders } from "@/server/orders";
import { metrics as kdsMetrics } from "@/server/kitchen";
import { inventoryMetrics } from "@/server/inventory";
import { hostSummary } from "@/server/hosting";
import { laborSummary } from "@/server/labor";
import { purchasingSummary } from "@/server/purchasing";
import { getBusinessDay } from "@/server/reports";
import { getStaff } from "@/server/staff";
import { isDemoMode } from "@/lib/session";
import { currentTenantScope } from "@/db/client";
import { getTenantById } from "@/server/tenant";
import { businessDateNow, nowStamp, today } from "@/domain/time";
import type { BootstrapState, Metrics, SessionUser, TenantIdentity } from "@/types";

/** Headline numbers for the dashboard strip. Cheap enough to poll every few seconds. */
export function buildMetrics(): Metrics {
  const date = businessDateNow();
  const sales = get<{
    net_sales: number;
    gross_sales: number;
    checks: number;
    guests: number;
  }>(
    `SELECT COALESCE(SUM(total), 0) AS net_sales,
            COALESCE(SUM(total) + SUM(discount), 0) AS gross_sales,
            COUNT(*) AS checks,
            COALESCE(SUM(guests), 0) AS guests
       FROM orders WHERE status = 'closed' AND business_date = ?`,
    date,
  ) ?? { net_sales: 0, gross_sales: 0, checks: 0, guests: 0 };

  const openTickets = get<{ open: number; sent: number }>(
    `SELECT COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open,
            COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent
       FROM orders WHERE status IN ('open','sent')`,
  ) ?? { open: 0, sent: 0 };

  const floor = floorStats();
  const stock = inventoryMetrics();
  const kds = kdsMetrics();
  const host = hostSummary();
  const settings = getSettings();
  const labor = laborSummary(date, date, { min: settings.laborTargetMin, max: settings.laborTargetMax });

  const waste = Number(
    get<{ total: number }>(
      "SELECT COALESCE(SUM(quantity * ii.unit_cost * 100), 0) AS total FROM waste_log w JOIN inventory_items ii ON ii.id = w.inventory_item_id WHERE date(w.created_at) = ?",
      today(),
    )?.total ?? 0,
  );
  const purchasing = purchasingSummary();

  return {
    salesToday: Math.round(Number(sales.gross_sales)),
    netSalesToday: Math.round(Number(sales.net_sales)),
    checksToday: Number(sales.checks),
    guestsToday: Number(sales.guests),
    averageCheck: Number(sales.checks) ? Math.round(Number(sales.net_sales) / Number(sales.checks)) : 0,
    openOrders: Number(openTickets.open),
    sentOrders: Number(openTickets.sent),
    occupiedTables: floor.occupied,
    totalTables: floor.total,
    dirtyTables: floor.dirty,
    occupancy: floor.total ? Math.round((floor.occupied / floor.total) * 100) : 0,
    lowStock: stock.lowStock,
    outOfStock: stock.outOfStock,
    pendingKds: kds.byStation.reduce((total, station) => total + station.pending, 0),
    lateKds: kds.lateTickets,
    waitlistCount: host.waiting,
    reservationsToday: host.reservationsToday,
    laborHoursToday: labor.hours,
    laborCostToday: labor.burdenedCost,
    laborPercentToday: labor.laborPercent,
    staffClockedIn: labor.clockedInNow,
    openPoCount: purchasing.draft + purchasing.approved + purchasing.sent,
    wasteToday: Math.round(waste),
  };
}

export function currentTenantIdentity(): TenantIdentity | null {
  const scope = currentTenantScope();
  if (!scope) return null;
  const tenant = getTenantById(scope.tenantId);
  if (!tenant) return null;
  return { id: tenant.id, code: tenant.code, name: tenant.name, tagline: tenant.tagline };
}

export function buildBootstrap(user: SessionUser | null, csrfToken: string | null): BootstrapState {
  const settings = getSettings();
  return {
    user: user ?? { id: "", name: "Signed out", initials: "—", color: "#8a94a0", role: "guest", roleTitle: "Signed out", permissions: [] },
    demoMode: isDemoMode(),
    csrfToken,
    tenant: currentTenantIdentity(),
    restaurant: {
      name: settings.restaurantName,
      tagline: settings.tagline,
      address: settings.address,
      phone: settings.phone,
      panVat: settings.panVat,
    },
    settings,
    stations: getStations(),
    categories: getCategories(),
    menu: getMenu({ includeUnavailable: true }),
    sections: getSections(),
    tables: getTables(),
    orders: getActiveOrders(),
    staff: getStaff(),
    businessDay: getBusinessDay(businessDateNow()),
    metrics: buildMetrics(),
    now: nowStamp(),
  };
}
