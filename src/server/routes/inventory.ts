/**
 * Inventory, waste, reconciliation and recipe-costing routes.
 *
 * Stock reads are open to any signed-in employee — the POS shows an 86 badge
 * from the same data. Writes are split by concern: `admin.inventory` for the
 * item master, `admin.waste` for the waste log and counts, `admin.recipes` for
 * the bill of materials.
 */
import { route, created, badRequest } from "@/server/router";
import {
  adjustStock,
  applyCount,
  createCount,
  createInventoryItem,
  getAllRecipeCosting,
  getCounts,
  getInventoryItem,
  getInventoryItems,
  getLedger,
  getRecipeComponents,
  getRecipeCosting,
  getWaste,
  inventoryCategories,
  inventoryMetrics,
  logWaste,
  lowStockAlerts,
  openingStockOn,
  recipesUsing,
  removeRecipeComponent,
  setRecipeComponent,
  suggestedCountSheet,
  updateInventoryItem,
  WASTE_REASONS,
  wasteSummary,
} from "@/server/inventory";
import { refreshItemCost } from "@/server/menu";
import { bool, has, num, nullableStr, oneOf, optBool, optStr, paisa, q, qBool, qInt, required, str } from "@/server/coerce";
import { shiftDate, today } from "@/domain/time";

const HEALTH_STATES = ["all", "out", "low", "watch", "ok"] as const;

route("GET", "inventory", null, ({ query }) => ({
  items: getInventoryItems({
    health: oneOf(q(query, "health", "all"), HEALTH_STATES, "all"),
    category: q(query, "category", "all"),
    search: q(query, "search"),
    vendorId: q(query, "vendorId", "all"),
  }),
  metrics: inventoryMetrics(),
  categories: inventoryCategories(),
  reasons: WASTE_REASONS,
}));

route("GET", "inventory/alerts", "admin.inventory", () => ({ items: lowStockAlerts() }));

route("GET", "inventory/ledger", "admin.inventory", ({ query }) => ({
  entries: getLedger(q(query, "itemId") || undefined, qInt(query, "limit", 200)),
}));

route("GET", "inventory/items/:id", "admin.inventory", ({ params }) => {
  const item = getInventoryItem(params.id);
  if (!item) throw badRequest("Inventory item not found");
  return { item, ledger: getLedger(item.id, 40), usedIn: recipesUsing(item.id) };
});

route("POST", "inventory/items", "admin.inventory", ({ body, user }) =>
  created(
    createInventoryItem(
      {
        sku: optStr(body, "sku"),
        name: required(body, "name", "Item name"),
        category: optStr(body, "category"),
        unit: optStr(body, "unit"),
        currentStock: num(body, "currentStock", 0),
        unitCost: paisa(body, "unitCost", 0),
        storageLocation: optStr(body, "storageLocation"),
        avgDailyUsage: num(body, "avgDailyUsage", 0),
        maxDailyUsage: num(body, "maxDailyUsage", 0),
        leadTimeDays: num(body, "leadTimeDays", 2),
        maxLeadTimeDays: num(body, "maxLeadTimeDays", 3),
        parLevel: num(body, "parLevel", 0),
        packSize: num(body, "packSize", 1),
        lowStockThreshold: num(body, "lowStockThreshold", 0),
        vendorId: nullableStr(body, "vendorId"),
        isActive: optBool(body, "isActive"),
      },
      user,
    ),
  ),
);

route("PATCH", "inventory/items/:id", "admin.inventory", ({ params, body, user }) => ({
  item: updateInventoryItem(
    params.id,
    {
      sku: optStr(body, "sku"),
      name: optStr(body, "name"),
      category: optStr(body, "category"),
      unit: optStr(body, "unit"),
      unitCost: has(body, "unitCost") ? paisa(body, "unitCost") : undefined,
      storageLocation: optStr(body, "storageLocation"),
      avgDailyUsage: has(body, "avgDailyUsage") ? num(body, "avgDailyUsage") : undefined,
      maxDailyUsage: has(body, "maxDailyUsage") ? num(body, "maxDailyUsage") : undefined,
      leadTimeDays: has(body, "leadTimeDays") ? num(body, "leadTimeDays") : undefined,
      maxLeadTimeDays: has(body, "maxLeadTimeDays") ? num(body, "maxLeadTimeDays") : undefined,
      parLevel: has(body, "parLevel") ? num(body, "parLevel") : undefined,
      packSize: has(body, "packSize") ? num(body, "packSize") : undefined,
      lowStockThreshold: has(body, "lowStockThreshold") ? num(body, "lowStockThreshold") : undefined,
      vendorId: nullableStr(body, "vendorId"),
      isActive: optBool(body, "isActive"),
    },
    user,
  ),
}));

/** Manual stock movement: restock, correction, transfer, spillage. */
route("POST", "inventory/items/:id/adjust", "admin.inventory", ({ params, body, user }) => ({
  transactionId: adjustStock(params.id, num(body, "delta", 0), str(body, "reason", "adjustment"), user),
  item: getInventoryItem(params.id),
}));

// ----------------------------------------------------------------------- waste
route("GET", "waste", "admin.waste", ({ query }) => {
  const to = q(query, "to", today());
  const from = q(query, "from", shiftDate(to, -13));
  return {
    from,
    to,
    entries: getWaste({
      from,
      to,
      reason: q(query, "reason", "all"),
      itemId: q(query, "itemId") || undefined,
      limit: qInt(query, "limit", 500),
    }),
    summary: wasteSummary(from, to),
    reasons: WASTE_REASONS,
  };
});

route("POST", "waste", "admin.waste", ({ body, user }) =>
  created(
    logWaste(
      {
        inventoryItemId: required(body, "inventoryItemId", "An inventory item"),
        quantity: num(body, "quantity", 0),
        reason: oneOf(str(body, "reason", "spoiled"), WASTE_REASONS, "spoiled"),
        notes: optStr(body, "notes"),
      },
      user,
    ),
  ),
);

// ------------------------------------------------------------- reconciliation
route("GET", "counts", "admin.waste", ({ query }) => ({
  counts: getCounts({
    date: q(query, "date") || undefined,
    applied: q(query, "applied") === "" ? undefined : qBool(query, "applied"),
    limit: qInt(query, "limit", 300),
  }),
  sheet: suggestedCountSheet(qInt(query, "sheet", 12)),
}));

route("POST", "counts", "admin.waste", ({ body, user }) =>
  created(
    createCount(
      { inventoryItemId: required(body, "inventoryItemId", "An inventory item"), counted: num(body, "counted", 0) },
      user,
    ),
  ),
);

/** Post a counted variance to stock — the audited half of reconciliation. */
route("POST", "counts/:id/apply", "admin.waste", ({ params, user }) => ({ count: applyCount(params.id, user) }));

/** Theoretical opening stock for a date, for the reconciliation report. */
route("GET", "reconciliation", "admin.waste", ({ query }) => {
  const date = q(query, "date", today());
  return {
    date,
    opening: openingStockOn(date),
    counts: getCounts({ date }),
    waste: getWaste({ from: date, to: date }),
    ledger: getLedger(undefined, 200),
  };
});

// --------------------------------------------------------------------- recipes
route("GET", "recipes", "admin.recipes", ({ query }) => {
  const costing = getAllRecipeCosting();
  const search = q(query, "search").toLowerCase();
  const station = q(query, "station", "all");
  const filtered = costing.filter((row) => {
    if (search && !row.itemName.toLowerCase().includes(search)) return false;
    if (station !== "all" && row.station !== station) return false;
    return true;
  });
  return {
    costing: filtered,
    totals: {
      items: costing.length,
      costed: costing.filter((row) => row.components.length > 0).length,
      missing: costing.filter((row) => row.components.length === 0).length,
      averageMargin: costing.length
        ? Math.round(costing.reduce((sum, row) => sum + row.marginPercent, 0) / costing.length)
        : 0,
      averageFoodCost: costing.length
        ? Math.round(costing.reduce((sum, row) => sum + row.foodCostPercent, 0) / costing.length)
        : 0,
    },
    categories: inventoryCategories(),
  };
});

route("GET", "recipes/:menuItemId", "admin.recipes", ({ params }) => {
  const costing = getRecipeCosting(params.menuItemId);
  if (!costing) throw badRequest("Menu item not found");
  return { costing, components: getRecipeComponents(params.menuItemId) };
});

route("POST", "recipes/:menuItemId/components", "admin.recipes", ({ params, body }) => {
  setRecipeComponent(
    params.menuItemId,
    required(body, "inventoryItemId", "An inventory item"),
    num(body, "quantityRequired", 0),
    { isModifier: bool(body, "isModifier", false), modifierId: str(body, "modifierId") },
  );
  return { costing: getRecipeCosting(params.menuItemId), cost: refreshItemCost(params.menuItemId) };
});

route("DELETE", "recipes/:menuItemId/components/:itemId", "admin.recipes", ({ params, query }) => {
  removeRecipeComponent(params.menuItemId, params.itemId, q(query, "modifierId"));
  return { costing: getRecipeCosting(params.menuItemId), cost: refreshItemCost(params.menuItemId) };
});
