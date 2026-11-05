import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { all, get, scalar } from "@/db/client";
import { seedIfEmpty } from "@/db/seed";

const dbFile = path.join(os.tmpdir(), `rms-seed-${process.pid}-${Date.now()}.db`);
process.env.RMS_DB_PATH = dbFile;

describe("demo seed", () => {
  beforeAll(() => {
    fs.rmSync(dbFile, { force: true });
    seedIfEmpty();
  });

  it("creates the full restaurant catalogue", () => {
    expect(Number(scalar("SELECT COUNT(*) FROM settings") ?? 0)).toBeGreaterThan(15);
    expect(Number(scalar("SELECT COUNT(*) FROM roles") ?? 0)).toBe(7);
    expect(Number(scalar("SELECT COUNT(*) FROM employees") ?? 0)).toBe(11);
    expect(Number(scalar("SELECT COUNT(*) FROM sections") ?? 0)).toBe(4);
    expect(Number(scalar("SELECT COUNT(*) FROM tables") ?? 0)).toBe(21);
    expect(Number(scalar("SELECT COUNT(*) FROM categories") ?? 0)).toBe(8);
    expect(Number(scalar("SELECT COUNT(*) FROM menu_items") ?? 0)).toBe(42);
    expect(Number(scalar("SELECT COUNT(*) FROM modifier_groups") ?? 0)).toBeGreaterThan(15);
    expect(Number(scalar("SELECT COUNT(*) FROM modifiers") ?? 0)).toBeGreaterThan(50);
    expect(Number(scalar("SELECT COUNT(*) FROM prep_sheets") ?? 0)).toBe(5);
    expect(Number(scalar("SELECT COUNT(*) FROM vendors") ?? 0)).toBe(5);
    expect(Number(scalar("SELECT COUNT(*) FROM inventory_items") ?? 0)).toBe(32);
    expect(Number(scalar("SELECT COUNT(*) FROM recipes") ?? 0)).toBeGreaterThan(90);
  });

  it("leaves the floor and kitchen live", () => {
    const statuses = all<{ status: string; n: number }>(
      "SELECT status, COUNT(*) AS n FROM tables GROUP BY status",
    ).reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.status]: Number(row.n) }), {});
    expect(statuses.available).toBeGreaterThan(5);
    expect(statuses.seated).toBeGreaterThanOrEqual(2);
    expect(statuses.ordered).toBeGreaterThanOrEqual(3);
    expect(statuses.billed).toBe(1);
    expect(statuses.dirty).toBe(1);

    const openOrders = Number(scalar("SELECT COUNT(*) FROM orders WHERE status != 'closed'") ?? 0);
    expect(openOrders).toBeGreaterThanOrEqual(6);
    const kdsPending = Number(scalar("SELECT COUNT(*) FROM order_items WHERE kds_status = 'PENDING'") ?? 0);
    const kdsHold = Number(scalar("SELECT COUNT(*) FROM order_items WHERE kds_status = 'HOLD'") ?? 0);
    const kdsReady = Number(scalar("SELECT COUNT(*) FROM order_items WHERE kds_status = 'READY'") ?? 0);
    expect(kdsPending).toBeGreaterThan(0);
    expect(kdsHold).toBeGreaterThan(0);
    expect(kdsReady).toBeGreaterThan(0);
  });

  it("generates fourteen closed business days of history", () => {
    const days = Number(scalar("SELECT COUNT(*) FROM business_days WHERE status = 'closed'") ?? 0);
    expect(days).toBe(14);
    const closed = Number(scalar("SELECT COUNT(*) FROM orders WHERE status = 'closed'") ?? 0);
    // ~40 tickets/day x 14 days
    expect(closed).toBeGreaterThan(400);
    expect(closed).toBeLessThan(1000);
    const payments = Number(scalar("SELECT COUNT(*) FROM payments WHERE status = 'captured'") ?? 0);
    expect(payments).toBeGreaterThan(closed);
    const zReports = Number(scalar("SELECT COUNT(*) FROM z_reports") ?? 0);
    expect(zReports).toBe(14);
    const timeEntries = Number(scalar("SELECT COUNT(*) FROM time_entries") ?? 0);
    expect(timeEntries).toBeGreaterThan(100);
  });

  it("prices every menu item above its theoretical BOM cost", () => {
    const rows = all<{ name: string; price: number; cost: number }>(
      "SELECT name, price, cost FROM menu_items WHERE cost > 0",
    );
    expect(rows.length).toBeGreaterThan(30);
    for (const row of rows) {
      expect(row.price, `${row.name} price vs cost`).toBeGreaterThan(row.cost);
    }
  });

  it("flags low stock so the purchasing pipeline has work to do", () => {
    const low = all<{ name: string }>(
      `SELECT name FROM inventory_items
        WHERE current_stock <= (avg_daily_usage * lead_time_days
              + (max_daily_usage * max_lead_time_days - avg_daily_usage * lead_time_days))`,
    );
    expect(low.length).toBeGreaterThan(0);
    const drafts = Number(scalar("SELECT COUNT(*) FROM purchase_orders WHERE status = 'draft'") ?? 0);
    expect(drafts).toBeGreaterThan(0);
    for (const status of ["draft", "approved", "sent", "received"]) {
      expect(Number(scalar("SELECT COUNT(*) FROM purchase_orders WHERE status = ?", status) ?? 0), status).toBeGreaterThan(0);
    }
  });

  it("is idempotent — a second call does not duplicate data", () => {
    const before = Number(scalar("SELECT COUNT(*) FROM orders") ?? 0);
    expect(seedIfEmpty().seeded).toBe(false);
    expect(Number(scalar("SELECT COUNT(*) FROM orders") ?? 0)).toBe(before);
  });

  it("keeps par_level above the reorder point for every item", () => {
    // Otherwise auto-ordering would raise a reorder and then order zero packs.
    const rows = all<{ name: string; stock: number; rop: number; par: number }>(
      `SELECT name, current_stock AS stock, par_level AS par,
              avg_daily_usage * lead_time_days
                + (max_daily_usage * max_lead_time_days - avg_daily_usage * lead_time_days) AS rop
         FROM inventory_items`,
    );
    expect(rows.length).toBe(32);
    for (const row of rows) {
      expect(row.par, `${row.name}: par ${row.par} must exceed rop ${row.rop}`).toBeGreaterThan(row.rop);
    }
    // A realistic mix rather than everything flashing red.
    const low = rows.filter((row) => row.stock <= row.rop).length;
    expect(low).toBeGreaterThanOrEqual(4);
    expect(low).toBeLessThanOrEqual(9);
    expect(rows.filter((row) => row.stock <= 0).length).toBe(1);
  });

  it("raises swap requests against shifts the requester actually owns", () => {
    const pending = Number(scalar("SELECT COUNT(*) FROM shift_swaps WHERE status = 'pending'") ?? 0);
    expect(pending).toBeGreaterThan(0);
    const orphaned = all<{ id: string }>(
      `SELECT s.id FROM shift_swaps s JOIN shifts sh ON sh.id = s.shift_id
        WHERE s.requested_by != sh.employee_id`,
    );
    expect(orphaned).toEqual([]);
  });

  it("keeps every foreign key intact", () => {
    const violations = all<{ table: string }>("PRAGMA foreign_key_check");
    expect(violations).toEqual([]);
    const staff = get<{ name: string; pin: string }>("SELECT name, pin FROM employees WHERE pin = '2468'");
    expect(staff?.name).toBe("Rajesh Kumar Sah");
  });
});
