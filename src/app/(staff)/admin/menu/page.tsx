"use client";

/**
 * Screen 16 — Menu Builder.
 *
 * Reads are open to any signed-in employee because the POS grid needs them, but
 * the writes here are what keep that grid honest. The two controls that matter
 * most are invisible on paper: 86ing is a single audited toggle, and deleting a
 * dish that is on a live ticket is refused by the server — something cannot be
 * made to vanish from someone's ticket mid-service.
 *
 * Modifier groups are edited here too, because a group's minimum is what makes
 * the POS enforce an option rather than letting a server skip it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { usePoll, useStore } from "@/lib/store";
import { Button, Card, Chip, Empty, Field, Icon, Modal, TextInput, Toggle, toast } from "@/components/ui";
import { formatMoney, formatMoneyShort } from "@/domain/money";
import type { Category, MenuItem, ModifierOption } from "@/types";
import type { IconName } from "@/components/ui";

interface MenuResponse {
  categories: Category[];
  items: MenuItem[];
  grouped: { category: Category; items: MenuItem[] }[];
}

const COURSE_LABELS: Record<string, string> = {
  appetizer: "Appetizer",
  entree: "Entree",
  drink: "Drink",
  dessert: "Dessert",
};

const CATEGORY_ICONS: IconName[] = [
  "menu",
  "star",
  "recipe",
  "fire",
  "clock",
  "cash",
  "inventory",
  "vendor",
  "waste",
  "display",
];

const CATEGORY_COLORS = [
  "var(--color-brand-500)",
  "var(--color-ok)",
  "var(--color-warn)",
  "var(--color-ember-500)",
  "var(--color-info)",
  "var(--color-late)",
  "#8a5aa8",
];

export default function MenuPage() {
  const { allowed } = useStore();
  const canEdit = allowed("admin.menu");

  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [availability, setAvailability] = useState<"all" | "available" | "86">("all");
  const [editing, setEditing] = useState<MenuItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | "new" | null>(null);
  const [editingModifiers, setEditingModifiers] = useState<MenuItem | null>(null);

  const { data, reload } = usePoll<MenuResponse>("menu", { interval: 30000 });
  const categories = data?.categories ?? [];
  const items = data?.items ?? [];

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((item) => {
      if (activeCategory !== "all" && item.categoryId !== activeCategory) return false;
      if (availability === "available" && !item.isAvailable) return false;
      if (availability === "86" && item.isAvailable) return false;
      if (!needle) return true;
      return (
        item.name.toLowerCase().includes(needle) ||
        item.description.toLowerCase().includes(needle) ||
        item.station.toLowerCase().includes(needle)
      );
    });
  }, [items, activeCategory, availability, search]);

  /** Items grouped by category, preserving the server's sort order within each. */
  const byCategory = useMemo(() => {
    const buckets = new Map<string, MenuItem[]>();
    const uncategorised: MenuItem[] = [];
    for (const category of categories) buckets.set(category.id, []);
    for (const item of filtered) {
      if (item.categoryId && buckets.has(item.categoryId)) buckets.get(item.categoryId)!.push(item);
      else uncategorised.push(item);
    }
    for (const list of buckets.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    }
    const sections: { category?: Category; items: MenuItem[] }[] = [];
    for (const category of categories) {
      if ((buckets.get(category.id) ?? []).length > 0) sections.push({ category, items: buckets.get(category.id)! });
    }
    if (uncategorised.length > 0) sections.push({ items: uncategorised });
    return sections;
  }, [filtered, categories]);

  const toggleAvailability = useCallback(
    async (item: MenuItem) => {
      try {
        const result = await api.post<{ item: MenuItem }>(`menu/items/${item.id}/availability`, { isAvailable: !item.isAvailable });
        toast(`${item.name} is now ${result.item.isAvailable ? "on the menu" : "86'd"}`, result.item.isAvailable ? "ok" : "neutral");
        await reload();
      } catch (error) {
        toast(errorMessage(error), "late");
      }
    },
    [reload],
  );

  /** Reordering renumbers globally, so the whole menu is resubmitted in order. */
  const moveItem = useCallback(
    async (targetId: string, direction: "left" | "right") => {
      const ordered = [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      const index = ordered.findIndex((entry) => entry.id === targetId);
      if (index === -1) return;
      const target = ordered[index];
      let swap = direction === "left" ? index - 1 : index + 1;
      // Never cross out of the target's own category — a move is local to its section.
      while (swap >= 0 && swap < ordered.length && ordered[swap].categoryId !== target.categoryId) {
        swap += direction === "left" ? -1 : 1;
      }
      if (swap < 0 || swap >= ordered.length) return;
      const ids = ordered.map((entry) => entry.id);
      [ids[index], ids[swap]] = [ids[swap], ids[index]];
      try {
        await api.post("menu/items/reorder", { ids });
        await reload();
      } catch (error) {
        toast(errorMessage(error), "late");
      }
    },
    [items, reload],
  );

  if (!data) {
    return (
      <div className="p-6">
        <Empty title="Loading the menu…" icon="menu" />
      </div>
    );
  }

  const eightSixed = items.filter((item) => !item.isAvailable).length;
  const withModifiers = items.filter((item) => item.groups.length > 0).length;
  const mandatory = items.filter((item) => item.groups.some((group) => group.isRequired)).length;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-[19px] font-extrabold text-ink">Menu</h1>
          <p className="text-[12px] text-ink-faint">
            Categories, dishes and their options. 86 is a toggle — the dish stays on the menu but stops being sold.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="soft" onClick={() => setEditingCategory("new")}>
            <Icon name="plus" className="size-4" />
            New category
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" className="size-4" />
            New dish
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Dishes</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{items.length}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">{categories.length} categories</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">On sale</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{items.length - eightSixed}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Available to order right now</p>
        </Card>
        <Card accent="var(--color-warn)">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">86'd</p>
          <p className="tnum mt-1 text-2xl font-black text-warn">{eightSixed}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Temporarily not being served</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Sum of prices</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{formatMoneyShort(items.reduce((sum, item) => sum + item.price, 0))}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Not a revenue figure</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">With options</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{withModifiers}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">{mandatory} enforce a mandatory choice</p>
        </Card>
      </div>

      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2.5">
          <div className="relative">
            <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search dishes, stations or descriptions…"
              aria-label="Search the menu"
              className="w-56 rounded-lg border border-rule bg-paper-raised py-1.5 pl-8 pr-2.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-brand-400 focus:outline-none"
            />
          </div>

          <div className="flex gap-1">
            {(["all", "available", "86"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setAvailability(entry)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
                  availability === entry ? "bg-ink text-white" : "bg-paper-sunken text-ink-soft hover:bg-rule"
                }`}
              >
                {entry === "available" ? "On sale" : entry === "86" ? "86'd" : "All"}
              </button>
            ))}
          </div>

          <span className="tnum ml-auto text-[12px] font-semibold text-ink-faint">{filtered.length} dishes</span>
        </div>

        <div className="grid gap-0 md:grid-cols-[200px_minmax(0,1fr)]">
          <div className="border-b border-rule bg-paper-sunken/40 md:border-b-0 md:border-r">
            <button
              type="button"
              onClick={() => setActiveCategory("all")}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-[12px] font-bold transition-colors ${
                activeCategory === "all" ? "bg-brand-50 text-brand-700" : "text-ink-soft hover:bg-rule"
              }`}
            >
              <span className="flex items-center gap-1.5">
                <Icon name="menu" className="size-3.5" />
                All dishes
              </span>
              <span className="tnum rounded-full bg-white px-1.5">{items.length}</span>
            </button>
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => setActiveCategory(category.id)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] font-bold transition-colors ${
                  activeCategory === category.id ? "bg-brand-50 text-brand-700" : "text-ink-soft hover:bg-rule"
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: category.color || "var(--color-ink-faint)" }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{category.name}</span>
                  {!category.isActive && <span className="shrink-0 text-[10px] font-semibold text-ink-faint">off</span>}
                </span>
                <span className="tnum shrink-0 rounded-full bg-white px-1.5 text-[10px]">
                  {items.filter((item) => item.categoryId === category.id).length}
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setEditingCategory("new")}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12px] font-bold text-brand-600 transition-colors hover:bg-brand-50"
            >
              <Icon name="plus" className="size-3.5" />
              New category
            </button>
          </div>

          <div className="flex flex-col gap-4 p-3">
            {filtered.length === 0 ? (
              <Empty
                title={search || activeCategory !== "all" ? "No dishes match that" : "This category is empty"}
                hint="Add a dish, or pick a different category."
                icon="menu"
              />
            ) : (
              byCategory.map((section) => (
                <CategoryBlock
                  key={section.category?.id ?? "uncategorised"}
                  category={section.category}
                  items={section.items}
                  canEdit={canEdit}
                  onToggleAvailability={toggleAvailability}
                  onEdit={setEditing}
                  onModifiers={setEditingModifiers}
                  onMove={moveItem}
                  onDeleted={() => void reload()}
                />
              ))
            )}
          </div>
        </div>
      </Card>

      {editing && (
        <ItemEditor
          item={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {creating && (
        <ItemEditor
          item={null}
          categories={categories}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void reload();
          }}
        />
      )}
      {editingCategory && (
        <CategoryEditor
          category={editingCategory === "new" ? null : editingCategory}
          onClose={() => setEditingCategory(null)}
          onSaved={() => {
            setEditingCategory(null);
            void reload();
          }}
        />
      )}
      {editingModifiers && (
        <ModifiersEditor
          item={editingModifiers}
          canEdit={canEdit}
          onClose={() => setEditingModifiers(null)}
          onChanged={() => void reload()}
        />
      )}
    </div>
  );
}

function CategoryBlock({
  category,
  items,
  canEdit,
  onToggleAvailability,
  onEdit,
  onModifiers,
  onMove,
  onDeleted,
}: {
  category?: Category;
  items: MenuItem[];
  canEdit: boolean;
  onToggleAvailability: (item: MenuItem) => void;
  onEdit: (item: MenuItem) => void;
  onModifiers: (item: MenuItem) => void;
  onMove: (id: string, direction: "left" | "right") => void;
  onDeleted: () => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center gap-2">
        <span
          className="size-2.5 rounded-full"
          style={{ background: category?.color || "var(--color-ink-faint)" }}
          aria-hidden="true"
        />
        <h2 className="text-[13px] font-bold text-ink">{category?.name ?? "Uncategorised"}</h2>
        <span className="tnum rounded-full bg-paper-sunken px-1.5 text-[10px] font-bold text-ink-faint">{items.length}</span>
        {category && !category.isActive && <Chip tone="neutral">inactive</Chip>}
      </header>

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <article
            key={item.id}
            className={`flex flex-col rounded-xl border bg-paper-raised p-3 transition-colors ${
              item.isAvailable ? "border-rule" : "border-dashed border-rule bg-paper-sunken"
            }`}
          >
            <div className="flex items-start gap-2">
              <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-paper-sunken text-xl">
                {item.emoji || "🍽"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold text-ink">{item.name}</p>
                <p className="line-clamp-1 text-[11px] text-ink-faint">{item.description || "No description"}</p>
                <p className="mt-0.5 text-[11px] text-ink-faint">
                  {COURSE_LABELS[item.course] ?? (item.course || "—")} · {item.station || "No station"} · {item.prepMinutes} min
                </p>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="tnum text-lg font-black text-brand-700">{formatMoney(item.price)}</span>
              <span className="tnum text-[11px] font-semibold text-ink-faint">
                cost {formatMoney(item.cost)} · margin {item.marginPercent.toFixed(0)}%
              </span>
              {item.groups.length > 0 && (
                <Chip tone="info">{item.groups.length} option group{item.groups.length === 1 ? "" : "s"}</Chip>
              )}
              {item.isFeatured && <Chip tone="brand">Featured</Chip>}
            </div>

            {item.allergens && <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-wide text-warn">{item.allergens}</p>}

            <div className="mt-2.5 flex items-center gap-1.5 border-t border-rule pt-2">
              {canEdit ? (
                <>
                  <Button variant={item.isAvailable ? "danger" : "soft"} size="sm" onClick={() => onToggleAvailability(item)}>
                    <Icon name={item.isAvailable ? "close" : "check"} className="size-3.5" />
                    {item.isAvailable ? "86" : "Restore"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onModifiers(item)}>
                    <Icon name="plus" className="size-3.5" />
                    Options
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onEdit(item)}>
                    <Icon name="edit" className="size-3.5" />
                    Edit
                  </Button>
                  <button
                    type="button"
                    onClick={() => onMove(item.id, "left")}
                    aria-label="Move earlier"
                    title="Move earlier"
                    className="ml-auto text-ink-faint transition-colors hover:text-ink"
                  >
                    <Icon name="chevronLeft" className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(item.id, "right")}
                    aria-label="Move later"
                    title="Move later"
                    className="text-ink-faint transition-colors hover:text-ink"
                  >
                    <Icon name="chevronRight" className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await api.del(`menu/items/${item.id}`);
                        toast(`${item.name} deleted`, "neutral");
                        onDeleted();
                      } catch (error) {
                        toast(errorMessage(error), "late");
                      }
                    }}
                    aria-label="Delete dish"
                    title="Delete dish"
                    className="text-ink-faint transition-colors hover:text-late"
                  >
                    <Icon name="trash" className="size-4" />
                  </button>
                </>
              ) : (
                <span className="text-[11px] text-ink-faint">Read-only — you do not hold admin.menu</span>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ItemEditor({
  item,
  categories,
  onClose,
  onSaved,
}: {
  item: MenuItem | null;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: item?.name ?? "",
    categoryId: item?.categoryId ?? "",
    description: item?.description ?? "",
    price: item ? (item.price / 100).toFixed(2) : "0",
    course: item?.course ?? "entree",
    station: item?.station ?? "",
    allergens: item?.allergens ?? "",
    prepMinutes: String(item?.prepMinutes ?? 8),
    emoji: item?.emoji ?? "",
    isAvailable: item?.isAvailable ?? true,
    isFeatured: item?.isFeatured ?? false,
  });
  const [busy, setBusy] = useState(false);
  const patch = (key: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));

  const price = Math.round(Number(form.price) * 100);

  return (
    <Modal
      open
      onClose={onClose}
      title={item ? `Edit ${item.name}` : "New dish"}
      subtitle="The emoji is what the POS grid and the KDS show; the station routes the dish to a kitchen line."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !form.name.trim()}
            onClick={async () => {
              setBusy(true);
              const payload = {
                name: form.name.trim(),
                categoryId: form.categoryId || null,
                description: form.description.trim(),
                price,
                course: form.course,
                station: form.station.trim(),
                allergens: form.allergens.trim(),
                prepMinutes: Number(form.prepMinutes) || 0,
                emoji: form.emoji,
                isAvailable: form.isAvailable,
                isFeatured: form.isFeatured,
              };
              try {
                if (item) await api.patch(`menu/items/${item.id}`, payload);
                else await api.post("menu/items", payload);
                toast(item ? `${payload.name} updated` : `${payload.name} added`, "ok");
                onSaved();
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            {item ? "Save dish" : "Create dish"}
          </Button>
        </>
      }
    >
      <div className="scroll-y flex max-h-[64vh] flex-col gap-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Dish name">
            <TextInput value={form.name} onChange={(value) => patch("name", value)} autoFocus />
          </Field>
          <Field label="Emoji">
            <TextInput value={form.emoji} onChange={(value) => patch("emoji", value)} placeholder="🍛" className="!w-24" />
          </Field>
          <Field label="Category">
            <select className="field" value={form.categoryId} onChange={(event) => patch("categoryId", event.target.value)}>
              <option value="">Uncategorised</option>
              {categories.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Price (Rs)">
            <TextInput value={form.price} onChange={(value) => patch("price", value.replace(/[^\d.]/g, ""))} type="number" step="0.01" className="tnum" />
          </Field>
          <Field label="Course">
            <select className="field" value={form.course} onChange={(event) => patch("course", event.target.value)}>
              {Object.entries(COURSE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Station" hint="Where the kitchen sends this dish.">
            <TextInput value={form.station} onChange={(value) => patch("station", value)} placeholder="grill, bar, pantry…" />
          </Field>
          <Field label="Prep time (minutes)">
            <TextInput value={form.prepMinutes} onChange={(value) => patch("prepMinutes", value.replace(/[^\d.]/g, ""))} type="number" step="1" className="tnum" />
          </Field>
          <Field label="Allergens" hint="Printed verbatim on the KDS prep sheets.">
            <TextInput value={form.allergens} onChange={(value) => patch("allergens", value)} placeholder="gluten, dairy" />
          </Field>
        </div>

        <Field label="Description">
          <textarea
            value={form.description}
            onChange={(event) => patch("description", event.target.value)}
            rows={3}
            className="field resize-y"
            placeholder="Served with…"
          />
        </Field>

        <div className="flex flex-col gap-2">
          <Toggle checked={form.isAvailable} onChange={(value) => patch("isAvailable", value)} label="On the menu — untick to 86 this dish" />
          <Toggle checked={form.isFeatured} onChange={(value) => patch("isFeatured", value)} label="Featured" />
        </div>

        {item && (
          <p className="rounded-lg bg-paper-sunken px-3 py-2 text-[11px] text-ink-faint">
            Margin is {item.marginPercent.toFixed(0)}% and food cost {item.foodCostPercent.toFixed(0)}% at current prices —
            change the ingredients on the Recipes screen to move that.
          </p>
        )}
      </div>
    </Modal>
  );
}

function CategoryEditor({ category, onClose, onSaved }: { category: Category | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(category?.name ?? "");
  const [icon, setIcon] = useState(category?.icon ?? "menu");
  const [color, setColor] = useState(category?.color ?? CATEGORY_COLORS[0]);
  const [isActive, setIsActive] = useState(category?.isActive ?? true);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title={category ? `Edit ${category.name}` : "New category"}
      subtitle="Categories are the rail on the left here, and the groups on the POS grid."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                if (category) await api.patch(`menu/categories/${category.id}`, { name: name.trim(), icon, color, isActive });
                else await api.post("menu/categories", { name: name.trim(), icon, color });
                toast(category ? `${name.trim()} updated` : `${name.trim()} added`, "ok");
                onSaved();
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            {category ? "Save category" : "Create category"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Category name">
          <TextInput value={name} onChange={setName} autoFocus />
        </Field>
        <Field label="Icon">
          <div className="flex flex-wrap gap-1.5">
            {CATEGORY_ICONS.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setIcon(entry)}
                className={`grid size-10 place-items-center rounded-lg border transition-colors ${
                  icon === entry ? "border-brand-500 bg-brand-50 text-brand-700" : "border-rule bg-paper text-ink-soft hover:border-brand-300"
                }`}
                aria-label={entry}
              >
                <Icon name={entry} className="size-5" />
              </button>
            ))}
          </div>
        </Field>
        <Field label="Colour">
          <div className="flex flex-wrap gap-1.5">
            {CATEGORY_COLORS.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setColor(entry)}
                className={`size-8 rounded-full transition-transform ${color === entry ? "outline outline-2 outline-ink outline-offset-2" : ""}`}
                style={{ background: entry }}
                aria-label={`colour ${entry}`}
              />
            ))}
          </div>
        </Field>
        <Toggle checked={isActive} onChange={setIsActive} label="Active — hide a category without deleting its dishes" />
        <p className="rounded-lg bg-paper-sunken px-3 py-2 text-[11px] text-ink-faint">
          Deleting a category only works once it is empty — the server refuses to orphan its dishes.
        </p>
      </div>
    </Modal>
  );
}

/** Groups and their options: a required group is what makes the POS enforce a choice. */
function ModifiersEditor({
  item,
  canEdit,
  onClose,
  onChanged,
}: {
  item: MenuItem;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [groups, setGroups] = useState<MenuItem["groups"]>(item.groups);
  const [groupName, setGroupName] = useState("");
  const [groupMin, setGroupMin] = useState("0");
  const [groupMax, setGroupMax] = useState("1");
  const [groupRequired, setGroupRequired] = useState(false);
  const [optionDraft, setOptionDraft] = useState<Record<string, { name: string; price: string }>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setGroups(item.groups);
    setOptionDraft({});
  }, [item.groups]);

  const run = useCallback(
    async (fn: () => Promise<unknown>, message: string) => {
      setBusy(true);
      try {
        await fn();
        toast(message, "ok");
        const fresh = await api.get<{ item: MenuItem }>(`menu/items/${item.id}`);
        setGroups(fresh.item.groups);
        onChanged();
      } catch (error) {
        toast(errorMessage(error), "late");
      } finally {
        setBusy(false);
      }
    },
    [item.id, onChanged],
  );

  /** Reorder within one group by submitting that group's ids in the new order. */
  const moveOption = (groupId: string, optionId: string, direction: "left" | "right") => {
    const group = groups.find((entry) => entry.id === groupId);
    if (!group) return;
    const ordered = [...group.options].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const index = ordered.findIndex((entry) => entry.id === optionId);
    const swap = direction === "left" ? index - 1 : index + 1;
    if (index === -1 || swap < 0 || swap >= ordered.length) return;
    const ids = ordered.map((entry) => entry.id);
    [ids[index], ids[swap]] = [ids[swap], ids[index]];
    void run(() => api.post(`menu/groups/${groupId}/options/reorder`, { ids }), "Order updated");
  };

  const moveGroup = (groupId: string, direction: "left" | "right") => {
    const ordered = [...groups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const index = ordered.findIndex((entry) => entry.id === groupId);
    const swap = direction === "left" ? index - 1 : index + 1;
    if (index === -1 || swap < 0 || swap >= ordered.length) return;
    const ids = ordered.map((entry) => entry.id);
    [ids[index], ids[swap]] = [ids[swap], ids[index]];
    void run(() => api.post(`menu/items/${item.id}/groups/reorder`, { ids }), "Order updated");
  };

  const totalOptionValue = groups.reduce(
    (sum, group) => sum + group.options.reduce((inner, option) => inner + option.price, 0),
    0,
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={`Options — ${item.name}`}
      subtitle="A required group with a minimum of one stops the ticket from being sent until a choice is made."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {canEdit && (
            <Button
              variant="primary"
              disabled={busy || !groupName.trim()}
              onClick={() =>
                void run(
                  () =>
                    api.post(`menu/items/${item.id}/groups`, {
                      name: groupName.trim(),
                      minSelect: Number(groupMin) || 0,
                      maxSelect: Number(groupMax) || 1,
                      isRequired: groupRequired,
                    }),
                  `${groupName.trim()} added`,
                )
              }
            >
              <Icon name="plus" className="size-4" />
              Add group
            </Button>
          )}
        </>
      }
    >
      <div className="scroll-y flex max-h-[64vh] flex-col gap-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Groups" value={String(groups.length)} />
          <Stat label="Options" value={String(groups.flatMap((group) => group.options).length)} />
          <Stat label="Required" value={String(groups.filter((group) => group.isRequired).length)} tone="var(--color-warn)" />
          <Stat label="Sum of options" value={formatMoneyShort(totalOptionValue)} />
        </div>

        {groups.length === 0 ? (
          <Empty
            title="This dish takes no options"
            hint="Add a group — size, doneness, extras — and the POS starts asking for a choice."
            icon="plus"
          />
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((group, groupIndex) => (
              <section key={group.id} className="rounded-xl border border-rule bg-paper px-3 py-2.5">
                <header className="flex flex-wrap items-center gap-2">
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        disabled={busy || groupIndex === 0}
                        onClick={() => moveGroup(group.id, "left")}
                        aria-label="Move group earlier"
                        className="text-ink-faint transition-colors enabled:hover:text-ink"
                      >
                        <Icon name="chevronLeft" className="size-4" />
                      </button>
                      <button
                        type="button"
                        disabled={busy || groupIndex === groups.length - 1}
                        onClick={() => moveGroup(group.id, "right")}
                        aria-label="Move group later"
                        className="text-ink-faint transition-colors enabled:hover:text-ink"
                      >
                        <Icon name="chevronRight" className="size-4" />
                      </button>
                    </>
                  )}
                  <span className="text-[13px] font-bold text-ink">{group.name}</span>
                  <Chip tone={group.isRequired ? "warn" : "neutral"}>{group.isRequired ? "Required" : "Optional"}</Chip>
                  <span className="tnum text-[11px] text-ink-faint">
                    Pick {group.minSelect}–{group.maxSelect}
                  </span>
                  <span className="ml-auto text-[11px] text-ink-faint">group {groupIndex + 1}</span>
                  {canEdit && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => api.del(`menu/groups/${group.id}`), `${group.name} removed`)}
                      className="text-ink-faint transition-colors hover:text-late"
                      aria-label={`Remove ${group.name}`}
                    >
                      <Icon name="trash" className="size-4" />
                    </button>
                  )}
                </header>

                <p className="mt-1 text-[11px] text-ink-faint">
                  {group.isRequired && group.minSelect > 0
                    ? `The POS will not let this ticket be sent until ${group.minSelect} ${group.minSelect === 1 ? "choice is" : "choices are"} made.`
                    : group.isRequired
                      ? "Guests must pick from these."
                      : "Guests may add any of these."}
                  {group.minSelect > group.maxSelect && " A minimum above the maximum can never be satisfied."}
                </p>

                {group.options.length === 0 ? (
                  <p className="mt-1.5 rounded-lg bg-paper-sunken px-3 py-2 text-center text-[11px] text-ink-faint">
                    No options yet — the group is empty, so the POS treats it as unselectable.
                  </p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-1">
                    {group.options.map((option, optionIndex) => (
                      <li key={option.id} className="flex items-center gap-1.5 rounded-lg border border-rule bg-paper-raised px-2 py-1.5">
                        {canEdit && (
                          <>
                            <button
                              type="button"
                              disabled={busy || optionIndex === 0}
                              onClick={() => moveOption(group.id, option.id, "left")}
                              aria-label="Move earlier"
                              className="text-ink-faint transition-colors enabled:hover:text-ink"
                            >
                              <Icon name="chevronLeft" className="size-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={busy || optionIndex === group.options.length - 1}
                              onClick={() => moveOption(group.id, option.id, "right")}
                              aria-label="Move later"
                              className="text-ink-faint transition-colors enabled:hover:text-ink"
                            >
                              <Icon name="chevronRight" className="size-3.5" />
                            </button>
                          </>
                        )}
                        <span className="flex-1 text-[12px] font-semibold text-ink">{option.name}</span>
                        {option.isDefault && <Chip tone="brand">default</Chip>}
                        {!option.isAvailable && <Chip tone="neutral">hidden</Chip>}
                        <span className="tnum text-[12px] font-bold text-brand-700">
                          {option.price > 0 ? `+${formatMoney(option.price)}` : "included"}
                        </span>
                        {canEdit && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void run(() => api.del(`menu/options/${option.id}`), `${option.name} removed`)}
                            className="text-ink-faint transition-colors hover:text-late"
                            aria-label={`Remove ${option.name}`}
                          >
                            <Icon name="trash" className="size-3.5" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {canEdit && (
                  <div className="mt-2 grid items-end gap-2 border-t border-rule pt-2 sm:grid-cols-[minmax(0,1fr)_110px_auto]">
                    <Field label="New option">
                      <TextInput
                        value={optionDraft[group.id]?.name ?? ""}
                        onChange={(value) =>
                          setOptionDraft((current) => ({ ...current, [group.id]: { ...current[group.id], name: value } }))
                        }
                        placeholder="Extra cheese…"
                        className="!py-1.5 text-[12px]"
                      />
                    </Field>
                    <Field label="Extra price">
                      <TextInput
                        value={optionDraft[group.id]?.price ?? "0"}
                        onChange={(value) =>
                          setOptionDraft((current) => ({
                            ...current,
                            [group.id]: { name: optionDraft[group.id]?.name ?? "", price: value.replace(/[^\d.]/g, "") },
                          }))
                        }
                        type="number"
                        step="0.01"
                        className="tnum !py-1.5 text-[12px]"
                      />
                    </Field>
                    <Button
                      variant="soft"
                      size="sm"
                      disabled={busy || !(optionDraft[group.id]?.name ?? "").trim()}
                      onClick={() =>
                        void run(
                          () =>
                            api.post(`menu/groups/${group.id}/options`, {
                              name: optionDraft[group.id]?.name.trim(),
                              price: Math.round(Number(optionDraft[group.id]?.price ?? 0) * 100),
                              isDefault: false,
                            }),
                          `${optionDraft[group.id]?.name} added`,
                        )
                      }
                    >
                      <Icon name="plus" className="size-3.5" />
                      Add
                    </Button>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}

        {canEdit && (
          <div className="rounded-xl border border-dashed border-rule bg-paper-sunken/50 px-3 py-2.5">
            <p className="label">New option group</p>
            <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_70px_70px_auto]">
              <Field label="Group name">
                <TextInput value={groupName} onChange={setGroupName} placeholder="Size, doneness…" className="!py-1.5 text-[12px]" />
              </Field>
              <Field label="Min">
                <TextInput value={groupMin} onChange={setGroupMin} type="number" step="1" className="tnum !py-1.5 text-[12px]" />
              </Field>
              <Field label="Max">
                <TextInput value={groupMax} onChange={setGroupMax} type="number" step="1" className="tnum !py-1.5 text-[12px]" />
              </Field>
              <div className="flex items-center pb-1">
                <Toggle checked={groupRequired} onChange={setGroupRequired} label="Required" />
              </div>
            </div>
            {Number(groupMax) > 0 && Number(groupMin) > Number(groupMax) && (
              <p className="mt-1 text-[11px] font-semibold text-warn">
                A minimum above the maximum will never be satisfiable — set min to 0 or raise max.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-rule bg-paper px-2.5 py-1.5">
      <p className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="tnum truncate text-[14px] font-black" style={{ color: tone ?? "var(--color-ink)" }}>
        {value}
      </p>
    </div>
  );
}
