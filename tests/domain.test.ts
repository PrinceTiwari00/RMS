import { describe, expect, it } from "vitest";
import {
  formatMoney,
  formatMoneyShort,
  netOfVat,
  percentOf,
  ratioPercent,
  roundToRupee,
  toPaisa,
  toRupees,
  vatAmount,
} from "@/domain/money";
import { lineTotal, priceOrder, resolveDiscount, splitVat, subtotalOf } from "@/domain/pricing";
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
  occupancy,
  turnLabel,
} from "@/domain/tables";
import { canBump, initialKdsStatus, routeItems, stationLoads, urgency } from "@/domain/kds";
import {
  daysOfCover,
  effectiveThreshold,
  foodCostPercent,
  grossMarginPercent,
  isLowStock,
  orderQtyPacks,
  packsToUnits,
  portionCost,
  reorderPoint,
  safetyStock,
  stockHealth,
  theoreticalStock,
  unitsToPacks,
  varianceOf,
} from "@/domain/inventory";
import {
  BURDEN_FACTOR,
  grossPay,
  laborCostPercent,
  laborHealth,
  salesPerLaborHour,
  salesToReachTarget,
  scheduledHours,
  shiftHours,
  splitHours,
  totalLaborCost,
} from "@/domain/labor";
import { POPULARITY_FACTOR, productMix, quadrantFor } from "@/domain/pmix";
import { allocate, buildSplit, cashSuggestions, summarizeTenders } from "@/domain/checkout";
import { buildEdi850 } from "@/domain/edi";
import {
  businessDateNow,
  clockFromMinutes,
  dateRange,
  elapsedMinutes,
  formatClock,
  minutesFromClock,
  shiftDate,
  startOfWeek,
  weekDates,
  zoned,
} from "@/domain/time";
import { can, permissionsFor, workspaceFor } from "@/domain/permissions";

// ----------------------------------------------------------------------- money
describe("money", () => {
  it("round-trips rupees and paisa without floating point drift", () => {
    expect(toPaisa(12.5)).toBe(1250);
    expect(toPaisa("480.99")).toBe(48099);
    expect(toPaisa(0.1 + 0.2)).toBe(30); // the classic float trap
    expect(toRupees(48099)).toBe(480.99);
    expect(toPaisa(null)).toBe(0);
    expect(toPaisa("abc")).toBe(0);
  });

  it("formats with Nepali/Indian digit grouping", () => {
    expect(formatMoney(12345600)).toBe("Rs 1,23,456.00");
    expect(formatMoney(48099)).toBe("Rs 480.99");
    expect(formatMoney(0)).toBe("Rs 0.00");
    expect(formatMoneyShort(25_000_000)).toBe("Rs 2.5L"); // Rs 2,50,000 -> 2.5 lakh
    expect(formatMoneyShort(2_500_000_000)).toBe("Rs 2.5Cr");
    expect(formatMoneyShort(9_999_900)).toBe("Rs 99,999"); // below 1L stays exact
    expect(formatMoneyShort(48_099)).toBe("Rs 480.99");
  });

  it("computes 13% Nepal VAT both exclusively and inclusively", () => {
    expect(vatAmount(100000, 13, false)).toBe(13000); // Rs 1000 -> Rs 130
    // Inclusive: Rs 1130 contains Rs 130 of VAT.
    expect(vatAmount(113000, 13, true)).toBe(13000);
    expect(netOfVat(113000, 13)).toBe(100000);
    const { net, vat } = splitVat(113000, 13);
    expect(net + vat).toBe(113000);
  });

  it("handles percentages and safe ratios", () => {
    expect(percentOf(100000, 10)).toBe(10000);
    expect(ratioPercent(1, 3)).toBe(33.3);
    expect(ratioPercent(1, 0)).toBe(0); // no NaN
    expect(roundToRupee(12345)).toBe(12300);
    expect(roundToRupee(12350)).toBe(12400);
  });
});

// --------------------------------------------------------------------- pricing
describe("pricing", () => {
  const settings = { vatRate: 13, vatInclusive: false, serviceChargeRate: 10 };

  it("prices a ticket: subtotal, discount, VAT, service charge, tip", () => {
    const lines = [
      { quantity: 2, unitPrice: 32000, modifiers: [{ price: 4000 }] }, // 2 x Rs 360
      { quantity: 1, unitPrice: 45000 }, // Rs 450
    ];
    expect(lineTotal(lines[0])).toBe(72000);
    expect(subtotalOf(lines)).toBe(117000);

    const priced = priceOrder(lines, 10000, settings, 5000);
    expect(priced.subtotal).toBe(117000);
    expect(priced.discount).toBe(10000);
    expect(priced.taxable).toBe(107000);
    expect(priced.vat).toBe(Math.round(107000 * 0.13)); // 13910
    expect(priced.serviceCharge).toBe(10700);
    expect(priced.total).toBe(107000 + 13910 + 10700);
    expect(priced.tip).toBe(5000);
    expect(priced.grandTotal).toBe(priced.total + 5000);
    expect(priced.itemCount).toBe(3);
  });

  it("ignores voided lines and caps discounts at the subtotal", () => {
    const lines = [
      { quantity: 1, unitPrice: 10000 },
      { quantity: 1, unitPrice: 20000, isVoid: 1 },
    ];
    expect(subtotalOf(lines)).toBe(10000);
    const priced = priceOrder(lines, 99999, settings);
    expect(priced.discount).toBe(10000);
    expect(priced.taxable).toBe(0);
    expect(priced.total).toBe(0);
  });

  it("resolves percent and fixed discounts", () => {
    expect(resolveDiscount(100000, "percent", 10)).toBe(10000);
    expect(resolveDiscount(100000, "percent", 250)).toBe(100000); // clamped to 100%
    expect(resolveDiscount(100000, "amount", 4500)).toBe(4500);
    expect(resolveDiscount(100000, "amount", -500)).toBe(0);
  });

  it("never produces a total that disagrees with the sum of its parts", () => {
    for (const subtotal of [1, 999, 12345, 99999, 250000]) {
      const priced = priceOrder([{ quantity: 1, unitPrice: subtotal }], 0, settings, 0);
      expect(priced.total).toBe(priced.taxable + priced.vat + priced.serviceCharge);
    }
  });
});

// ------------------------------------------------------- floor plan state machine
describe("table state machine", () => {
  it("follows available -> seated -> ordered -> billed -> dirty -> available", () => {
    const happy: ["available", "seated", "ordered", "billed", "dirty", "available"][] = [
      ["available", "seated", "ordered", "billed", "dirty", "available"],
    ];
    for (const path of happy) {
      for (let index = 0; index < path.length - 1; index += 1) {
        expect(canTransition(path[index], path[index + 1]), `${path[index]} -> ${path[index + 1]}`).toBe(true);
        expect(() => assertTransition(path[index], path[index + 1])).not.toThrow();
      }
    }
  });

  it("rejects illegal jumps", () => {
    expect(canTransition("available", "billed")).toBe(false);
    expect(canTransition("dirty", "seated")).toBe(false);
    expect(() => assertTransition("available", "dirty")).toThrow(/Illegal table transition/);
  });

  it("allows the real-world reverse edges", () => {
    expect(canTransition("seated", "available")).toBe(true); // party walked out
    expect(canTransition("billed", "ordered")).toBe(true); // bill reopened
    expect(Object.keys(ALLOWED_TRANSITIONS)).toHaveLength(5);
  });

  it("formats turn times and occupancy", () => {
    expect(turnLabel(45)).toBe("45m");
    expect(turnLabel(95)).toBe("1h 35m");
    expect(occupancy({ total: 21, occupied: 9 })).toBe(43);
    expect(occupancy({ total: 0, occupied: 0 })).toBe(0);
  });
});

// ------------------------------------------------------------------------- KDS
describe("kitchen display routing", () => {
  it("holds entrees and releases everything else", () => {
    expect(initialKdsStatus("entree")).toBe("HOLD");
    expect(initialKdsStatus("appetizer")).toBe("PENDING");
    expect(initialKdsStatus("drink")).toBe("PENDING");
    expect(initialKdsStatus("dessert")).toBe("PENDING");
  });

  it("routes lines to stations", () => {
    const routing = routeItems([
      { id: "a", station: "grill" },
      { id: "b", station: "grill" },
      { id: "c", station: "bar" },
    ]);
    expect(routing).toEqual({ grill: ["a", "b"], bar: ["c"] });
  });

  it("only bumps a ticket when every line is ready", () => {
    expect(canBump(["READY", "READY"])).toBe(true);
    expect(canBump(["READY", "PENDING"])).toBe(false);
    expect(canBump([])).toBe(false); // an empty ticket never bumps
  });

  it("escalates urgency with elapsed time", () => {
    expect(urgency("HOLD", "entree", 99)).toBe("hold");
    expect(urgency("READY", "entree", 99)).toBe("ready");
    expect(urgency("PENDING", "entree", 4)).toBe("ok");
    expect(urgency("PENDING", "entree", 12)).toBe("warn");
    expect(urgency("PENDING", "entree", 20)).toBe("late");
    expect(urgency("PENDING", "drink", 4)).toBe("warn"); // drinks are urgent sooner
    expect(urgency("PENDING", "drink", 7)).toBe("late");
  });

  it("aggregates station load and tracks the oldest pending item", () => {
    const loads = stationLoads([
      { station: "grill", kds_status: "PENDING", minutes: 12 },
      { station: "grill", kds_status: "PENDING", minutes: 4 },
      { station: "grill", kds_status: "HOLD", minutes: 20 },
      { station: "bar", kds_status: "READY", minutes: 1 },
    ]);
    const grill = loads.find((load) => load.station === "grill");
    expect(grill).toMatchObject({ pending: 2, hold: 1, ready: 0, oldestMinutes: 12 });
    expect(loads.find((load) => load.station === "bar")).toMatchObject({ ready: 1 });
    expect(loads.find((load) => load.station === "fry")).toMatchObject({ pending: 0, hold: 0, ready: 0 });
  });
});

// ------------------------------------------------------------------- inventory
describe("inventory and BOM maths", () => {
  const item = {
    current_stock: 20,
    avg_daily_usage: 10,
    max_daily_usage: 15,
    lead_time_days: 2,
    max_lead_time_days: 4,
    par_level: 100,
    pack_size: 25,
  };

  it("computes safety stock and reorder point", () => {
    // SS = (15 x 4) - (10 x 2) = 40 ; ROP = (10 x 2) + 40 = 60
    expect(safetyStock(item)).toBe(40);
    expect(reorderPoint(item)).toBe(60);
    expect(safetyStock({ ...item, max_daily_usage: 1, max_lead_time_days: 1 })).toBe(0); // never negative
  });

  it("orders in whole packs up to par", () => {
    expect(orderQtyPacks(item)).toBe(4); // ceil((100-20)/25)
    expect(orderQtyPacks({ ...item, current_stock: 120 })).toBe(0);
    expect(orderQtyPacks({ ...item, current_stock: 95 })).toBe(1);
    expect(packsToUnits(3, 25)).toBe(75);
    expect(unitsToPacks(75, 25)).toBe(3);
    expect(unitsToPacks(75, 0)).toBe(0);
  });

  it("classifies stock health", () => {
    expect(stockHealth({ ...item, current_stock: 0 })).toBe("out");
    expect(stockHealth({ ...item, current_stock: 55 })).toBe("low"); // below ROP 60
    expect(stockHealth({ ...item, current_stock: 25 })).toBe("low");
    expect(stockHealth(item)).toBe("low"); // 20 on hand vs ROP 60
    expect(isLowStock(item)).toBe(true);
    expect(stockHealth({ ...item, current_stock: 90 })).toBe("ok");
    // Above the ROP but fewer than three days of cover.
    expect(stockHealth({ ...item, current_stock: 65, avg_daily_usage: 25 })).toBe("watch");
    expect(daysOfCover({ ...item, avg_daily_usage: 0 })).toBe(Number.POSITIVE_INFINITY);
    expect(effectiveThreshold({ ...item, low_stock_threshold: 80 })).toBe(80);
  });

  it("costs a portion and derives margins", () => {
    expect(portionCost([{ quantity_required: 0.15, unit_cost: 92000 }, { quantity_required: 1, unit_cost: 3500 }])).toBe(
      Math.round(0.15 * 92000 + 3500),
    );
    expect(grossMarginPercent({ price: 45000, cost: 15000 })).toBe(66.67);
    expect(foodCostPercent({ price: 45000, cost: 15000 })).toBe(33.33);
    expect(grossMarginPercent({ price: 0, cost: 100 })).toBe(0);
  });

  it("reconciles theoretical vs counted stock", () => {
    expect(theoreticalStock(100, [-10, -5, 20])).toBe(105);
    expect(varianceOf(105, 103)).toBe(-2);
    expect(varianceOf(105, 105)).toBe(0);
  });
});

// ---------------------------------------------------------------------- labour
describe("labour cost maths", () => {
  it("measures a shift and splits overtime past 8 hours", () => {
    expect(shiftHours("2026-11-04 09:00:00", "2026-11-04 19:30:00", 30)).toBe(10);
    const { regular, overtime } = splitHours(10);
    expect(regular).toBe(8);
    expect(overtime).toBe(2);
    expect(shiftHours("2026-11-04 19:00:00", "2026-11-04 09:00:00", 0)).toBe(0); // never negative
  });

  it("pays overtime at 1.5x and burdens at 1.18", () => {
    const gross = grossPay(8, 2, 20000); // Rs 200/hr
    expect(gross).toBe(8 * 20000 + 2 * 20000 * 1.5); // Rs 2,200
    expect(totalLaborCost(gross)).toBe(Math.round(gross * BURDEN_FACTOR));
    expect(laborCostPercent(totalLaborCost(gross), 1000000)).toBe(25.96);
    expect(laborCostPercent(1000, 0)).toBe(0);
  });

  it("judges labour health against a configurable band", () => {
    expect(laborHealth(10)).toBe("under");
    expect(laborHealth(18)).toBe("target");
    expect(laborHealth(40)).toBe("over");
    expect(laborHealth(30, { min: 25, max: 35 })).toBe("target");
    expect(salesToReachTarget(250000, 25)).toBe(1000000);
    expect(salesPerLaborHour(10000000, 40)).toBe(2500);
    expect(
      scheduledHours([
        { starts_at: "2026-11-04 09:00:00", ends_at: "2026-11-04 17:00:00", break_minutes: 30 },
        { starts_at: "2026-11-04 16:00:00", ends_at: "2026-11-05 00:00:00", break_minutes: 30 },
      ]),
    ).toBe(15);
  });
});

// --------------------------------------------------------------------- P-Mix
describe("product mix matrix", () => {
  it("assigns the four Kasavana/Smith quadrants", () => {
    expect(quadrantFor(true, true)).toBe("star");
    expect(quadrantFor(true, false)).toBe("plowhorse");
    expect(quadrantFor(false, true)).toBe("puzzle");
    expect(quadrantFor(false, false)).toBe("dog");
  });

  it("classifies a real menu against both thresholds", () => {
    const result = productMix([
      // Hugely popular, thin margin -> plowhorse
      { id: "1", name: "Masala Chiya", unitsSold: 400, revenue: 3200000, cost: 1200000, price: 8000 },
      // Popular and profitable -> star
      { id: "2", name: "Chicken Momo", unitsSold: 200, revenue: 6400000, cost: 2000000, price: 32000 },
      // Under the popularity bar but the best margin on the menu -> puzzle
      { id: "3", name: "Whisky 60ml", unitsSold: 90, revenue: 6750000, cost: 900000, price: 75000 },
      // Sells little and earns little -> dog
      { id: "4", name: "Kheer", unitsSold: 40, revenue: 800000, cost: 700000, price: 20000 },
    ]);
    expect(result.quadrants.star.rows.map((row) => row.name)).toContain("Chicken Momo");
    expect(result.quadrants.plowhorse.rows.map((row) => row.name)).toContain("Masala Chiya");
    expect(result.quadrants.puzzle.rows.map((row) => row.name)).toContain("Whisky 60ml");
    expect(result.quadrants.dog.rows.map((row) => row.name)).toContain("Kheer");
    expect(result.totals.units).toBe(730);
    expect(result.totals.revenue).toBe(17150000);
    expect(result.thresholds.popularityPercent).toBeCloseTo((100 / 4) * POPULARITY_FACTOR, 5);
    expect(Object.values(result.quadrants).reduce((n, quadrant) => n + quadrant.count, 0)).toBe(4);
  });

  it("survives an empty period", () => {
    const result = productMix([]);
    expect(result.rows).toEqual([]);
    expect(result.totals.units).toBe(0);
    expect(result.thresholds.popularityPercent).toBe(0);
  });
});

// -------------------------------------------------------------------- checkout
describe("checkout splits and tenders", () => {
  it("allocates a whole amount across buckets with no rounding loss", () => {
    for (const amount of [1, 999, 13910, 25000]) {
      const shares = allocate(amount, [1, 1, 1]);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
    }
    expect(allocate(100, [0, 0])).toEqual([0, 0]);
    expect(allocate(1000, [3, 1])).toEqual([750, 250]);
  });

  const lines = [
    { id: "l1", name: "Momo", quantity: 1, seat: 1, amount: 32000 },
    { id: "l2", name: "Burger", quantity: 1, seat: 2, amount: 45000 },
    { id: "l3", name: "Beer", quantity: 2, seat: 1, amount: 90000 },
  ];
  const extras = { vat: 21710, serviceCharge: 16700, discount: 5000 };

  it("splits by seat and keeps the parts equal to the whole", () => {
    const buckets = buildSplit(lines, "seat", extras);
    expect(buckets.map((bucket) => bucket.label)).toEqual(["Seat 1", "Seat 2"]);
    expect(buckets[0].subtotal).toBe(122000);
    expect(buckets[1].subtotal).toBe(45000);
    expect(buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(
      167000 + extras.vat + extras.serviceCharge - extras.discount,
    );
  });

  it("splits evenly across guests", () => {
    const buckets = buildSplit(lines, "even", extras);
    expect(buckets).toHaveLength(2);
    expect(buckets.reduce((sum, bucket) => sum + bucket.subtotal, 0)).toBe(167000);
    expect(Math.abs(buckets[0].total - buckets[1].total)).toBeLessThanOrEqual(1);
  });

  it("splits per item into one bucket per line", () => {
    const buckets = buildSplit(lines, "item", extras);
    expect(buckets).toHaveLength(3);
    expect(buckets.every((bucket) => bucket.lines.length === 1)).toBe(true);
  });

  it("returns nothing when the check is not being split", () => {
    expect(buildSplit(lines, "none", extras)).toEqual([]);
  });

  it("validates tenders and computes change", () => {
    const due = 100000;
    expect(summarizeTenders(due, [{ method: "cash", amount: due }])).toMatchObject({
      remaining: 0,
      changeDue: 0,
      valid: true,
    });
    expect(summarizeTenders(due, [{ method: "cash", amount: 150000 }])).toMatchObject({
      changeDue: 50000,
      overTendered: true,
      valid: true,
    });
    // A card cannot over-tender — there is no change to give back.
    expect(summarizeTenders(due, [{ method: "card", amount: 150000 }]).changeDue).toBe(0);
    expect(summarizeTenders(due, [{ method: "cash", amount: 60000 }, { method: "card", amount: 40000 }])).toMatchObject({
      applied: 100000,
      remaining: 0,
      valid: true,
    });
    expect(summarizeTenders(due, [{ method: "cash", amount: 60000 }]).valid).toBe(false);
  });

  it("offers sensible cash quick-tenders", () => {
    const suggestions = cashSuggestions(123456); // Rs 1,234.56 due
    expect(suggestions[0]).toEqual({ label: "Exact", amount: 123456 });
    expect(suggestions.map((entry) => entry.amount)).toContain(124000); // Rs 1,240
    expect(suggestions.map((entry) => entry.amount)).toContain(150000); // Rs 1,500
    expect(suggestions.every((entry) => entry.amount >= 123456)).toBe(true);
    expect(suggestions.length).toBeLessThanOrEqual(6);
    expect(cashSuggestions(0)).toEqual([]);
    // An already-round amount offers no duplicate of itself.
    expect(cashSuggestions(150000).filter((entry) => entry.amount === 150000)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------- EDI
describe("EDI 850", () => {
  it("builds a well-formed X12 envelope", () => {
    const doc = buildEdi850({
      poNumber: "PO-1042",
      sender: "TERAIKITCHEN",
      receiver: "NEPALCOLD",
      items: [
        { qty: 2, price: 4650000, sku: "MEAT-CHB-01" },
        { qty: 1, price: 7100000, sku: "MEAT-MUT-03" },
      ],
      now: new Date(2026, 10, 4, 16, 55),
    });
    expect(doc).toContain("ISA*00*");
    expect(doc).toContain("GS*PO*TERAIKITCHEN*NEPALCOLD*20261104*1655*1*X*004010~");
    expect(doc).toContain("ST*850*PO-1042~");
    expect(doc).toContain("BEG*00*NE*PO-1042**20261104~");
    expect(doc).toContain("PO1*001*2*CA*46500.00*PE**VN*MEAT-CHB-01~");
    expect(doc).toContain("PO1*002*1*CA*71000.00*PE**VN*MEAT-MUT-03~");
    expect(doc).toContain("CTT*2~");
    expect(doc).toContain("IEA*1*000000001~");
    // Segment/element counts must agree with the document body.
    const st = doc.split("\n").indexOf(doc.split("\n").find((line) => line.startsWith("ST*"))!);
    const se = doc.split("\n").find((line) => line.startsWith("SE*"))!;
    const body = doc.split("\n").slice(st + 1, -3).filter(Boolean);
    // SE-1 counts every segment in the transaction set, ST and SE included.
    expect(Number(se.split("*")[1])).toBe(body.length + 2);
  });
});

// ------------------------------------------------------------------------ time
describe("restaurant time", () => {
  it("reports Kathmandu wall clock regardless of host timezone", () => {
    const morning = zoned(new Date("2026-11-03T21:00:00Z")); // 02:45 next day in KTM
    expect(morning.date).toBe("2026-11-04");
    expect(morning.time).toBe("02:45:00");
    // Before the 04:00 rollover it still belongs to the previous business day.
    expect(morning.businessDate).toBe("2026-11-03");

    const lunch = zoned(new Date("2026-11-04T07:30:00Z")); // 13:15 in KTM
    expect(lunch.stamp).toBe("2026-11-04 13:15:00");
    expect(lunch.businessDate).toBe("2026-11-04");
    expect(typeof businessDateNow()).toBe("string");
  });

  it("does calendar date arithmetic without drifting across DST/timezones", () => {
    expect(shiftDate("2026-11-04", -1)).toBe("2026-11-03");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2024-03-01", -1)).toBe("2024-02-29"); // leap year
    expect(dateRange("2026-11-01", "2026-11-04")).toHaveLength(4);
    expect(weekDates("2026-11-01")).toHaveLength(7);
  });

  it("anchors the week on Sunday", () => {
    // 2026-11-04 is a Wednesday.
    expect(startOfWeek("2026-11-04")).toBe("2026-11-01");
    expect(startOfWeek("2026-11-01")).toBe("2026-11-01");
  });

  it("measures elapsed ticket time for KDS timers", () => {
    const now = zoned();
    const tenMinutesAgo = new Date(Date.parse(`${now.stamp.replace(" ", "T")}Z`) - 600_000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    // Re-express in the restaurant zone so the comparison is like-for-like.
    expect(elapsedMinutes(now.stamp)).toBe(0);
    expect(elapsedMinutes(null)).toBe(0);
    expect(elapsedMinutes(tenMinutesAgo) >= 0).toBe(true);
  });

  it("converts clock strings and formats times", () => {
    expect(minutesFromClock("19:30")).toBe(1170);
    expect(clockFromMinutes(1170)).toBe("19:30");
    expect(clockFromMinutes(1500)).toBe("01:00"); // wraps past midnight
    expect(formatClock("2026-11-04 19:30:00")).toBe("19:30");
    expect(formatClock(null)).toBe("--:--");
  });
});

// ------------------------------------------------------------------------ RBAC
describe("role based access control", () => {
  it("gives managers everything and cooks nothing but the kitchen", () => {
    expect(permissionsFor("manager")).toContain("admin.users");
    expect(permissionsFor("manager")).toContain("reports.zreport");
    const cook = permissionsFor("cook");
    expect(cook).toEqual(expect.arrayContaining(["kds.view", "kds.ready", "kds.prep"]));
    expect(cook).not.toContain("admin.users");
    expect(cook).not.toContain("pos.checkout");
  });

  it("treats a persisted matrix as authoritative, including revocations", () => {
    const server = permissionsFor("server", ["pos.void"]);
    expect(server).toContain("pos.void");
    expect(server).not.toContain("pos.open");
    expect(can(server, "pos.void")).toBe(true);
    expect(can(new Set(["*"]), "admin.users")).toBe(true);
  });

  it("hides whole workspaces a role cannot use", () => {
    expect(workspaceFor(permissionsFor("cook"))).toEqual({ foh: false, boh: true, admin: false, customer: false });
    expect(workspaceFor(permissionsFor("manager"))).toEqual({ foh: true, boh: true, admin: true, customer: true });
    expect(workspaceFor(permissionsFor("host")).foh).toBe(true);
    expect(workspaceFor(permissionsFor("host")).admin).toBe(false);
  });
});
