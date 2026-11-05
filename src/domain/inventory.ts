/**
 * Inventory, reorder maths and bill-of-materials costing.
 *
 * Safety Stock = (Max Daily Usage × Max Lead Time) − (Avg Daily Usage × Avg Lead Time)
 * Reorder Point = (Avg Daily Usage × Avg Lead Time) + Safety Stock
 * Order Qty (packs) = ceil((Par Level − Current Stock) / Pack Size)
 */

export interface StockItem {
  current_stock: number;
  avg_daily_usage: number;
  max_daily_usage: number;
  lead_time_days: number;
  max_lead_time_days: number;
  par_level: number;
  pack_size: number;
  low_stock_threshold?: number;
  unit_cost?: number;
}

/**
 * Safety Stock = (Max Daily Usage x Max Lead Time) - (Avg Daily Usage x Avg Lead Time)
 * Clamped at zero: a negative buffer is meaningless and would silently drag the
 * reorder point below plain lead-time demand.
 */
export function safetyStock(item: StockItem): number {
  const raw = item.max_daily_usage * item.max_lead_time_days - item.avg_daily_usage * item.lead_time_days;
  return round2(Math.max(0, raw));
}

/** Reorder Point = (Avg Daily Usage x Avg Lead Time) + Safety Stock */
export function reorderPoint(item: StockItem): number {
  return round2(item.avg_daily_usage * item.lead_time_days + safetyStock(item));
}

/** Days of stock left at the average burn rate — the headline inventory KPI. */
export function daysOfCover(item: StockItem): number {
  if (!item.avg_daily_usage) return Number.POSITIVE_INFINITY;
  return round2(item.current_stock / item.avg_daily_usage);
}

export function orderQtyPacks(item: StockItem): number {
  if (item.current_stock >= item.par_level) return 0;
  const packSize = item.pack_size > 0 ? item.pack_size : 1;
  return Math.ceil((item.par_level - item.current_stock) / packSize);
}

/** Effective reorder trigger: the calculated ROP, floored by any manual alert level. */
export function effectiveThreshold(item: StockItem): number {
  return Math.max(reorderPoint(item), item.low_stock_threshold ?? 0);
}

export function isLowStock(item: StockItem): boolean {
  return item.current_stock <= effectiveThreshold(item);
}

export function isOutOfStock(item: StockItem): boolean {
  return item.current_stock <= 0;
}

export function stockValue(item: StockItem): number {
  return Math.round(item.current_stock * (item.unit_cost ?? 0));
}

export type StockHealth = "out" | "low" | "watch" | "ok";

export function stockHealth(item: StockItem): StockHealth {
  if (isOutOfStock(item)) return "out";
  if (isLowStock(item)) return "low";
  const cover = daysOfCover(item);
  if (Number.isFinite(cover) && cover <= 3) return "watch";
  return "ok";
}

/**
 * Theoretical vs actual: what the ledger says stock should be after all
 * recorded movements, used by the reconciliation screen.
 */
export function theoreticalStock(opening: number, movements: number[]): number {
  return round2(opening + movements.reduce((total, delta) => total + delta, 0));
}

export function varianceOf(expected: number, counted: number): number {
  return round2(counted - expected);
}

/** Recipe (BOM) cost of one portion, in paisa. */
export function portionCost(components: { quantity_required: number; unit_cost: number }[]): number {
  return Math.round(components.reduce((total, row) => total + row.quantity_required * row.unit_cost, 0));
}

export interface MarginInput {
  price: number;
  cost: number;
}

export function grossMarginPaisa({ price, cost }: MarginInput): number {
  return price - cost;
}

export function grossMarginPercent({ price, cost }: MarginInput): number {
  if (!price) return 0;
  return round2(((price - cost) / price) * 100);
}

export function foodCostPercent({ price, cost }: MarginInput): number {
  if (!price) return 0;
  return round2((cost / price) * 100);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Unit conversion helper: base units <-> purchase packs. */
export function packsToUnits(packs: number, packSize: number): number {
  return round2(packs * (packSize > 0 ? packSize : 1));
}

export function unitsToPacks(units: number, packSize: number): number {
  if (!packSize) return 0;
  return round2(units / packSize);
}
