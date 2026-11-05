/**
 * Analytics service — the executive dashboard, the Product-Mix (menu engineering)
 * matrix and end-of-day Z-report reconciliation.
 *
 * Every figure is derived from the frozen money columns written at close, never
 * from the current menu price, so a price change today cannot rewrite last week's
 * numbers. A closed Z-report is stored as an immutable JSON payload: reopening the
 * same day later must show exactly what the manager signed off.
 */
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest } from "@/server/router";
import { audit } from "@/server/audit";
import { getSettings } from "@/server/settings";
import { tipPayoutByServer, tenderLabel } from "@/server/checkout";
import { laborSummary } from "@/server/labor";
import { getInventoryItems } from "@/server/inventory";
import { productMix, QUADRANT_META, type PmixInput, type Quadrant } from "@/domain/pmix";
import { ratioPercent, roundToRupee } from "@/domain/money";
import { businessDateNow, dateRange, formatClock, formatDay, nowStamp, shiftDate, today } from "@/domain/time";
import { LABOR_TARGET } from "@/domain/labor";
import type { BusinessDay, ExecutiveReport, PmixReport, SalesPoint, SessionUser, ZReport } from "@/types";

/** Nepali currency denominations for drawer reconciliation. */
export const DENOMINATIONS: { label: string; value: number; kind: "note" | "coin" }[] = [
  { label: "Rs 1,000", value: 100000, kind: "note" },
  { label: "Rs 500", value: 50000, kind: "note" },
  { label: "Rs 100", value: 10000, kind: "note" },
  { label: "Rs 50", value: 5000, kind: "note" },
  { label: "Rs 20", value: 2000, kind: "note" },
  { label: "Rs 10", value: 1000, kind: "note" },
  { label: "Rs 5", value: 500, kind: "note" },
  { label: "Rs 2 coin", value: 200, kind: "coin" },
  { label: "Rs 1 coin", value: 100, kind: "coin" },
];

export const CHANNEL_LABELS: Record<string, string> = {
  dine_in: "Dine-in",
  takeout: "Takeout",
  delivery: "Delivery",
  qr: "QR self-order",
};

// ------------------------------------------------------------------ business day
interface DayRow {
  id: string;
  business_date: string;
  opened_at: string;
  closed_at: string | null;
  opening_float: number;
  expected_cash: number;
  counted_cash: number | null;
  variance: number | null;
  status: string;
  notes: string;
  closed_by: string | null;
}

/** Get the day's row, opening one if the till has not been started yet. */
export function ensureBusinessDay(date: string, actor: SessionUser | null = null): DayRow {
  const existing = get<DayRow>("SELECT * FROM business_days WHERE business_date = ?", date);
  if (existing) return existing;
  const settings = getSettings();
  const id = uuid();
  run(
    "INSERT INTO business_days (id, business_date, opened_at, opening_float, status) VALUES (?, ?, ?, ?, 'open')",
    id,
    date,
    nowStamp(),
    settings.cashFloat,
  );
  audit(actor, "day.open", "business_day", id, `${date} opened with a float of Rs ${(settings.cashFloat / 100).toFixed(2)}`);
  return get<DayRow>("SELECT * FROM business_days WHERE business_date = ?", date)!;
}

export function getBusinessDays(limit = 30): BusinessDay[] {
  return all<DayRow & { live_sales: number; live_checks: number }>(
    `SELECT bd.*,
            (SELECT COALESCE(SUM(o.total), 0) FROM orders o WHERE o.status = 'closed' AND o.business_date = bd.business_date) AS live_sales,
            (SELECT COUNT(*) FROM orders o WHERE o.status = 'closed' AND o.business_date = bd.business_date) AS live_checks
       FROM business_days bd ORDER BY bd.business_date DESC LIMIT ?`,
    limit,
  ).map((row) => ({
    id: row.id,
    businessDate: row.business_date,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openingFloat: row.opening_float,
    status: row.status === "closed" ? "closed" : "open",
    notes: row.notes,
    liveSales: Number(row.live_sales ?? 0),
    liveChecks: Number(row.live_checks ?? 0),
  }));
}

export function getBusinessDay(date: string): BusinessDay | null {
  return getBusinessDays(400).find((day) => day.businessDate === date) ?? null;
}

// ---------------------------------------------------------------- sales queries
interface OrderAgg {
  checks: number;
  guests: number;
  netSales: number;
  grossSales: number;
  vat: number;
  serviceCharge: number;
  tips: number;
  discounts: number;
}

function salesAgg(from: string, to: string): OrderAgg {
  const row = get<{
    checks: number;
    guests: number;
    net_sales: number;
    vat: number;
    service_charge: number;
    tips: number;
    discounts: number;
  }>(
    `SELECT COUNT(*) AS checks,
            COALESCE(SUM(guests), 0) AS guests,
            COALESCE(SUM(total), 0) AS net_sales,
            COALESCE(SUM(vat), 0) AS vat,
            COALESCE(SUM(service_charge), 0) AS service_charge,
            COALESCE(SUM(tip), 0) AS tips,
            COALESCE(SUM(discount), 0) AS discounts
       FROM orders WHERE status = 'closed' AND business_date BETWEEN ? AND ?`,
    from,
    to,
  );
  if (!row) return { checks: 0, guests: 0, netSales: 0, grossSales: 0, vat: 0, serviceCharge: 0, tips: 0, discounts: 0 };
  const netSales = Number(row.net_sales);
  return {
    checks: Number(row.checks),
    guests: Number(row.guests),
    netSales,
    grossSales: netSales + Number(row.discounts),
    vat: Number(row.vat),
    serviceCharge: Number(row.service_charge),
    tips: Number(row.tips),
    discounts: Number(row.discounts),
  };
}

/** Actual consumption cost from the BOM ledger, over a date range. */
function foodCostFor(from: string, to: string): number {
  const row = get<{ cost: number }>(
    `SELECT COALESCE(SUM(ABS(it.delta) * ii.unit_cost * 100), 0) AS cost
       FROM inventory_transactions it JOIN inventory_items ii ON ii.id = it.inventory_item_id
      WHERE it.reason = 'sale' AND date(it.created_at) BETWEEN ? AND ?`,
    from,
    to,
  );
  return Math.round(Number(row?.cost ?? 0));
}

function voidsFor(from: string, to: string): { count: number; amount: number } {
  const row = get<{ count: number; amount: number }>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM voids
      WHERE date(created_at) BETWEEN ? AND ?`,
    from,
    to,
  );
  return { count: Number(row?.count ?? 0), amount: Number(row?.amount ?? 0) };
}

/** Sales attributed to the hour the ticket was closed — for the day-part chart. */
function hourOfDay(from: string, to: string): { hour: number; sales: number; checks: number }[] {
  const rows = all<{ hour: number; sales: number; checks: number }>(
    `SELECT CAST(strftime('%H', closed_at) AS INTEGER) AS hour, SUM(total) AS sales, COUNT(*) AS checks
       FROM orders WHERE status = 'closed' AND business_date BETWEEN ? AND ? AND closed_at IS NOT NULL
      GROUP BY hour ORDER BY hour`,
    from,
    to,
  );
  const buckets = new Map<number, { hour: number; sales: number; checks: number }>();
  for (const row of rows) {
    // Roll the small-hours tail into the previous business day's late service.
    const hour = row.hour < 4 ? row.hour + 24 : row.hour;
    buckets.set(hour, { hour, sales: Number(row.sales), checks: Number(row.checks) });
  }
  return [...buckets.values()].sort((a, b) => a.hour - b.hour);
}

function topItemsFor(from: string, to: string, limit = 8): { id: string; name: string; units: number; revenue: number; margin: number }[] {
  const rows = all<{ menu_item_id: string | null; name: string; units: number; revenue: number; margin: number }>(
    `SELECT oi.menu_item_id, oi.name_snapshot AS name, SUM(oi.quantity) AS units,
            SUM(oi.quantity * (oi.price_at_time +
              (SELECT COALESCE(SUM(m.price_at_time), 0) FROM order_item_modifiers m WHERE m.order_item_id = oi.id))) AS revenue,
            SUM(oi.quantity * COALESCE(mi.cost, 0)) AS margin
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE o.status = 'closed' AND oi.is_void = 0 AND o.business_date BETWEEN ? AND ?
      GROUP BY oi.menu_item_id, oi.name_snapshot ORDER BY revenue DESC LIMIT ?`,
    from,
    to,
    limit,
  );
  return rows.map((row) => ({
    id: row.menu_item_id ?? "",
    name: row.name,
    units: Number(row.units),
    revenue: Number(row.revenue),
    margin: Number(row.revenue) - Number(row.margin),
  }));
}

// --------------------------------------------------------------- executive view
export function executiveReport(from?: string, to?: string): ExecutiveReport {
  const end = to ?? today();
  const start = from ?? shiftDate(end, -6);
  const dates = dateRange(start, end);
  const settings = getSettings();
  const band = { min: settings.laborTargetMin, max: settings.laborTargetMax };

  const current = salesAgg(start, end);
  const days = Math.max(1, dates.length);
  const voids = voidsFor(start, end);
  const foodCost = foodCostFor(start, end);
  const labor = laborSummary(start, end, band);

  const previousEnd = shiftDate(start, -1);
  const previousStart = shiftDate(previousEnd, -(days - 1));
  const previous = salesAgg(previousStart, previousEnd);
  const previousLabor = laborSummary(previousStart, previousEnd, band);
  const previousFood = foodCostFor(previousStart, previousEnd);

  const series: SalesPoint[] = dates.map((date) => {
    const day = salesAgg(date, date);
    const dayLabor = laborSummary(date, date, band);
    const dayFood = foodCostFor(date, date);
    return {
      date,
      label: formatDay(date).slice(0, 6),
      netSales: day.netSales,
      checks: day.checks,
      guests: day.guests,
      laborCost: dayLabor.burdenedCost,
      laborPercent: dayLabor.laborPercent,
      foodCost: dayFood,
      foodCostPercent: ratioPercent(dayFood, day.netSales),
    };
  });

  const channels = all<{ channel: string; sales: number; checks: number }>(
    `SELECT channel, COALESCE(SUM(total), 0) AS sales, COUNT(*) AS checks FROM orders
      WHERE status = 'closed' AND business_date BETWEEN ? AND ? GROUP BY channel ORDER BY sales DESC`,
    start,
    end,
  );
  const tenders = all<{ method: string; amount: number; count: number }>(
    `SELECT p.method, COALESCE(SUM(p.amount), 0) AS amount, COUNT(*) AS count
       FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE o.status = 'closed' AND o.business_date BETWEEN ? AND ? GROUP BY p.method ORDER BY amount DESC`,
    start,
    end,
  );
  const laborByRole = all<{ role_title: string | null; hours: number; cost: number }>(
    `SELECT r.title AS role_title,
            COALESCE(SUM(COALESCE(t.regular_hours, 0) + COALESCE(t.overtime_hours, 0)), 0) AS hours,
            COALESCE(SUM((t.regular_hours * t.hourly_rate) + (t.overtime_hours * t.hourly_rate * 1.5)) / 100.0, 0) AS cost
       FROM time_entries t JOIN employees e ON e.id = t.employee_id LEFT JOIN roles r ON r.id = e.role_id
      WHERE COALESCE(t.business_date, date(t.clock_in)) BETWEEN ? AND ?
      GROUP BY r.title ORDER BY cost DESC`,
    start,
    end,
  );

  const netSales = current.netSales || 1;
  const primeCost = foodCost + labor.burdenedCost;
  return {
    range: { from: start, to: end, label: `${formatDay(start)} – ${formatDay(end)}`, days },
    kpis: {
      netSales: current.netSales,
      grossSales: current.grossSales,
      checks: current.checks,
      guests: current.guests,
      averageCheck: current.checks ? Math.round(current.netSales / current.checks) : 0,
      coversPerDay: Math.round((current.guests / days) * 10) / 10,
      vat: current.vat,
      serviceCharge: current.serviceCharge,
      tips: current.tips,
      discounts: current.discounts,
      voids: voids.count,
      voidAmount: voids.amount,
      laborCost: labor.burdenedCost,
      laborHours: labor.hours,
      laborPercent: labor.laborPercent,
      laborHealth: labor.health,
      foodCost,
      foodCostPercent: ratioPercent(foodCost, current.netSales),
      primeCost,
      primeCostPercent: ratioPercent(primeCost, current.netSales),
      salesPerLaborHour: labor.salesPerLaborHour,
    },
    previous: {
      netSales: previous.netSales,
      checks: previous.checks,
      averageCheck: previous.checks ? Math.round(previous.netSales / previous.checks) : 0,
      laborPercent: previousLabor.laborPercent,
      foodCostPercent: ratioPercent(previousFood, previous.netSales || 1),
    },
    series,
    hourOfDay: hourOfDay(start, end),
    channelMix: channels.map((row) => ({
      channel: row.channel,
      label: CHANNEL_LABELS[row.channel] ?? row.channel,
      sales: Number(row.sales),
      checks: Number(row.checks),
      percent: ratioPercent(Number(row.sales), netSales),
    })),
    tenderMix: tenders.map((row) => ({
      method: row.method,
      label: tenderLabel(row.method),
      amount: Number(row.amount),
      count: Number(row.count),
      percent: ratioPercent(Number(row.amount), netSales),
    })),
    topItems: topItemsFor(start, end),
    laborByRole: laborByRole.map((row) => ({
      role: row.role_title ?? "—",
      hours: Math.round(Number(row.hours) * 100) / 100,
      cost: Math.round(Number(row.cost)),
    })),
  };
}

// --------------------------------------------------------------------- P-Mix
export function pmixReport(from?: string, to?: string): PmixReport {
  const end = to ?? today();
  const start = from ?? shiftDate(end, -13);
  const rows = all<{ id: string; name: string; emoji: string; category: string; price: number; cost: number; units: number; revenue: number; cogs: number }>(
    `SELECT mi.id, mi.name, mi.emoji, c.name AS category, mi.price, mi.cost,
            COALESCE(SUM(oi.quantity), 0) AS units,
            COALESCE(SUM(oi.quantity * (oi.price_at_time +
              (SELECT COALESCE(SUM(m.price_at_time), 0) FROM order_item_modifiers m WHERE m.order_item_id = oi.id))), 0) AS revenue,
            COALESCE(SUM(oi.quantity * mi.cost), 0) AS cogs
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       LEFT JOIN categories c ON c.id = mi.category_id
      WHERE o.status = 'closed' AND oi.is_void = 0 AND o.business_date BETWEEN ? AND ?
      GROUP BY mi.id ORDER BY revenue DESC`,
    start,
    end,
  );

  const inputs: PmixInput[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    unitsSold: Number(row.units),
    revenue: Number(row.revenue),
    cost: Number(row.cogs),
    price: row.price,
  }));
  const result = productMix(inputs);
  const emojiByid = new Map(rows.map((row) => [row.id, row.emoji]));

  const toView = (row: (typeof result.rows)[number]) => ({
    id: row.id,
    name: row.name,
    emoji: emojiByid.get(row.id) ?? "🍽",
    category: row.category ?? "—",
    unitsSold: row.unitsSold,
    revenue: row.revenue,
    cost: row.cost,
    price: row.price,
    contributionMargin: row.contributionMargin,
    marginPercent: row.marginPercent,
    menuMixPercent: row.menuMixPercent,
    foodCostPercent: row.foodCostPercent,
    popular: row.popular,
    profitable: row.profitable,
    quadrant: row.quadrant,
  });

  const quadrants = {} as Record<Quadrant, { count: number; rows: ReturnType<typeof toView>[] }>;
  for (const quadrant of Object.keys(QUADRANT_META) as Quadrant[]) {
    quadrants[quadrant] = { count: result.quadrants[quadrant].count, rows: result.quadrants[quadrant].rows.map(toView) };
  }

  return {
    range: { from: start, to: end, label: `${formatDay(start)} – ${formatDay(end)}` },
    rows: result.rows.map(toView),
    totals: result.totals,
    thresholds: result.thresholds,
    quadrants,
  };
}

// -------------------------------------------------------------------- Z-report
/** Build (but do not persist) the Z-report for a business date. */
export function buildZReport(date: string): ZReport {
  const day = ensureBusinessDay(date);
  const frozen = get<{ payload: string }>(
    "SELECT payload FROM z_reports WHERE business_date = ? ORDER BY generated_at DESC LIMIT 1",
    date,
  );
  if (frozen) {
    return { ...JSON.parse(frozen.payload) as ZReport, status: "closed" };
  }

  const settings = getSettings();
  const sales = salesAgg(date, date);
  const voids = voidsFor(date, date);
  const labor = laborSummary(date, date, { min: settings.laborTargetMin, max: settings.laborTargetMax });
  const foodCost = foodCostFor(date, date);

  const tenders = all<{ method: string; amount: number; tips: number; count: number }>(
    `SELECT p.method, COALESCE(SUM(p.amount), 0) AS amount, COALESCE(SUM(p.tip), 0) AS tips, COUNT(*) AS count
       FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE o.status = 'closed' AND o.business_date = ? GROUP BY p.method ORDER BY amount DESC`,
    date,
  );
  const cashTendered = tenders.filter((row) => row.method === "cash").reduce((total, row) => total + Number(row.amount), 0);
  const cashTips = tenders.filter((row) => row.method === "cash").reduce((total, row) => total + Number(row.tips), 0);
  const expectedCash = day.opening_float + cashTendered;

  const discounts = all<{ reason: string; amount: number; count: number }>(
    `SELECT COALESCE(NULLIF(reason, ''), 'Unspecified') AS reason, SUM(amount) AS amount, COUNT(*) AS count
       FROM order_discounts d JOIN orders o ON o.id = d.order_id
      WHERE o.business_date = ? GROUP BY reason ORDER BY amount DESC`,
    date,
  );
  const voidDetail = all<{ reason: string; amount: number; count: number }>(
    `SELECT COALESCE(NULLIF(reason, ''), 'Unspecified') AS reason, SUM(amount) AS amount, COUNT(*) AS count
       FROM voids WHERE date(created_at) = ? GROUP BY reason ORDER BY amount DESC`,
    date,
  );
  const byServer = all<{ id: string; name: string; checks: number; sales: number; tips: number }>(
    `SELECT COALESCE(e.id, '') AS id, COALESCE(e.name, 'Unassigned') AS name, COUNT(o.id) AS checks,
            COALESCE(SUM(o.total), 0) AS sales, COALESCE(SUM(o.tip), 0) AS tips
       FROM orders o LEFT JOIN employees e ON e.id = o.server_id
      WHERE o.status = 'closed' AND o.business_date = ? GROUP BY o.server_id ORDER BY sales DESC`,
    date,
  );
  const cashCounts = all<{ denomination: string; expected_count: number; counted_count: number }>(
    "SELECT denomination, expected_count, counted_count FROM cash_counts WHERE business_day_id = ? ORDER BY rowid",
    day.id,
  );

  const counts = DENOMINATIONS.map((denomination) => {
    const row = cashCounts.find((entry) => entry.denomination === denomination.label);
    return {
      denomination: denomination.label,
      expectedCount: row?.expected_count ?? 0,
      countedCount: row?.counted_count ?? 0,
      value: (row?.counted_count ?? 0) * denomination.value,
    };
  });

  return {
    businessDate: date,
    businessDayId: day.id,
    status: day.status === "closed" ? "closed" : "open",
    generatedAt: null,
    openedAt: day.opened_at,
    closedAt: day.closed_at,
    closedBy: day.closed_by,
    checks: sales.checks,
    guests: sales.guests,
    averageCheck: sales.checks ? Math.round(sales.netSales / sales.checks) : 0,
    grossSales: sales.grossSales,
    netSales: sales.netSales,
    vat: sales.vat,
    serviceCharge: sales.serviceCharge,
    discounts: sales.discounts,
    voids: voids.count,
    voidAmount: voids.amount,
    tips: sales.tips,
    laborCost: labor.burdenedCost,
    laborHours: labor.hours,
    laborPercent: labor.laborPercent,
    foodCost,
    foodCostPercent: ratioPercent(foodCost, sales.netSales || 1),
    tenders: tenders.map((row) => ({
      method: row.method,
      label: tenderLabel(row.method),
      amount: Number(row.amount),
      tips: Number(row.tips),
      count: Number(row.count),
    })),
    cash: {
      openingFloat: day.opening_float,
      expectedCash,
      countedCash: day.counted_cash,
      variance: day.variance,
      notes: day.notes,
      counts,
    },
    discountDetail: discounts.map((row) => ({ reason: row.reason, amount: Number(row.amount), count: Number(row.count) })),
    voidDetail: voidDetail.map((row) => ({ reason: row.reason, amount: Number(row.amount), count: Number(row.count) })),
    tipPayout: tipPayoutByServer(date),
    byServer: byServer.map((row) => ({
      id: row.id,
      name: row.name,
      checks: Number(row.checks),
      sales: Number(row.sales),
      averageCheck: Number(row.checks) ? Math.round(Number(row.sales) / Number(row.checks)) : 0,
      tips: Number(row.tips),
    })),
    byHour: hourOfDay(date, date),
    topItems: topItemsFor(date, date, 10),
  };
}

export function getZReport(date?: string): ZReport {
  return buildZReport(date ?? businessDateNow());
}

export interface CountInput {
  denomination: string;
  counted: number;
}

/** Close the day: freeze the Z-report, post the drawer count, stamp the day. */
export function closeBusinessDay(
  date: string,
  input: { counts?: CountInput[]; notes?: string },
  actor: SessionUser | null,
): ZReport {
  const openTickets = Number(
    get<{ n: number }>("SELECT COUNT(*) AS n FROM orders WHERE status IN ('open','sent') AND business_date = ?", date)?.n ?? 0,
  );
  if (openTickets) throw badRequest(`${openTickets} ticket(s) are still open for ${date} — close them before the Z-report`);

  const day = ensureBusinessDay(date, actor);
  if (day.status === "closed") throw badRequest(`${date} has already been closed`);

  const report = buildZReport(date);
  const counted = (input.counts ?? []).reduce((total, entry) => {
    const denomination = DENOMINATIONS.find((candidate) => candidate.label === entry.denomination);
    if (!denomination) throw badRequest(`Unknown denomination ${entry.denomination}`);
    const notes = Math.max(0, Math.round(Number(entry.counted)));
    if (!Number.isFinite(notes)) throw badRequest("Note count must be a number");
    return total + notes * denomination.value;
  }, day.opening_float);

  const stamp = nowStamp();
  tx(() => {
    run("DELETE FROM cash_counts WHERE business_day_id = ?", day.id);
    for (const entry of input.counts ?? []) {
      const denomination = DENOMINATIONS.find((candidate) => candidate.label === entry.denomination);
      if (!denomination) continue;
      run(
        `INSERT INTO cash_counts (id, business_day_id, denomination, expected_count, counted_count, counted_by, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?)`,
        uuid(),
        day.id,
        denomination.label,
        Math.max(0, Math.round(Number(entry.counted))),
        actor?.name ?? "system",
        stamp,
      );
    }
    run(
      `UPDATE business_days SET status = 'closed', closed_at = ?, closed_by = ?, expected_cash = ?, counted_cash = ?,
         variance = ?, notes = ? WHERE id = ?`,
      stamp,
      actor?.name ?? "system",
      report.cash.expectedCash,
      counted,
      counted - report.cash.expectedCash,
      String(input.notes ?? "").slice(0, 280),
      day.id,
    );
    run(
      "INSERT INTO z_reports (id, business_day_id, business_date, generated_at, payload) VALUES (?, ?, ?, ?, ?)",
      uuid(),
      day.id,
      date,
      stamp,
      JSON.stringify({ ...report, status: "closed", generatedAt: stamp, closedAt: stamp, closedBy: actor?.name ?? "system", cash: { ...report.cash, countedCash: counted, variance: counted - report.cash.expectedCash, notes: String(input.notes ?? "") } }),
    );
  });
  audit(actor, "day.close", "business_day", day.id, `${date}: Rs ${(report.netSales / 100).toFixed(2)} net, ${report.checks} checks`);
  return {
    ...buildZReport(date),
    status: "closed",
    generatedAt: stamp,
    closedAt: stamp,
    closedBy: actor?.name ?? "system",
    cash: { ...report.cash, countedCash: counted, variance: counted - report.cash.expectedCash },
  };
}

/** Reopen a closed day (manager only) — clears the frozen payload. */
export function reopenBusinessDay(date: string, actor: SessionUser | null): void {
  const day = ensureBusinessDay(date, actor);
  if (day.status !== "closed") throw badRequest(`${date} is not closed`);
  tx(() => {
    run("DELETE FROM z_reports WHERE business_day_id = ?", day.id);
    run("UPDATE business_days SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ?", day.id);
  });
  audit(actor, "day.reopen", "business_day", day.id, date);
}

/** Expected cash by denomination, for pre-filling the count sheet. */
export function expectedDrawer(date?: string) {
  const report = buildZReport(date ?? businessDateNow());
  let remaining = report.cash.expectedCash;
  return DENOMINATIONS.map((denomination) => {
    const notes = Math.floor(remaining / denomination.value);
    remaining -= notes * denomination.value;
    return { denomination: denomination.label, value: denomination.value, expectedCount: notes, kind: denomination.kind };
  });
}

/** Quick range presets for the analytics screens. */
export function rangePresets(): { id: string; label: string; from: string; to: string }[] {
  const now = today();
  return [
    { id: "today", label: "Today", from: now, to: now },
    { id: "7d", label: "Last 7 days", from: shiftDate(now, -6), to: now },
    { id: "14d", label: "Last 14 days", from: shiftDate(now, -13), to: now },
    { id: "30d", label: "Last 30 days", from: shiftDate(now, -29), to: now },
    { id: "week", label: "This week", from: shiftDate(now, -((new Date().getDay() + 6) % 7)), to: now },
  ];
}

export { LABOR_TARGET, formatClock, roundToRupee };
