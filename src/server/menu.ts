/**
 * Menu catalogue service — categories, items, nested modifier groups and the
 * instant "86" (out of stock) switch.
 *
 * Modifier groups carry min/max selection counts so the POS can *force* a
 * choice ("Cook temperature", "Choose a side") before a line may be added.
 */
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, notFound } from "@/server/router";
import { audit } from "@/server/audit";
import { foodCostPercent, grossMarginPercent } from "@/domain/inventory";
import { nowStamp } from "@/domain/time";
import type { Category, MenuItem, ModifierGroup, ModifierOption, SessionUser } from "@/types";

interface CategoryRow {
  id: string;
  name: string;
  icon: string;
  color: string;
  sort_order: number;
  is_active: number;
}

interface ItemRow {
  id: string;
  category_id: string | null;
  name: string;
  description: string;
  price: number;
  cost: number;
  course: string;
  station: string;
  allergens: string;
  prep_minutes: number;
  spice_level: number;
  upsell_item_id: string | null;
  upsell_discount_percent: number;
  emoji: string;
  is_available: number;
  is_featured: number;
  sort_order: number;
  category_name: string | null;
  units_sold: number | null;
}

interface GroupRow {
  id: string;
  menu_item_id: string;
  name: string;
  min_select: number;
  max_select: number;
  is_required: number;
  sort_order: number;
}

interface OptionRow {
  id: string;
  group_id: string;
  menu_item_id: string;
  name: string;
  price: number;
  is_default: number;
  is_available: number;
  sort_order: number;
}

const ITEM_SELECT = `
  SELECT mi.*, c.name AS category_name,
         (SELECT COALESCE(SUM(oi.quantity), 0)
            FROM order_items oi JOIN orders o ON o.id = oi.order_id
           WHERE oi.menu_item_id = mi.id AND oi.is_void = 0 AND o.status = 'closed') AS units_sold
    FROM menu_items mi LEFT JOIN categories c ON c.id = mi.category_id`;

export function getCategories(): Category[] {
  return all<CategoryRow>("SELECT * FROM categories ORDER BY sort_order, name").map((row) => ({
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    sortOrder: row.sort_order,
    isActive: Boolean(row.is_active),
  }));
}

export function getMenu(options: { includeUnavailable?: boolean; onlyAvailable?: boolean } = {}): MenuItem[] {
  const rows = all<ItemRow>(`${ITEM_SELECT} ORDER BY mi.sort_order, mi.name`);
  const groups = all<GroupRow>("SELECT * FROM modifier_groups ORDER BY sort_order, name");
  const modifiers = all<OptionRow>("SELECT * FROM modifiers ORDER BY sort_order, name");

  const optionsByGroup = new Map<string, ModifierOption[]>();
  for (const modifier of modifiers) {
    const list = optionsByGroup.get(modifier.group_id) ?? [];
    list.push({
      id: modifier.id,
      name: modifier.name,
      price: modifier.price,
      isDefault: Boolean(modifier.is_default),
      isAvailable: Boolean(modifier.is_available),
      sortOrder: modifier.sort_order,
    });
    optionsByGroup.set(modifier.group_id, list);
  }

  const groupsByItem = new Map<string, ModifierGroup[]>();
  for (const group of groups) {
    const list = groupsByItem.get(group.menu_item_id) ?? [];
    list.push({
      id: group.id,
      name: group.name,
      minSelect: group.min_select,
      maxSelect: group.max_select,
      isRequired: Boolean(group.is_required),
      sortOrder: group.sort_order,
      options: optionsByGroup.get(group.id) ?? [],
    });
    groupsByItem.set(group.menu_item_id, list);
  }

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const defaultDrink = rows.find((row) => row.is_available && row.course === "drink" && /lassi|chiya|soda|coffee/i.test(row.name))
    ?? rows.find((row) => row.is_available && row.course === "drink");

  return rows
    .filter((row) => (options.onlyAvailable ? Boolean(row.is_available) : true))
    .map((row) => {
      const itemGroups = groupsByItem.get(row.id) ?? [];
      const explicitSpice = Number(row.spice_level ?? 0);
      const inferredSpice = explicitSpice > 0
        ? explicitSpice
        : itemGroups.some((g) => /spice/i.test(g.name)) || /chilli|schezwan|spicy|tikka|curry|tandoori|makhani/i.test(`${row.name} ${row.description}`)
          ? 2
          : 0;
      const explicitUpsell = row.upsell_item_id ? rowsById.get(row.upsell_item_id) : undefined;
      const resolvedUpsell = explicitUpsell && explicitUpsell.is_available && explicitUpsell.id !== row.id
        ? explicitUpsell
        : row.course !== "drink" && defaultDrink && defaultDrink.id !== row.id
          ? defaultDrink
          : undefined;
      const discountPct = Math.max(0, Math.min(80, Number(row.upsell_discount_percent ?? 20)));
      const upsellItem = resolvedUpsell
        ? {
            id: resolvedUpsell.id,
            name: resolvedUpsell.name,
            emoji: resolvedUpsell.emoji,
            price: resolvedUpsell.price,
            discountedPrice: Math.round((resolvedUpsell.price * (100 - discountPct)) / 100),
            discountPercent: discountPct,
          }
        : null;

      return {
        id: row.id,
        categoryId: row.category_id,
        categoryName: row.category_name ?? "Uncategorised",
        name: row.name,
        description: row.description,
        price: row.price,
        cost: row.cost,
        course: row.course as MenuItem["course"],
        station: row.station,
        allergens: row.allergens,
        prepMinutes: row.prep_minutes,
        spiceLevel: inferredSpice,
        upsellItemId: row.upsell_item_id ?? null,
        upsellDiscountPercent: discountPct,
        upsellItem,
        emoji: row.emoji,
        isAvailable: Boolean(row.is_available),
        isFeatured: Boolean(row.is_featured),
        sortOrder: row.sort_order,
        groups: itemGroups,
        marginPercent: grossMarginPercent({ price: row.price, cost: row.cost }),
        foodCostPercent: foodCostPercent({ price: row.price, cost: row.cost }),
        unitsSold: Number(row.units_sold ?? 0),
      };
    });
}

export function getMenuItem(id: string): MenuItem | undefined {
  return getMenu().find((item) => item.id === id);
}

/** Menu items grouped by category, in display order — the POS grid source. */
export function getMenuByCategory(): { category: Category; items: MenuItem[] }[] {
  const menu = getMenu();
  return getCategories()
    .filter((category) => category.isActive)
    .map((category) => ({ category, items: menu.filter((item) => item.categoryId === category.id) }))
    .filter((group) => group.items.length > 0);
}

// ------------------------------------------------------------------ categories
export function createCategory(input: { name: string; icon?: string; color?: string }): Category {
  const name = String(input.name ?? "").trim();
  if (!name) throw badRequest("Category name is required");
  const id = uuid();
  const sortOrder = Number(scalarMax("SELECT MAX(sort_order) FROM categories") ?? -1) + 1;
  run(
    "INSERT INTO categories (id, name, icon, color, sort_order, is_active) VALUES (?, ?, ?, ?, ?, 1)",
    id,
    name,
    input.icon ?? "🍽",
    input.color ?? "#137c70",
    sortOrder,
  );
  return getCategories().find((category) => category.id === id)!;
}

export function updateCategory(id: string, patch: Partial<{ name: string; icon: string; color: string; isActive: boolean }>): Category {
  const existing = get<CategoryRow>("SELECT * FROM categories WHERE id = ?", id);
  if (!existing) throw notFound("Category not found");
  run(
    "UPDATE categories SET name = ?, icon = ?, color = ?, is_active = ? WHERE id = ?",
    patch.name ?? existing.name,
    patch.icon ?? existing.icon,
    patch.color ?? existing.color,
    patch.isActive === undefined ? existing.is_active : patch.isActive ? 1 : 0,
    id,
  );
  return getCategories().find((category) => category.id === id)!;
}

export function deleteCategory(id: string): void {
  const items = Number(scalarMax("SELECT COUNT(*) FROM menu_items WHERE category_id = ?", id) ?? 0);
  if (items > 0) throw badRequest(`Move or delete the ${items} item(s) in this category first`);
  run("DELETE FROM categories WHERE id = ?", id);
}

export function reorderCategories(ids: string[]): void {
  tx(() => {
    ids.forEach((id, index) => run("UPDATE categories SET sort_order = ? WHERE id = ?", index, id));
  });
}

// ------------------------------------------------------------------ menu items
export interface MenuItemInput {
  name?: string;
  categoryId?: string | null;
  description?: string;
  price?: number;
  course?: string;
  station?: string;
  allergens?: string;
  prepMinutes?: number;
  spiceLevel?: number;
  upsellItemId?: string | null;
  upsellDiscountPercent?: number;
  emoji?: string;
  isAvailable?: boolean;
  isFeatured?: boolean;
}

export function createMenuItem(input: MenuItemInput): MenuItem {
  const name = String(input.name ?? "").trim();
  if (!name) throw badRequest("Item name is required");
  const price = Math.round(Number(input.price ?? 0));
  if (!Number.isFinite(price) || price < 0) throw badRequest("Price must be zero or more");
  const id = uuid();
  const sortOrder = Number(scalarMax("SELECT MAX(sort_order) FROM menu_items") ?? -1) + 1;
  run(
    `INSERT INTO menu_items (id, category_id, name, description, price, cost, course, station, allergens,
       prep_minutes, spice_level, upsell_item_id, upsell_discount_percent, emoji, is_available, is_featured, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.categoryId ?? null,
    name,
    input.description ?? "",
    price,
    input.course ?? "entree",
    input.station ?? "grill",
    input.allergens ?? "",
    Math.max(1, Math.round(Number(input.prepMinutes ?? 10))),
    Math.max(0, Math.min(3, Math.round(Number(input.spiceLevel ?? 0)))),
    input.upsellItemId ?? null,
    Math.max(0, Math.min(80, Math.round(Number(input.upsellDiscountPercent ?? 20)))),
    input.emoji ?? "🍽",
    input.isAvailable === false ? 0 : 1,
    input.isFeatured ? 1 : 0,
    sortOrder,
    nowStamp(),
    nowStamp(),
  );
  refreshItemCost(id);
  return getMenuItem(id)!;
}

export function updateMenuItem(id: string, patch: MenuItemInput): MenuItem {
  const existing = get<ItemRow>("SELECT * FROM menu_items WHERE id = ?", id);
  if (!existing) throw notFound("Menu item not found");
  run(
    `UPDATE menu_items SET name = ?, category_id = ?, description = ?, price = ?, course = ?, station = ?,
       allergens = ?, prep_minutes = ?, spice_level = ?, upsell_item_id = ?, upsell_discount_percent = ?, emoji = ?, is_available = ?, is_featured = ?, updated_at = ?
     WHERE id = ?`,
    patch.name ?? existing.name,
    patch.categoryId !== undefined ? patch.categoryId : existing.category_id,
    patch.description ?? existing.description,
    patch.price !== undefined ? Math.round(Number(patch.price)) : existing.price,
    patch.course ?? existing.course,
    patch.station ?? existing.station,
    patch.allergens ?? existing.allergens,
    patch.prepMinutes !== undefined ? Math.max(1, Math.round(Number(patch.prepMinutes))) : existing.prep_minutes,
    patch.spiceLevel !== undefined ? Math.max(0, Math.min(3, Math.round(Number(patch.spiceLevel)))) : existing.spice_level,
    patch.upsellItemId !== undefined ? patch.upsellItemId : existing.upsell_item_id,
    patch.upsellDiscountPercent !== undefined
      ? Math.max(0, Math.min(80, Math.round(Number(patch.upsellDiscountPercent))))
      : existing.upsell_discount_percent,
    patch.emoji ?? existing.emoji,
    patch.isAvailable === undefined ? existing.is_available : patch.isAvailable ? 1 : 0,
    patch.isFeatured === undefined ? existing.is_featured : patch.isFeatured ? 1 : 0,
    nowStamp(),
    id,
  );
  return getMenuItem(id)!;
}

/** The instant 86 switch — flips availability without touching the record. */
/** Instant 86 — audited, because it changes what the whole floor can sell. */
export function setAvailability(id: string, isAvailable: boolean, actor: SessionUser | null = null): void {
  const item = get<{ name: string }>("SELECT name FROM menu_items WHERE id = ?", id);
  const changed = run("UPDATE menu_items SET is_available = ?, updated_at = ? WHERE id = ?", isAvailable ? 1 : 0, nowStamp(), id).changes;
  if (!changed) throw notFound("Menu item not found");
  audit(actor, isAvailable ? "menu.86.clear" : "menu.86.set", "menu_item", id, item?.name ?? id);
}

export function deleteMenuItem(id: string): void {
  const used = Number(
    scalarMax("SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.menu_item_id = ? AND o.status != 'closed'", id) ?? 0,
  );
  if (used > 0) throw badRequest("This item is on a live ticket — 86 it instead of deleting");
  tx(() => {
    run("DELETE FROM recipes WHERE menu_item_id = ?", id);
    run("DELETE FROM menu_items WHERE id = ?", id); // cascades groups + options
  });
}

export function reorderItems(ids: string[]): void {
  tx(() => {
    ids.forEach((id, index) => run("UPDATE menu_items SET sort_order = ?, updated_at = ? WHERE id = ?", index, nowStamp(), id));
  });
}

/** Re-derive an item's theoretical portion cost from its bill of materials. */
export function refreshItemCost(menuItemId: string): number {
  const cost = Number(
    scalarMax(
      `SELECT COALESCE(SUM(r.quantity_required * ii.unit_cost), 0)
         FROM recipes r JOIN inventory_items ii ON ii.id = r.inventory_item_id
        WHERE r.menu_item_id = ? AND r.is_modifier = 0`,
      menuItemId,
    ) ?? 0,
  );
  run("UPDATE menu_items SET cost = ? WHERE id = ?", Math.round(cost), menuItemId);
  return Math.round(cost);
}

// -------------------------------------------------------------- modifier groups
export interface GroupInput {
  name?: string;
  minSelect?: number;
  maxSelect?: number;
  isRequired?: boolean;
}

export function createGroup(menuItemId: string, input: GroupInput): ModifierGroup {
  if (!get("SELECT id FROM menu_items WHERE id = ?", menuItemId)) throw notFound("Menu item not found");
  const name = String(input.name ?? "").trim();
  if (!name) throw badRequest("Group name is required");
  const id = uuid();
  const sortOrder = Number(scalarMax("SELECT MAX(sort_order) FROM modifier_groups WHERE menu_item_id = ?", menuItemId) ?? -1) + 1;
  const minSelect = Math.max(0, Math.round(Number(input.minSelect ?? 0)));
  const isRequired = input.isRequired ?? minSelect > 0;
  run(
    `INSERT INTO modifier_groups (id, menu_item_id, name, min_select, max_select, is_required, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    menuItemId,
    name,
    isRequired ? Math.max(1, minSelect) : minSelect,
    Math.max(0, Math.round(Number(input.maxSelect ?? 0))),
    isRequired ? 1 : 0,
    sortOrder,
  );
  return getMenuItem(menuItemId)!.groups.find((group) => group.id === id)!;
}

export function updateGroup(groupId: string, patch: GroupInput): void {
  const existing = get<GroupRow>("SELECT * FROM modifier_groups WHERE id = ?", groupId);
  if (!existing) throw notFound("Modifier group not found");
  const minSelect = patch.minSelect !== undefined ? Math.max(0, Math.round(Number(patch.minSelect))) : existing.min_select;
  const maxSelect = patch.maxSelect !== undefined ? Math.max(0, Math.round(Number(patch.maxSelect))) : existing.max_select;
  const isRequired = patch.isRequired !== undefined ? patch.isRequired : Boolean(existing.is_required);
  if (maxSelect > 0 && minSelect > maxSelect) throw badRequest("Minimum selections cannot exceed the maximum");
  run(
    "UPDATE modifier_groups SET name = ?, min_select = ?, max_select = ?, is_required = ? WHERE id = ?",
    patch.name ?? existing.name,
    isRequired ? Math.max(1, minSelect) : minSelect,
    maxSelect,
    isRequired ? 1 : 0,
    groupId,
  );
}

export function deleteGroup(groupId: string): void {
  run("DELETE FROM modifier_groups WHERE id = ?", groupId);
}

export function reorderGroups(menuItemId: string, ids: string[]): void {
  tx(() => {
    ids.forEach((id, index) => run("UPDATE modifier_groups SET sort_order = ? WHERE id = ? AND menu_item_id = ?", index, id, menuItemId));
  });
}

// --------------------------------------------------------------- group options
export function createOption(groupId: string, input: { name: string; price?: number; isDefault?: boolean }): ModifierOption {
  const group = get<GroupRow>("SELECT * FROM modifier_groups WHERE id = ?", groupId);
  if (!group) throw notFound("Modifier group not found");
  const name = String(input.name ?? "").trim();
  if (!name) throw badRequest("Option name is required");
  const id = uuid();
  const sortOrder = Number(scalarMax("SELECT MAX(sort_order) FROM modifiers WHERE group_id = ?", groupId) ?? -1) + 1;
  return tx(() => {
    run(
      `INSERT INTO modifiers (id, group_id, menu_item_id, name, price, is_default, is_available, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      id,
      groupId,
      group.menu_item_id,
      name,
      Math.round(Number(input.price ?? 0)),
      input.isDefault ? 1 : 0,
      sortOrder,
    );
    // A group keeps at most one default so the POS can pre-select safely.
    if (input.isDefault) {
      run("UPDATE modifiers SET is_default = 0 WHERE group_id = ? AND id != ?", groupId, id);
    }
    return getMenuItem(group.menu_item_id)!.groups.find((entry) => entry.id === groupId)!.options.find((option) => option.id === id)!;
  });
}

export function updateOption(optionId: string, patch: { name?: string; price?: number; isDefault?: boolean; isAvailable?: boolean }): void {
  const existing = get<OptionRow>("SELECT * FROM modifiers WHERE id = ?", optionId);
  if (!existing) throw notFound("Modifier option not found");
  tx(() => {
    run(
      "UPDATE modifiers SET name = ?, price = ?, is_default = ?, is_available = ? WHERE id = ?",
      patch.name ?? existing.name,
      patch.price !== undefined ? Math.round(Number(patch.price)) : existing.price,
      patch.isDefault === undefined ? existing.is_default : patch.isDefault ? 1 : 0,
      patch.isAvailable === undefined ? existing.is_available : patch.isAvailable ? 1 : 0,
      optionId,
    );
    if (patch.isDefault) run("UPDATE modifiers SET is_default = 0 WHERE group_id = ? AND id != ?", existing.group_id, optionId);
  });
}

export function deleteOption(optionId: string): void {
  run("DELETE FROM modifiers WHERE id = ?", optionId);
}

export function reorderOptions(groupId: string, ids: string[]): void {
  tx(() => {
    ids.forEach((id, index) => run("UPDATE modifiers SET sort_order = ? WHERE id = ? AND group_id = ?", index, id, groupId));
  });
}

// ------------------------------------------------------------------ validation
/**
 * Enforce a group's selection rules before a line may be added to a ticket.
 * Returns the resolved options in group order.
 */
export function validateModifierSelection(
  menuItemId: string,
  optionIds: string[],
): { id: string; groupName: string; name: string; price: number }[] {
  const item = getMenuItem(menuItemId);
  if (!item) throw notFound("Menu item not found");
  const requested = new Set(optionIds.filter(Boolean));

  const resolved: { id: string; groupName: string; name: string; price: number }[] = [];
  for (const group of item.groups) {
    const chosen = group.options.filter((option) => requested.has(option.id));
    for (const option of chosen) {
      if (!option.isAvailable) throw badRequest(`${option.name} is not available`);
      resolved.push({ id: option.id, groupName: group.name, name: option.name, price: option.price });
      requested.delete(option.id);
    }
    if (group.isRequired || group.minSelect > 0) {
      if (chosen.length < Math.max(1, group.minSelect)) {
        throw badRequest(`Choose at least ${Math.max(1, group.minSelect)} option(s) from "${group.name}"`);
      }
    }
    if (group.maxSelect > 0 && chosen.length > group.maxSelect) {
      throw badRequest(`"${group.name}" allows at most ${group.maxSelect} selection(s)`);
    }
  }
  if (requested.size) throw badRequest("One or more modifiers do not belong to this item");
  return resolved;
}

/** Options pre-selected by default, used when a guest taps an item once. */
export function defaultSelection(item: MenuItem): string[] {
  return item.groups.flatMap((group) => group.options.filter((option) => option.isDefault && option.isAvailable).map((option) => option.id));
}

function scalarMax(sql: string, ...params: unknown[]): unknown {
  const row = get<Record<string, unknown>>(sql, ...params);
  return row ? Object.values(row)[0] : undefined;
}
