/**
 * Menu, category and modifier routes.
 *
 * Reads are open to any signed-in employee (the POS grid needs them); writes
 * require `admin.menu`. Instant 86ing is a separate endpoint so a server can
 * knock an item out mid-service without touching the rest of the record.
 */
import { route, created, badRequest } from "@/server/router";
import {
  createCategory,
  createGroup,
  createMenuItem,
  createOption,
  deleteCategory,
  deleteGroup,
  deleteMenuItem,
  deleteOption,
  defaultSelection,
  getCategories,
  getMenu,
  getMenuItem,
  getMenuByCategory,
  reorderCategories,
  reorderGroups,
  reorderItems,
  reorderOptions,
  refreshItemCost,
  setAvailability,
  updateCategory,
  updateGroup,
  updateMenuItem,
  updateOption,
} from "@/server/menu";
import { bool, has, int, nullableStr, optBool, optStr, paisa, str, strArr } from "@/server/coerce";
import { getRecipeCosting } from "@/server/inventory";

route("GET", "menu", null, ({ query }) => ({
  categories: getCategories(),
  items: getMenu({
    includeUnavailable: true,
    onlyAvailable: bool({ onlyAvailable: query.get("onlyAvailable") ?? undefined }, "onlyAvailable"),
  }),
  grouped: getMenuByCategory(),
}));

route("GET", "menu/items/:id", null, ({ params }) => {
  const item = getMenuItem(params.id);
  if (!item) throw badRequest("Menu item not found");
  return { item, defaultSelection: defaultSelection(item), costing: getRecipeCosting(params.id) };
});

// ------------------------------------------------------------------- categories
route("POST", "menu/categories", "admin.menu", ({ body }) =>
  created(createCategory({ name: str(body, "name"), icon: optStr(body, "icon"), color: optStr(body, "color") })),
);

route("PATCH", "menu/categories/:id", "admin.menu", ({ params, body }) =>
  updateCategory(params.id, {
    name: optStr(body, "name"),
    icon: optStr(body, "icon"),
    color: optStr(body, "color"),
    isActive: optBool(body, "isActive"),
  }),
);

route("DELETE", "menu/categories/:id", "admin.menu", ({ params }) => {
  deleteCategory(params.id);
  return { ok: true };
});

route("POST", "menu/categories/reorder", "admin.menu", ({ body }) => {
  reorderCategories(strArr(body, "ids"));
  return { categories: getCategories() };
});

// ------------------------------------------------------------------------ items
route("POST", "menu/items", "admin.menu", ({ body }) =>
  created(
    createMenuItem({
      name: str(body, "name"),
      categoryId: nullableStr(body, "categoryId"),
      description: optStr(body, "description"),
      price: paisa(body, "price"),
      course: optStr(body, "course"),
      station: optStr(body, "station"),
      allergens: optStr(body, "allergens"),
      prepMinutes: int(body, "prepMinutes", 8),
      spiceLevel: int(body, "spiceLevel", 0),
      upsellItemId: nullableStr(body, "upsellItemId"),
      upsellDiscountPercent: int(body, "upsellDiscountPercent", 20),
      emoji: optStr(body, "emoji"),
      isAvailable: optBool(body, "isAvailable"),
      isFeatured: optBool(body, "isFeatured"),
    }),
  ),
);

route("PATCH", "menu/items/:id", "admin.menu", ({ params, body }) =>
  updateMenuItem(params.id, {
    name: optStr(body, "name"),
    categoryId: nullableStr(body, "categoryId"),
    description: optStr(body, "description"),
    price: has(body, "price") ? paisa(body, "price") : undefined,
    course: optStr(body, "course"),
    station: optStr(body, "station"),
    allergens: optStr(body, "allergens"),
    prepMinutes: has(body, "prepMinutes") ? int(body, "prepMinutes") : undefined,
    spiceLevel: has(body, "spiceLevel") ? int(body, "spiceLevel") : undefined,
    upsellItemId: body.upsellItemId !== undefined ? nullableStr(body, "upsellItemId") : undefined,
    upsellDiscountPercent: has(body, "upsellDiscountPercent") ? int(body, "upsellDiscountPercent") : undefined,
    emoji: optStr(body, "emoji"),
    isAvailable: optBool(body, "isAvailable"),
    isFeatured: optBool(body, "isFeatured"),
  }),
);

route("DELETE", "menu/items/:id", "admin.menu", ({ params }) => {
  deleteMenuItem(params.id);
  return { ok: true };
});

route("POST", "menu/items/reorder", "admin.menu", ({ body }) => {
  reorderItems(strArr(body, "ids"));
  return { items: getMenu({ includeUnavailable: true }) };
});

/** Instant 86 — the single most-used mid-service control. */
route("POST", "menu/items/:id/availability", "admin.menu", ({ params, body, user }) => {
  const isAvailable = bool(body, "isAvailable", false);
  setAvailability(params.id, isAvailable, user);
  return { item: getMenuItem(params.id) };
});

/** Recompute an item's cost from its bill of materials. */
route("POST", "menu/items/:id/recost", "admin.recipes", ({ params }) => ({
  cost: refreshItemCost(params.id),
  costing: getRecipeCosting(params.id),
}));

// -------------------------------------------------------------- modifier groups
route("POST", "menu/items/:id/groups", "admin.menu", ({ params, body }) =>
  created(
    createGroup(params.id, {
      name: str(body, "name"),
      minSelect: int(body, "minSelect", 0),
      maxSelect: int(body, "maxSelect", 1),
      isRequired: bool(body, "isRequired", false),
    }),
  ),
);

route("PATCH", "menu/groups/:groupId", "admin.menu", ({ params, body }) => {
  updateGroup(params.groupId, {
    name: optStr(body, "name"),
    minSelect: has(body, "minSelect") ? int(body, "minSelect") : undefined,
    maxSelect: has(body, "maxSelect") ? int(body, "maxSelect") : undefined,
    isRequired: optBool(body, "isRequired"),
  });
  return { ok: true };
});

route("DELETE", "menu/groups/:groupId", "admin.menu", ({ params }) => {
  deleteGroup(params.groupId);
  return { ok: true };
});

route("POST", "menu/items/:id/groups/reorder", "admin.menu", ({ params, body }) => {
  reorderGroups(params.id, strArr(body, "ids"));
  return { item: getMenuItem(params.id) };
});

// ------------------------------------------------------------- modifier options
route("POST", "menu/groups/:groupId/options", "admin.menu", ({ params, body }) =>
  created(
    createOption(params.groupId, {
      name: str(body, "name"),
      price: paisa(body, "price"),
      isDefault: bool(body, "isDefault", false),
    }),
  ),
);

route("PATCH", "menu/options/:optionId", "admin.menu", ({ params, body }) => {
  updateOption(params.optionId, {
    name: optStr(body, "name"),
    price: has(body, "price") ? paisa(body, "price") : undefined,
    isDefault: optBool(body, "isDefault"),
    isAvailable: optBool(body, "isAvailable"),
  });
  return { ok: true };
});

route("DELETE", "menu/options/:optionId", "admin.menu", ({ params }) => {
  deleteOption(params.optionId);
  return { ok: true };
});

route("POST", "menu/groups/:groupId/options/reorder", "admin.menu", ({ params, body }) => {
  reorderOptions(params.groupId, strArr(body, "ids"));
  return { ok: true };
});
