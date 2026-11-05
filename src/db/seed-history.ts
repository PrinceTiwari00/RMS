/**
 * Historical seed — fourteen closed business days.
 *
 * Reports are only believable when they are computed from real rows, so the
 * executive dashboard, P-Mix matrix, labour cost % and every Z-report are
 * generated from seeded closed tickets, tenders, voids, discounts and
 * timesheets rather than from hard-coded summary numbers.
 */
import { all, run, uuid } from "@/db/client";
import type { Random } from "@/lib/rng";
import { atClock, pad, shiftDate, today, weekdayName } from "@/domain/time";
import { percentOf, vatAmount } from "@/domain/money";
import { splitHours, grossPay, totalLaborCost } from "@/domain/labor";

interface HistoryMenuItem {
  id: string;
  name: string;
  price: number;
  cost: number;
  course: string;
  station: string;
  category: string | null;
}

interface HistoryEmployee {
  id: string;
  name: string;
  role: string;
  hourly_rate: number;
}

/** Relative sales frequency — drives the P-Mix popularity axis. */
const POPULARITY: Record<string, number> = {
  "Chicken Momo (Steamed)": 26,
  "Chicken Chowmein": 20,
  "Dal Bhat Tarkari": 22,
  "Thakali Khana Set (Veg)": 16,
  "Masala Chiya": 30,
  "Soft Drink": 18,
  "Crispy Fries": 17,
  "House Burger": 14,
  "Tandoori Chicken (Half)": 9,
  "Butter Chicken": 10,
  "Margherita Pizza": 8,
  "Chicken Tikka Pizza": 6,
  "Nepal Lager": 15,
  "Whisky 60ml": 11,
  "Fresh Lime Soda": 12,
  "Mango Lassi": 9,
  "Veg Chowmein": 11,
  "Egg Fried Rice": 8,
  "Thakali Set (Chicken)": 12,
  "Chicken Momo": 0,
  "Fried Momo": 9,
  "Chilli Chicken": 10,
  "Vegetable Spring Roll": 7,
  "Paneer Pakoda": 8,
  "Chicken Wings": 7,
  "Chicken Tikka": 6,
  "Paneer Tikka": 5,
  "Tandoori Roti": 19,
  "Butter Naan": 14,
  "Mutton Curry": 3,
  "Paneer Butter Masala": 6,
  "Chicken Biryani": 9,
  "Mixed Schezwan Noodles": 5,
  "Chicken Burger": 7,
  "Cheesy Garlic Bread": 6,
  "Gulab Jamun (2 pcs)": 10,
  "Vanilla Ice Cream": 8,
  "Chocolate Brownie": 5,
  Kheer: 4,
  "Cold Coffee": 7,
  "Mineral Water 1L": 16,
  "House Cocktail": 8,
  "Virgin Mocktail": 6,
};

/** Items that commonly sell together, so tickets look like real orders. */
const PAIRINGS: Record<string, string[]> = {
  "Chicken Momo (Steamed)": ["Masala Chiya", "Soft Drink", "Fresh Lime Soda"],
  "House Burger": ["Crispy Fries", "Nepal Lager", "Soft Drink"],
  "Butter Chicken": ["Butter Naan", "Tandoori Roti", "Mango Lassi"],
  "Thakali Khana Set (Veg)": ["Masala Chiya", "Mineral Water 1L"],
  "Chicken Chowmein": ["Chicken Wings", "Soft Drink", "Fresh Lime Soda"],
  "Margherita Pizza": ["Cheesy Garlic Bread", "Nepal Lager"],
  "Tandoori Chicken (Half)": ["Butter Naan", "Whisky 60ml"],
  "Dal Bhat Tarkari": ["Masala Chiya"],
};

const SHIFT_PATTERN: Record<string, { days: number[]; start: string; end: string }> = {
  "Rajesh Kumar Sah": { days: [1, 2, 3, 4, 5], start: "10:00", end: "19:00" },
  "Sunita Devi Yadav": { days: [3, 4, 5, 6, 0], start: "14:00", end: "23:00" },
  "Anil Prasad Gupta": { days: [0, 1, 2, 4, 5, 6], start: "11:00", end: "20:00" },
  "Pooja Kumari Singh": { days: [0, 2, 3, 5, 6], start: "12:00", end: "21:30" },
  "Mohammad Irfan Ansari": { days: [1, 2, 3, 4, 6], start: "16:00", end: "23:30" },
  "Bikash Chaudhary": { days: [0, 1, 3, 4, 5], start: "10:00", end: "18:00" },
  "Sita Ram Mishra": { days: [0, 1, 2, 3, 5, 6], start: "09:00", end: "18:00" },
  "Deepak Thakur": { days: [0, 2, 3, 4, 5, 6], start: "13:00", end: "22:30" },
  "Kiran Patel": { days: [1, 2, 4, 5, 6], start: "15:00", end: "23:00" },
  "Nisha Khatun": { days: [0, 1, 4, 5, 6], start: "16:00", end: "23:30" },
  "Aarati Sharma": { days: [0, 1, 2, 5, 6], start: "11:00", end: "19:00" },
};

const DENOMINATIONS = [
  { label: "Rs 1000 note", value: 100000 },
  { label: "Rs 500 note", value: 50000 },
  { label: "Rs 100 note", value: 10000 },
  { label: "Rs 50 note", value: 5000 },
  { label: "Rs 20 note", value: 2000 },
  { label: "Rs 10 coin", value: 1000 },
  { label: "Rs 5 coin", value: 500 },
  { label: "Rs 2 coin", value: 200 },
  { label: "Rs 1 coin", value: 100 },
];

export function seedHistory(rnd: Random): void {
  const menu = all<HistoryMenuItem>(
    `SELECT mi.id, mi.name, mi.price, mi.cost, mi.course, mi.station, c.id AS category
       FROM menu_items mi LEFT JOIN categories c ON c.id = mi.category_id`,
  ).map((row) => ({ ...row, category: row.category }));
  const byName = new Map(menu.map((item) => [item.name, item]));
  const employees = all<HistoryEmployee>(
    `SELECT e.id, e.name, r.name AS role, COALESCE(r.hourly_rate, 20000) AS hourly_rate
       FROM employees e LEFT JOIN roles r ON r.id = e.role_id`,
  );
  const servers = employees.filter((employee) => ["server", "cashier", "bartender", "manager"].includes(employee.role ?? ""));
  const manager = employees.find((employee) => employee.role === "manager");
  const tables = all<{ id: string; label: string }>("SELECT id, label FROM tables ORDER BY sort_order");
  const weightedMenu = menu
    .filter((item) => (POPULARITY[item.name] ?? 3) > 0)
    .map((item) => [item, POPULARITY[item.name] ?? 3] as [HistoryMenuItem, number]);

  let checkNumber = 700;

  for (let daysAgo = 14; daysAgo >= 1; daysAgo -= 1) {
    const date = shiftDate(today(), -daysAgo);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const isWeekend = weekday === 5 || weekday === 6;
    const covers = rnd.int(isWeekend ? 118 : 74, isWeekend ? 168 : 112);
    const orderCount = Math.round(covers / 2.6);

    const businessDayId = uuid();
    run(
      `INSERT INTO business_days (id, business_date, opened_at, closed_at, opening_float, status)
       VALUES (?, ?, ?, ?, 1500000, 'closed')`,
      businessDayId,
      date,
      atClock(date, "07:00"),
      atClock(shiftDate(date, 1), "01:30"),
    );

    let daySubtotal = 0;
    let dayDiscount = 0;
    let dayVat = 0;
    let dayService = 0;
    let dayTips = 0;
    let dayGuests = 0;
    let dayCost = 0;
    let dayChecks = 0;
    let dayVoids = 0;
    let dayVoidAmount = 0;
    const tenderTotals: Record<string, { count: number; amount: number; tips: number }> = {};
    const itemStats = new Map<string, { units: number; revenue: number; cost: number }>();

    for (let index = 0; index < orderCount; index += 1) {
      checkNumber += 1;
      const orderId = uuid();
      const table = rnd.pick(tables);
      const server = rnd.pick(servers);
      const guests = rnd.weighted<number>([
        [1, 6],
        [2, 34],
        [3, 18],
        [4, 22],
        [6, 14],
        [8, 6],
      ]);
      const hour = rnd.weighted<number>([
        [12, 14],
        [13, 18],
        [19, 22],
        [20, 26],
        [21, 20],
        [22, 12],
        [18, 8],
      ]);
      const minute = rnd.int(0, 59);
      const openedAt = `${date} ${pad(hour)}:${pad(minute)}:00`;
      const closedAt = `${date} ${pad(Math.min(23, hour + 1))}:${pad(rnd.int(0, 59))}:00`;
      const channel = rnd.weighted<string>([
        ["dine_in", 74],
        ["takeout", 18],
        ["qr", 8],
      ]);

      // Parent row first: order_items carries a FK to orders(id).
      run(
        `INSERT INTO orders (id, check_number, table_id, terminal_id, server_id, status, channel, guests,
           subtotal, discount, vat, service_charge, tip, total, qr_token, guest_name, note, business_date,
           created_at, sent_at, fired_at, closed_at)
         VALUES (?, ?, ?, 'term-pos-1', ?, 'closed', ?, ?, 0, 0, 0, 0, 0, 0, NULL, '', '', ?, ?, ?, ?, ?)`,
        orderId,
        checkNumber,
        channel === "takeout" ? null : table.id,
        server.id,
        channel,
        guests,
        date,
        openedAt,
        openedAt,
        openedAt,
        closedAt,
      );

      const lineCount = rnd.int(2, 5);
      const chosen = rnd.pickMany(weightedMenu, lineCount).map(([item]) => item);
      let subtotal = 0;
      let cost = 0;
      const lineIds: string[] = [];

      for (const [lineIndex, item] of chosen.entries()) {
        const quantity = item.course === "drink" ? rnd.int(1, 3) : rnd.int(1, 2);
        const orderItemId = uuid();
        lineIds.push(orderItemId);
        // Modifier upcharges on roughly a third of lines.
        const modifierUplift = rnd.chance(0.34) ? rnd.pick([4000, 6000, 8000, 12000, 15000, 18000]) : 0;
        const unitPrice = item.price + modifierUplift;
        const isVoid = rnd.chance(0.012);
        run(
          `INSERT INTO order_items (id, order_id, menu_item_id, name_snapshot, quantity, price_at_time,
             course, station, seat, note, kds_status, is_void, void_reason, created_at, sent_at, ready_at, bumped_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'READY', ?, ?, ?, ?, ?, ?)`,
          orderItemId,
          orderId,
          item.id,
          item.name,
          quantity,
          unitPrice,
          item.course,
          item.station,
          (lineIndex % guests) + 1,
          isVoid ? 1 : 0,
          isVoid ? rnd.pick(["Made in error", "Guest changed order", "Quality rejected", "Wrong station"]) : null,
          openedAt,
          openedAt,
          openedAt,
          closedAt,
        );
        if (isVoid) {
          const amount = unitPrice * quantity;
          dayVoids += 1;
          dayVoidAmount += amount;
          run(
            `INSERT INTO voids (id, order_id, order_item_id, item_name, amount, reason, voided_by, created_at, business_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            uuid(),
            orderId,
            orderItemId,
            item.name,
            amount,
            rnd.pick(["Made in error", "Guest changed order", "Quality rejected", "Wrong station"]),
            server.id,
            openedAt,
            date,
          );
          continue;
        }
        subtotal += unitPrice * quantity;
        cost += item.cost * quantity;
        const stats = itemStats.get(item.id) ?? { units: 0, revenue: 0, cost: 0 };
        stats.units += quantity;
        stats.revenue += unitPrice * quantity;
        stats.cost += item.cost * quantity;
        itemStats.set(item.id, stats);
      }

      if (subtotal <= 0) {
        run("DELETE FROM orders WHERE id = ?", orderId); // cascades to its items
        continue;
      }

      const hasDiscount = rnd.chance(0.09);
      const discount = hasDiscount ? rnd.pick([percentOf(subtotal, 5), percentOf(subtotal, 10), 10000, 20000]) : 0;
      const taxable = subtotal - discount;
      const vat = vatAmount(taxable, 13, false);
      const service = percentOf(taxable, 10);
      const total = taxable + vat + service;
      const tipBase = rnd.chance(0.55) ? percentOf(total, rnd.pick([5, 8, 10, 12])) : 0;

      if (hasDiscount) {
        // `value` is basis points for a percent discount, paisa for a fixed one;
        // `amount` is always the resolved paisa actually taken off the ticket.
        const isPercent = rnd.chance(0.5);
        run(
          `INSERT INTO order_discounts (id, order_id, order_item_id, kind, value, amount, reason, approved_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          uuid(),
          orderId,
          lineIds[0] ?? null,
          isPercent ? "percent" : "amount",
          isPercent ? Math.round((discount / subtotal) * 10000) : discount,
          discount,
          rnd.pick(["Staff meal", "Regular guest", "Service recovery", "Manager comp", "Promotion"]),
          manager?.id ?? server.id,
          closedAt,
        );
      }

      run(
        `UPDATE orders SET subtotal = ?, discount = ?, vat = ?, service_charge = ?, tip = ?, total = ?
          WHERE id = ?`,
        subtotal,
        discount,
        vat,
        service,
        tipBase,
        total + tipBase,
        orderId,
      );

      // One or two tenders per check.
      const splits = rnd.chance(0.16) ? 2 : 1;
      let remaining = total + tipBase;
      for (let tenderIndex = 0; tenderIndex < splits; tenderIndex += 1) {
        const method = rnd.weighted<string>([
          ["cash", 42],
          ["card", 30],
          ["esewa", 14],
          ["khalti", 9],
          ["gift_card", 3],
          ["wallet", 2],
        ]);
        const isLast = tenderIndex === splits - 1;
        const amount = isLast ? remaining : Math.round(remaining * rnd.float(0.35, 0.6, 2));
        const tip = isLast ? tipBase : 0;
        remaining -= amount;
        const bucket = tenderTotals[method] ?? { count: 0, amount: 0, tips: 0 };
        bucket.count += 1;
        bucket.amount += amount;
        bucket.tips += tip;
        tenderTotals[method] = bucket;
        run(
          `INSERT INTO payments (id, order_id, method, amount, tip, status, label, auth_code, last4, created_at, business_date)
           VALUES (?, ?, ?, ?, ?, 'captured', ?, ?, ?, ?, ?)`,
          uuid(),
          orderId,
          method,
          amount,
          tip,
          splits > 1 ? `Guest ${tenderIndex + 1} of ${splits}` : "",
          method === "card" ? `AUTH${rnd.int(100000, 999999)}` : null,
          method === "card" ? String(rnd.int(1000, 9999)) : null,
          closedAt,
          date,
        );
      }

      daySubtotal += subtotal;
      dayDiscount += discount;
      dayVat += vat;
      dayService += service;
      dayTips += tipBase;
      dayGuests += guests;
      dayCost += cost;
      dayChecks += 1;
    }

    // ---- labour for the day
    let dayGross = 0;
    for (const employee of employees) {
      const pattern = SHIFT_PATTERN[employee.name];
      if (!pattern || !pattern.days.includes(weekday)) continue;
      const clockIn = atClock(date, pattern.start);
      const endParts = pattern.end.split(":");
      const endMinutes = Number(endParts[0]) * 60 + Number(endParts[1]) + rnd.int(-12, 22);
      const clockOut = atClock(endMinutes >= 1440 ? shiftDate(date, 1) : date, `${pad(Math.floor(((endMinutes % 1440) + 1440) % 1440 / 60))}:${pad(((endMinutes % 60) + 60) % 60)}`);
      const hours = shiftHours(clockIn, clockOut, 45);
      const { regular, overtime } = splitHours(hours);
      const gross = grossPay(regular, overtime, employee.hourly_rate);
      dayGross += gross;
      run(
        `INSERT INTO time_entries (id, employee_id, clock_in, clock_out, break_minutes, regular_hours,
           overtime_hours, hourly_rate, business_date, edited, ot_approved)
         VALUES (?, ?, ?, ?, 45, ?, ?, ?, ?, ?, ?)`,
        uuid(),
        employee.id,
        clockIn,
        clockOut,
        regular,
        overtime,
        employee.hourly_rate,
        date,
        rnd.chance(0.05) ? 1 : 0,
        overtime > 0 ? 1 : 0,
      );
    }

    const dayLabor = totalLaborCost(dayGross);
    const netSales = daySubtotal - dayDiscount;
    const grossSales = netSales + dayVat + dayService;

    // ---- cash drawer reconciliation
    const cashBucket = tenderTotals.cash;
    const expectedCash = (cashBucket?.amount ?? 0) + (cashBucket?.tips ?? 0) + 1_500_000;
    const variance = rnd.int(-1, 1) * rnd.int(0, 34000);
    run(
      `UPDATE business_days SET expected_cash = ?, counted_cash = ?, variance = ?, closed_by = ?, notes = ?
        WHERE id = ?`,
      expectedCash,
      expectedCash + variance,
      variance,
      manager?.id ?? null,
      variance === 0 ? "Drawer balanced." : variance < 0 ? "Drawer short — recounted twice." : "Drawer over — change given short.",
      businessDayId,
    );
    let countedRemaining = expectedCash + variance - 1_500_000;
    for (const denomination of DENOMINATIONS) {
      const counted = Math.max(0, Math.floor(countedRemaining / denomination.value));
      countedRemaining -= counted * denomination.value;
      run(
        `INSERT INTO cash_counts (id, business_day_id, denomination, expected_count, counted_count, counted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        uuid(),
        businessDayId,
        denomination.label,
        counted,
        counted,
        manager?.name ?? "Manager",
        atClock(shiftDate(date, 1), "01:20"),
      );
    }

    // ---- frozen Z-report snapshot
    const topItems = [...itemStats.entries()]
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, 5)
      .map(([id, stats]) => ({ id, name: byName.get(menu.find((item) => item.id === id)?.name ?? "")?.name ?? "—", ...stats }));

    run(
      `INSERT INTO z_reports (id, business_day_id, business_date, generated_at, payload) VALUES (?, ?, ?, ?, ?)`,
      uuid(),
      businessDayId,
      date,
      atClock(shiftDate(date, 1), "01:35"),
      JSON.stringify({
        businessDate: date,
        weekday: weekdayName(weekday),
        checks: dayChecks,
        guests: dayGuests,
        averageCheck: dayChecks ? Math.round(grossSales / dayChecks) : 0,
        coversPerHour: +(dayGuests / 14).toFixed(1),
        grossSales,
        netSales,
        discounts: dayDiscount,
        voids: dayVoids,
        voidAmount: dayVoidAmount,
        vat: dayVat,
        serviceCharge: dayService,
        tips: dayTips,
        laborCost: dayLabor,
        laborPercent: grossSales ? +((dayLabor / grossSales) * 100).toFixed(1) : 0,
        foodCost: dayCost,
        foodCostPercent: netSales ? +((dayCost / netSales) * 100).toFixed(1) : 0,
        tenders: tenderTotals,
        cash: { expected: expectedCash, counted: expectedCash + variance, variance, float: 1_500_000 },
        topItems,
      }),
    );
  }
}

function shiftHours(startsAt: string, endsAt: string, breakMinutes: number): number {
  const start = Date.parse(startsAt.replace(" ", "T") + "Z");
  const end = Date.parse(endsAt.replace(" ", "T") + "Z");
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.round(((end - start) / 3_600_000 - breakMinutes / 60) * 10000) / 10000);
}

/** Aggregated item statistics for a date range (used by reports). */
export function itemStatsFor(dates: string[]): Map<string, { units: number; revenue: number; cost: number }> {
  const placeholders = dates.map(() => "?").join(",");
  const rows = all<{ menu_item_id: string; units: number; revenue: number; cost: number }>(
    `SELECT oi.menu_item_id,
            SUM(oi.quantity) AS units,
            SUM(oi.quantity * (oi.price_at_time + COALESCE((
              SELECT SUM(oim.price_at_time) FROM order_item_modifiers oim WHERE oim.order_item_id = oi.id), 0))) AS revenue,
            SUM(oi.quantity * COALESCE(mi.cost, 0)) AS cost
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.is_void = 0 AND o.status = 'closed' AND o.business_date IN (${placeholders})
      GROUP BY oi.menu_item_id`,
    ...dates,
  );
  const map = new Map<string, { units: number; revenue: number; cost: number }>();
  for (const row of rows) {
    if (!row.menu_item_id) continue;
    map.set(row.menu_item_id, { units: Number(row.units), revenue: Math.round(Number(row.revenue)), cost: Math.round(Number(row.cost)) });
  }
  return map;
}
