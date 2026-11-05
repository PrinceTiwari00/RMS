/**
 * Inventory service — item master, stock movements, bill-of-materials deduction,
 * the waste log and stock reconciliation.
 *
 * Every movement writes an immutable ledger row. Selling a dish deducts its raw
 * components through the BOM at close, never at ring-in, so a voided or edited
 * ticket never leaves a phantom deduction behind.
 */
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, notFound } from "@/server/router";
import { audit } from "@/server/audit";
import { refreshItemCost } from "@/server/menu";
import {
  daysOfCover,
  effectiveThreshold,
  foodCostPercent,
  grossMarginPercent,
  isLowStock,
  orderQtyPacks,
  reorderPoint,
  round2,
  safetyStock,
  stockHealth,
  stockValue,
} from "@/domain/inventory";
import { businessDateNow, nowStamp, shiftDate, today } from "@/domain/time";
import { formatQuantity } from "@/domain/money";
import type { CountRecord, InventoryItem, RecipeComponent, RecipeCosting, SessionUser, WasteEntry } from "@/types";

interface StockRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  current_stock: number;
  unit_cost: number;
  storage_location: string;
  avg_daily_usage: number;
  max_daily_usage: number;
  lead_time_days: number;
  max_lead_time_days: number;
  par_level: number;
  pack_size: number;
  low_stock_threshold: number;
  vendor_id: string | null;
  vendor_name: string | null;
  is_active: number;
  recipes_used_in: number | null;
}

const STOCK_SELECT = `
  SELECT i.*, v.name AS vendor_name,
         (SELECT COUNT(*) FROM recipes r WHERE r.inventory_item_id = i.id) AS recipes_used_in
    FROM inventory_items i LEFT JOIN vendors v ON v.id = i.vendor_id`;

function mapStock(row: StockRow): InventoryItem {
  const basis = {
    current_stock: row.current_stock,
    avg_daily_usage: row.avg_daily_usage,
    max_daily_usage: row.max_daily_usage,
    lead_time_days: row.lead_time_days,
    max_lead_time_days: row.max_lead_time_days,
    par_level: row.par_level,
    pack_size: row.pack_size,
    low_stock_threshold: row.low_stock_threshold,
    unit_cost: row.unit_cost,
  };
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    unit: row.unit,
    currentStock: round2(row.current_stock),
    unitCost: row.unit_cost,
    storageLocation: row.storage_location,
    avgDailyUsage: row.avg_daily_usage,
    maxDailyUsage: row.max_daily_usage,
    leadTimeDays: row.lead_time_days,
    maxLeadTimeDays: row.max_lead_time_days,
    parLevel: row.par_level,
    packSize: row.pack_size,
    lowStockThreshold: row.low_stock_threshold,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name ?? "—",
    isActive: Boolean(row.is_active),
    safetyStock: safetyStock(basis),
    reorderPoint: reorderPoint(basis),
    daysOfCover: daysOfCover(basis),
    orderPacks: orderQtyPacks(basis),
    health: stockHealth(basis),
    stockValue: stockValue(basis),
    recipesUsedIn: Number(row.recipes_used_in ?? 0),
  };
}

export function getInventoryItems(filter: { health?: string; category?: string; search?: string; vendorId?: string } = {}): InventoryItem[] {
  const items = all<StockRow>(`${STOCK_SELECT} WHERE i.is_active = 1 ORDER BY i.category, i.name`).map(mapStock);
  return items.filter((item) => {
    if (filter.health && filter.health !== "all" && item.health !== filter.health) return false;
    if (filter.category && filter.category !== "all" && item.category !== filter.category) return false;
    if (filter.vendorId && filter.vendorId !== "all" && item.vendorId !== filter.vendorId) return false;
    if (filter.search) {
      const needle = filter.search.toLowerCase();
      if (!`${item.name} ${item.sku} ${item.category} ${item.storageLocation}`.toLowerCase().includes(needle)) return false;
    }
    return true;
  });
}

export function getInventoryItem(id: string): InventoryItem | null {
  const row = get<StockRow>(`${STOCK_SELECT} WHERE i.id = ?`, id);
  return row ? mapStock(row) : null;
}

export function inventoryCategories(): string[] {
  return all<{ category: string }>("SELECT DISTINCT category FROM inventory_items ORDER BY category").map((row) => row.category);
}

export function inventoryMetrics() {
  const items = getInventoryItems();
  const totalValue = items.reduce((sum, item) => sum + item.stockValue, 0);
  return {
    items: items.length,
    totalValue,
    lowStock: items.filter((item) => item.health === "low" || item.health === "watch").length,
    outOfStock: items.filter((item) => item.health === "out").length,
    needsOrder: items.filter((item) => item.orderPacks > 0).length,
    categories: [...new Set(items.map((item) => item.category))].length,
    lowList: items.filter((item) => item.health !== "ok").slice(0, 8),
  };
}

// ------------------------------------------------------------------- item master
export interface InventoryInput {
  sku?: string;
  name?: string;
  category?: string;
  unit?: string;
  currentStock?: number;
  unitCost?: number;
  storageLocation?: string;
  avgDailyUsage?: number;
  maxDailyUsage?: number;
  leadTimeDays?: number;
  maxLeadTimeDays?: number;
  parLevel?: number;
  packSize?: number;
  lowStockThreshold?: number;
  vendorId?: string | null;
  isActive?: boolean;
}

export function createInventoryItem(input: InventoryInput, actor: SessionUser | null): InventoryItem {
  const name = String(input.name ?? "").trim();
  if (!name) throw badRequest("Item name is required");
  const id = uuid();
  run(
    `INSERT INTO inventory_items (id, sku, name, category, unit, current_stock, unit_cost, storage_location,
       avg_daily_usage, max_daily_usage, lead_time_days, max_lead_time_days, par_level, pack_size,
       low_stock_threshold, vendor_id, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    String(input.sku ?? "").trim().toUpperCase(),
    name,
    input.category ?? "produce",
    input.unit ?? "kg",
    round2(Number(input.currentStock ?? 0)),
    Math.round(Number(input.unitCost ?? 0)),
    input.storageLocation ?? "Walk-in",
    Number(input.avgDailyUsage ?? 0),
    Number(input.maxDailyUsage ?? 0),
    Number(input.leadTimeDays ?? 2),
    Number(input.maxLeadTimeDays ?? 3),
    Number(input.parLevel ?? 0),
    Number(input.packSize ?? 1) || 1,
    Number(input.lowStockThreshold ?? 0),
    input.vendorId ?? null,
    input.isActive === false ? 0 : 1,
  );
  audit(actor, "inventory.create", "inventory_item", id, name);
  return getInventoryItem(id)!;
}

export function updateInventoryItem(id: string, input: InventoryInput, actor: SessionUser | null): InventoryItem {
  const existing = get<StockRow>("SELECT * FROM inventory_items WHERE id = ?", id);
  if (!existing) throw notFound("Inventory item not found");
  const costChanged = input.unitCost !== undefined && Math.round(Number(input.unitCost)) !== existing.unit_cost;
  run(
    `UPDATE inventory_items SET sku = ?, name = ?, category = ?, unit = ?, unit_cost = ?, storage_location = ?,
       avg_daily_usage = ?, max_daily_usage = ?, lead_time_days = ?, max_lead_time_days = ?, par_level = ?,
       pack_size = ?, low_stock_threshold = ?, vendor_id = ?, is_active = ?
     WHERE id = ?`,
    input.sku ?? existing.sku,
    input.name ?? existing.name,
    input.category ?? existing.category,
    input.unit ?? existing.unit,
    input.unitCost !== undefined ? Math.round(Number(input.unitCost)) : existing.unit_cost,
    input.storageLocation ?? existing.storage_location,
    input.avgDailyUsage !== undefined ? Number(input.avgDailyUsage) : existing.avg_daily_usage,
    input.maxDailyUsage !== undefined ? Number(input.maxDailyUsage) : existing.max_daily_usage,
    input.leadTimeDays !== undefined ? Number(input.leadTimeDays) : existing.lead_time_days,
    input.maxLeadTimeDays !== undefined ? Number(input.maxLeadTimeDays) : existing.max_lead_time_days,
    input.parLevel !== undefined ? Number(input.parLevel) : existing.par_level,
    input.packSize !== undefined ? Number(input.packSize) || 1 : existing.pack_size,
    input.lowStockThreshold !== undefined ? Number(input.lowStockThreshold) : existing.low_stock_threshold,
    input.vendorId !== undefined ? input.vendorId : existing.vendor_id,
    input.isActive === undefined ? existing.is_active : input.isActive ? 1 : 0,
    id,
  );
  // An ingredient price change re-costs every recipe that uses it.
  if (costChanged) {
    const affected = all<{ menu_item_id: string }>("SELECT menu_item_id FROM recipes WHERE inventory_item_id = ?", id);
    for (const row of affected) refreshItemCost(row.menu_item_id);
  }
  audit(actor, "inventory.update", "inventory_item", id, existing.name);
  return getInventoryItem(id)!;
}

/** Any manual stock movement: restock, waste, correction, transfer. */
export function adjustStock(
  itemId: string,
  delta: number,
  reason: string,
  actor: SessionUser | null,
  referenceId: string | null = null,
): string {
  const item = getInventoryItem(itemId);
  if (!item) throw notFound("Inventory item not found");
  const value = round2(Number(delta));
  if (!Number.isFinite(value) || value === 0) throw badRequest("Adjustment quantity must be a non-zero number");
  const txId = uuid();
  tx(() => {
    run("UPDATE inventory_items SET current_stock = current_stock + ? WHERE id = ?", value, itemId);
    run(
      `INSERT INTO inventory_transactions (id, inventory_item_id, delta, reason, reference_id, actor, created_at, business_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      txId,
      itemId,
      value,
      reason,
      referenceId,
      actor?.name ?? "system",
      nowStamp(),
      businessDateNow(),
    );
  });
  audit(actor, "inventory.adjust", "inventory_item", itemId, `${reason}: ${value > 0 ? "+" : ""}${value} ${item.unit}`);
  return txId;
}

export function getLedger(itemId?: string, limit = 200) {
  const rows = itemId
    ? all<{ id: string; delta: number; reason: string; reference_id: string | null; actor: string; created_at: string; name: string; unit: string }>(
        `SELECT it.*, ii.name, ii.unit FROM inventory_transactions it JOIN inventory_items ii ON ii.id = it.inventory_item_id
          WHERE it.inventory_item_id = ? ORDER BY it.created_at DESC LIMIT ?`,
        itemId,
        limit,
      )
    : all<{ id: string; delta: number; reason: string; reference_id: string | null; actor: string; created_at: string; name: string; unit: string }>(
        `SELECT it.*, ii.name, ii.unit FROM inventory_transactions it JOIN inventory_items ii ON ii.id = it.inventory_item_id
          ORDER BY it.created_at DESC LIMIT ?`,
        limit,
      );
  return rows.map((row) => ({
    id: row.id,
    itemName: row.name,
    unit: row.unit,
    delta: row.delta,
    reason: row.reason,
    referenceId: row.reference_id,
    actor: row.actor,
    createdAt: row.created_at,
  }));
}

// ------------------------------------------------------------------- BOM / recipes
export function getRecipeComponents(menuItemId: string): RecipeComponent[] {
  return all<{
    inventory_item_id: string;
    name: string;
    unit: string;
    quantity_required: number;
    unit_cost: number;
    is_modifier: number;
    modifier_id: string;
  }>(
    `SELECT r.inventory_item_id, ii.name, ii.unit, r.quantity_required, ii.unit_cost, r.is_modifier, r.modifier_id
       FROM recipes r JOIN inventory_items ii ON ii.id = r.inventory_item_id
      WHERE r.menu_item_id = ? ORDER BY ii.name`,
    menuItemId,
  ).map((row) => ({
    menuItemId,
    inventoryItemId: row.inventory_item_id,
    itemName: row.name,
    unit: row.unit,
    quantityRequired: row.quantity_required,
    unitCost: row.unit_cost,
    lineCost: Math.round(row.quantity_required * row.unit_cost),
    isModifier: Boolean(row.is_modifier),
    modifierId: row.modifier_id || "",
  }));
}

/** Which menu items consume an ingredient — the reverse BOM lookup. */
export function recipesUsing(itemId: string): { menuItemId: string; itemName: string; emoji: string; quantityRequired: number; unit: string }[] {
  return all<{ menu_item_id: string; item_name: string; emoji: string; quantity_required: number; unit: string }>(
    `SELECT r.menu_item_id, mi.name AS item_name, mi.emoji, r.quantity_required, ii.unit
       FROM recipes r
       JOIN menu_items mi ON mi.id = r.menu_item_id
       JOIN inventory_items ii ON ii.id = r.inventory_item_id
      WHERE r.inventory_item_id = ? ORDER BY mi.name`,
    itemId,
  ).map((row) => ({
    menuItemId: row.menu_item_id,
    itemName: row.item_name,
    emoji: row.emoji,
    quantityRequired: row.quantity_required,
    unit: row.unit,
  }));
}

export function getRecipeCosting(menuItemId: string): RecipeCosting | null {
  const item = get<{ id: string; name: string; price: number; cost: number; emoji: string }>(
    "SELECT id, name, price, cost, emoji FROM menu_items WHERE id = ?",
    menuItemId,
  );
  if (!item) return null;
  const components = getRecipeComponents(menuItemId).filter((component) => !component.isModifier);
  const theoreticalCost = components.reduce((sum, component) => sum + component.lineCost, 0);
  const missing = components.filter((component) => component.quantityRequired <= 0).map((component) => component.itemName);
  return {
    menuItemId: item.id,
    itemName: item.name,
    emoji: item.emoji,
    price: item.price,
    theoreticalCost,
    storedCost: item.cost,
    margin: item.price - theoreticalCost,
    marginPercent: grossMarginPercent({ price: item.price, cost: theoreticalCost }),
    foodCostPercent: foodCostPercent({ price: item.price, cost: theoreticalCost }),
    components,
    missing,
  };
}

export function getAllRecipeCosting(): (RecipeCosting & { station: string; unitsSold: number })[] {
  const items = all<{ id: string; station: string; units_sold: number }>(
    `SELECT mi.id, mi.station,
            (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.menu_item_id = mi.id AND oi.is_void = 0 AND o.status = 'closed') AS units_sold
       FROM menu_items mi ORDER BY mi.name`,
  );
  return items
    .map((row) => {
      const costing = getRecipeCosting(row.id);
      return costing ? { ...costing, station: row.station, unitsSold: Number(row.units_sold) } : null;
    })
    .filter((entry): entry is RecipeCosting & { station: string; unitsSold: number } => entry !== null);
}

export function setRecipeComponent(
  menuItemId: string,
  inventoryItemId: string,
  quantity: number,
  options: { isModifier?: boolean; modifierId?: string } = {},
): void {
  if (!get("SELECT id FROM menu_items WHERE id = ?", menuItemId)) throw notFound("Menu item not found");
  if (!get("SELECT id FROM inventory_items WHERE id = ?", inventoryItemId)) throw notFound("Inventory item not found");
  const value = round2(Number(quantity));
  if (!Number.isFinite(value) || value < 0) throw badRequest("Quantity must be zero or more");
  const modifierId = options.isModifier ? options.modifierId ?? "" : "";
  run(
    `INSERT INTO recipes (menu_item_id, inventory_item_id, quantity_required, is_modifier, modifier_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(menu_item_id, inventory_item_id, modifier_id) DO UPDATE SET
       quantity_required = excluded.quantity_required, is_modifier = excluded.is_modifier`,
    menuItemId,
    inventoryItemId,
    value,
    options.isModifier ? 1 : 0,
    modifierId,
  );
  refreshItemCost(menuItemId);
}

export function removeRecipeComponent(menuItemId: string, inventoryItemId: string, modifierId = ""): void {
  run("DELETE FROM recipes WHERE menu_item_id = ? AND inventory_item_id = ? AND modifier_id = ?", menuItemId, inventoryItemId, modifierId);
  refreshItemCost(menuItemId);
}

/**
 * Deduct every non-void line's ingredients at check close.
 * Called inside the close transaction so a failed payment cannot consume stock.
 */
export function deductForOrder(orderId: string, actor: SessionUser | null): { rows: number; entries: { itemId: string; name: string; delta: number }[] } {
  const lines = all<{ id: string; menu_item_id: string | null; quantity: number }>(
    "SELECT id, menu_item_id, quantity FROM order_items WHERE order_id = ? AND is_void = 0",
    orderId,
  );
  const entries: { itemId: string; name: string; delta: number }[] = [];
  const stamp = nowStamp();
  const businessDate = businessDateNow();

  for (const line of lines) {
    if (!line.menu_item_id) continue;
    const components = all<{ inventory_item_id: string; quantity_required: number; is_modifier: number; modifier_id: string; name: string }>(
      `SELECT r.inventory_item_id, r.quantity_required, r.is_modifier, r.modifier_id, ii.name
         FROM recipes r JOIN inventory_items ii ON ii.id = r.inventory_item_id
        WHERE r.menu_item_id = ?`,
      line.menu_item_id,
    );
    const lineModifiers = new Set(
      all<{ modifier_id: string | null }>("SELECT modifier_id FROM order_item_modifiers WHERE order_item_id = ?", line.id)
        .map((row) => row.modifier_id)
        .filter(Boolean) as string[],
    );

    for (const component of components) {
      // Modifier-only components are consumed just when that modifier is chosen.
      if (component.is_modifier && component.modifier_id && !lineModifiers.has(component.modifier_id)) continue;
      const delta = -round2(component.quantity_required * line.quantity);
      if (!delta) continue;
      run("UPDATE inventory_items SET current_stock = current_stock + ? WHERE id = ?", delta, component.inventory_item_id);
      run(
        `INSERT INTO inventory_transactions (id, inventory_item_id, delta, reason, reference_id, actor, created_at, business_date)
         VALUES (?, ?, ?, 'sale', ?, ?, ?, ?)`,
        uuid(),
        component.inventory_item_id,
        delta,
        orderId,
        actor?.name ?? "system",
        stamp,
        businessDate,
      );
      entries.push({ itemId: component.inventory_item_id, name: component.name, delta });
    }
  }
  return { rows: entries.length, entries };
}

// ------------------------------------------------------------------------ waste
export const WASTE_REASONS = ["spoiled", "dropped", "expired", "overcook", "theft", "other"] as const;

export function logWaste(
  input: { inventoryItemId: string; quantity: number; reason: string; notes?: string },
  actor: SessionUser | null,
): WasteEntry {
  const item = getInventoryItem(input.inventoryItemId);
  if (!item) throw notFound("Inventory item not found");
  const quantity = round2(Math.abs(Number(input.quantity)));
  if (!Number.isFinite(quantity) || quantity <= 0) throw badRequest("Waste quantity must be greater than zero");
  if (!(WASTE_REASONS as readonly string[]).includes(input.reason)) throw badRequest("Unknown waste reason");
  if (quantity > item.currentStock) {
    throw badRequest(`Only ${formatQuantity(item.currentStock)} ${item.unit} of ${item.name} is on hand`);
  }

  const id = uuid();
  const stamp = nowStamp();
  const businessDate = businessDateNow();
  tx(() => {
    run(
      `INSERT INTO waste_log (id, inventory_item_id, quantity, reason, notes, logged_by, created_at, business_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      item.id,
      quantity,
      input.reason,
      String(input.notes ?? "").slice(0, 280),
      actor?.name ?? "system",
      stamp,
      businessDate,
    );
    run("UPDATE inventory_items SET current_stock = current_stock - ? WHERE id = ?", quantity, item.id);
    run(
      `INSERT INTO inventory_transactions (id, inventory_item_id, delta, reason, reference_id, actor, created_at, business_date)
       VALUES (?, ?, ?, 'waste', ?, ?, ?, ?)`,
      uuid(),
      item.id,
      -quantity,
      id,
      actor?.name ?? "system",
      stamp,
      businessDate,
    );
  });
  audit(actor, "inventory.waste", "inventory_item", item.id, `${quantity} ${item.unit} — ${input.reason}`);
  return getWasteEntry(id)!;
}

function mapWaste(row: {
  id: string;
  inventory_item_id: string;
  name: string;
  unit: string;
  unit_cost: number;
  quantity: number;
  reason: string;
  notes: string;
  logged_by: string;
  created_at: string;
  business_date: string | null;
}): WasteEntry {
  return {
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    itemName: row.name,
    unit: row.unit,
    quantity: row.quantity,
    reason: row.reason,
    notes: row.notes,
    loggedBy: row.logged_by,
    createdAt: row.created_at,
    businessDate: row.business_date,
    value: Math.round(row.quantity * row.unit_cost),
  };
}

const WASTE_SELECT = `
  SELECT w.*, ii.name, ii.unit, ii.unit_cost FROM waste_log w JOIN inventory_items ii ON ii.id = w.inventory_item_id`;

export function getWasteEntry(id: string): WasteEntry | null {
  const row = get<Parameters<typeof mapWaste>[0]>(`${WASTE_SELECT} WHERE w.id = ?`, id);
  return row ? mapWaste(row) : null;
}

export function getWaste(filter: { from?: string; to?: string; reason?: string; itemId?: string; limit?: number } = {}): WasteEntry[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.from) {
    clauses.push("COALESCE(w.business_date, date(w.created_at)) >= ?");
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push("COALESCE(w.business_date, date(w.created_at)) <= ?");
    params.push(filter.to);
  }
  if (filter.reason && filter.reason !== "all") {
    clauses.push("w.reason = ?");
    params.push(filter.reason);
  }
  if (filter.itemId) {
    clauses.push("w.inventory_item_id = ?");
    params.push(filter.itemId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return all<Parameters<typeof mapWaste>[0]>(
    `${WASTE_SELECT} ${where} ORDER BY w.created_at DESC LIMIT ?`,
    ...params,
    filter.limit ?? 500,
  ).map(mapWaste);
}

export function wasteSummary(from: string, to: string) {
  const entries = getWaste({ from, to });
  const byReason = new Map<string, { quantity: number; value: number; count: number }>();
  for (const entry of entries) {
    const bucket = byReason.get(entry.reason) ?? { quantity: 0, value: 0, count: 0 };
    bucket.quantity += entry.quantity;
    bucket.value += entry.value;
    bucket.count += 1;
    byReason.set(entry.reason, bucket);
  }
  return {
    entries: entries.length,
    totalValue: entries.reduce((sum, entry) => sum + entry.value, 0),
    byReason: [...byReason.entries()].map(([reason, bucket]) => ({ reason, ...bucket })).sort((a, b) => b.value - a.value),
    topItems: topBy(entries.map((entry) => ({ key: entry.itemName, value: entry.value })), 6),
  };
}

function topBy(rows: { key: string; value: number }[], limit: number) {
  const grouped = new Map<string, number>();
  for (const row of rows) grouped.set(row.key, (grouped.get(row.key) ?? 0) + row.value);
  return [...grouped.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value).slice(0, limit);
}

// ----------------------------------------------------------------- reconciliation
export function getCounts(filter: { date?: string; applied?: boolean; limit?: number } = {}): CountRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.date) {
    clauses.push("c.business_date = ?");
    params.push(filter.date);
  }
  if (filter.applied !== undefined) {
    clauses.push("c.applied = ?");
    params.push(filter.applied ? 1 : 0);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return all<{
    id: string;
    inventory_item_id: string;
    name: string;
    unit: string;
    unit_cost: number;
    expected: number;
    counted: number;
    variance: number;
    counted_by: string;
    applied: number;
    created_at: string;
    business_date: string | null;
  }>(
    `SELECT c.*, ii.name, ii.unit, ii.unit_cost FROM inventory_counts c JOIN inventory_items ii ON ii.id = c.inventory_item_id
      ${where} ORDER BY c.created_at DESC LIMIT ?`,
    ...params,
    filter.limit ?? 300,
  ).map((row) => ({
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    itemName: row.name,
    unit: row.unit,
    expected: row.expected,
    counted: row.counted,
    variance: round2(row.variance),
    countedBy: row.counted_by,
    applied: Boolean(row.applied),
    createdAt: row.created_at,
    businessDate: row.business_date,
    varianceValue: Math.round(row.variance * row.unit_cost),
  }));
}

/** Record a physical count against the system figure (does not move stock yet). */
export function createCount(input: { inventoryItemId: string; counted: number }, actor: SessionUser | null): CountRecord {
  const item = getInventoryItem(input.inventoryItemId);
  if (!item) throw notFound("Inventory item not found");
  const counted = round2(Number(input.counted));
  if (!Number.isFinite(counted) || counted < 0) throw badRequest("Counted quantity must be zero or more");
  const id = uuid();
  run(
    `INSERT INTO inventory_counts (id, inventory_item_id, expected, counted, variance, counted_by, applied, created_at, business_date)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    id,
    item.id,
    item.currentStock,
    counted,
    round2(counted - item.currentStock),
    actor?.name ?? "system",
    nowStamp(),
    businessDateNow(),
  );
  return getCounts({ limit: 1 }).find((row) => row.id === id) ?? getCounts({ limit: 50 }).find((row) => row.id === id)!;
}

/** Post a counted variance to stock and the ledger. */
export function applyCount(countId: string, actor: SessionUser | null): CountRecord {
  const row = get<{ id: string; inventory_item_id: string; variance: number; applied: number; counted: number; expected: number }>(
    "SELECT * FROM inventory_counts WHERE id = ?",
    countId,
  );
  if (!row) throw notFound("Count not found");
  if (row.applied) throw badRequest("That count has already been posted");
  tx(() => {
    adjustStock(row.inventory_item_id, row.variance, "count", actor, countId);
    run("UPDATE inventory_counts SET applied = 1 WHERE id = ?", countId);
  });
  audit(actor, "inventory.reconcile", "inventory_item", row.inventory_item_id, `variance ${row.variance} posted`);
  return getCounts({ limit: 100 }).find((entry) => entry.id === countId)!;
}

/** Suggested count sheet: high-value and high-variance items first. */
export function suggestedCountSheet(limit = 12): { id: string; name: string; unit: string; currentStock: number; value: number; reason: string }[] {
  const items = getInventoryItems();
  return items
    .map((item) => ({
      id: item.id,
      name: item.name,
      unit: item.unit,
      currentStock: item.currentStock,
      value: item.stockValue,
      reason: item.health === "out" ? "Out of stock" : item.health === "low" ? "Below reorder point" : "High value",
      score: (item.health === "out" ? 1000 : 0) + item.stockValue,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Stock on hand at the start of a business date, for reconciliation reports. */
export function openingStockOn(date: string): { itemId: string; name: string; opening: number; movements: number }[] {
  const since = shiftDate(date, 0);
  return all<{ id: string; name: string; current_stock: number; movement: number | null }>(
    `SELECT ii.id, ii.name, ii.current_stock,
            (SELECT COALESCE(SUM(it.delta), 0) FROM inventory_transactions it
              WHERE it.inventory_item_id = ii.id AND date(it.created_at) >= ?) AS movement
       FROM inventory_items ii WHERE ii.is_active = 1 ORDER BY ii.name`,
    since,
  ).map((row) => ({
    itemId: row.id,
    name: row.name,
    opening: round2(row.current_stock - Number(row.movement ?? 0)),
    movements: round2(Number(row.movement ?? 0)),
  }));
}

export function lowStockAlerts(): InventoryItem[] {
  return getInventoryItems().filter((item) => item.health === "out" || item.health === "low");
}

export { effectiveThreshold, isLowStock, stockValue, formatQuantity, today };
