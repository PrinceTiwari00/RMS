"use client";

/**
 * Screen 12 — Inventory Dashboard.
 *
 * The point of this screen is not "what do we have" but "what will run out
 * before the delivery arrives". So every row carries days of cover and a
 * reorder point that was actually derived from that item's own usage and lead
 * time, and the health badge follows from those rather than from a hand-set
 * threshold.
 *
 * Stock is only ever changed through the ledger — a manual adjustment, a waste
 * entry, a received purchase order or a sale deducting through the BOM. Nothing
 * here edits a quantity directly, which is what keeps theoretical and counted
 * stock comparable later.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, errorMessage, qs } from "@/lib/api";
import { usePoll, useStore } from "@/lib/store";
import { Button, Card, Chip, Empty, Field, Icon, Meter, Modal, TextInput, Toggle, toast } from "@/components/ui";
import { formatMoney, formatMoneyShort, formatQuantity } from "@/domain/money";
import { formatDay } from "@/domain/time";
import type { InventoryItem } from "@/types";

interface InventoryMetrics {
  items: number;
  totalValue: number;
  lowStock: number;
  outOfStock: number;
  needsOrder: number;
  categories: number;
  lowList: InventoryItem[];
}

interface InventoryResponse {
  items: InventoryItem[];
  metrics: InventoryMetrics;
  categories: string[];
  reasons: string[];
}

interface LedgerEntry {
  id: string;
  itemName: string;
  unit: string;
  delta: number;
  reason: string;
  referenceId: string | null;
  actor: string;
  createdAt: string;
}

interface ItemDetail {
  item: InventoryItem;
  ledger: LedgerEntry[];
  usedIn: { menuItemId: string; itemName: string; quantityRequired: number; unit: string }[];
}

const HEALTH_META: Record<InventoryItem["health"], { label: string; tone: "ok" | "warn" | "late" | "info" }> = {
  ok: { label: "Healthy", tone: "ok" },
  watch: { label: "Watch", tone: "info" },
  low: { label: "Reorder", tone: "warn" },
  out: { label: "Out", tone: "late" },
};

const HEALTH_FILTERS = [
  { id: "all", label: "All" },
  { id: "out", label: "Out of stock" },
  { id: "low", label: "Below reorder" },
  { id: "watch", label: "Watch" },
  { id: "ok", label: "Healthy" },
];

const ADJUST_REASONS = [
  { id: "restock", label: "Restock received", sign: 1 },
  { id: "correction", label: "Count correction", sign: 0 },
  { id: "transfer", label: "Transfer between stores", sign: 0 },
  { id: "spillage", label: "Spillage / damage", sign: -1 },
];

export default function InventoryPage() {
  const { allowed } = useStore();
  const canEdit = allowed("admin.inventory");

  const [health, setHealth] = useState("all");
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editing, setEditing] = useState<InventoryItem | "new" | null>(null);

  const query = qs({ health, category, search });
  const { data, reload } = usePoll<InventoryResponse>(`inventory?${query}`, { interval: 20000 });

  const items = data?.items ?? [];
  const metrics = data?.metrics;

  const totalValue = useMemo(() => items.reduce((sum, item) => sum + item.stockValue, 0), [items]);
  const needsOrder = useMemo(() => items.filter((item) => item.orderPacks > 0), [items]);

  const openDetail = useCallback((id: string) => setDetailId(id), []);

  if (!data) {
    return (
      <div className="p-6">
        <Empty title="Loading inventory…" icon="inventory" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-[19px] font-extrabold text-ink">Inventory</h1>
          <p className="text-[12px] text-ink-faint">
            Reorder points are derived from each item's own usage and supplier lead time, not set by hand.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {allowed("admin.purchasing") && (
            <Link href="/admin/vendors" className="btn btn-soft">
              <Icon name="vendor" className="size-4" />
              Purchase orders
              {metrics?.needsOrder ? <span className="tnum ml-1 rounded-full bg-warn px-1.5 text-[10px] text-white">{metrics.needsOrder}</span> : null}
            </Link>
          )}
          {canEdit && (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Icon name="plus" className="size-4" />
              New item
            </Button>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------------- metrics */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Stock value</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{formatMoneyShort(metrics?.totalValue ?? 0)}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            {metrics?.items ?? 0} items across {metrics?.categories ?? 0} categories
          </p>
        </Card>
        <Card accent="var(--color-late)">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Out of stock</p>
          <p className="tnum mt-1 text-2xl font-black text-late">{metrics?.outOfStock ?? 0}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Dishes using these are 86'd automatically</p>
        </Card>
        <Card accent="var(--color-warn)">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Low or watch</p>
          <p className="tnum mt-1 text-2xl font-black text-warn">{metrics?.lowStock ?? 0}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">At or below their reorder point</p>
        </Card>
        <Card accent="var(--color-brand-500)">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">To order</p>
          <p className="tnum mt-1 text-2xl font-black text-brand-600">{metrics?.needsOrder ?? 0}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Suggested pack quantities ready</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">This view</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{formatMoneyShort(totalValue)}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">{items.length} items after filtering</p>
        </Card>
      </div>

      {/* ---------------------------------------------------------------- filters */}
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2.5">
          <div className="relative">
            <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search items, SKUs, vendors…"
              aria-label="Search inventory"
              className="w-64 rounded-lg border border-rule bg-paper-raised py-1.5 pl-8 pr-2.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-brand-400 focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap gap-1">
            {HEALTH_FILTERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setHealth(entry.id)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
                  health === entry.id ? "bg-ink text-white" : "bg-paper-sunken text-ink-soft hover:bg-rule"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <select
            className="field !w-auto !py-1.5 text-[12px]"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-label="Filter by category"
          >
            <option value="all">All categories</option>
            {data.categories.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>

          <span className="tnum ml-auto text-[12px] font-semibold text-ink-faint">{items.length} items</span>
        </div>

        {items.length === 0 ? (
          <Empty title="No items match those filters" hint="Clear the search or pick another category." icon="inventory" />
        ) : (
          <div className="scroll-x">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Par / reorder</th>
                  <th className="w-32">Cover</th>
                  <th className="text-right">Unit cost</th>
                  <th className="text-right">Stock value</th>
                  <th className="text-right">To order</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="cursor-pointer" onClick={() => openDetail(item.id)}>
                    <td>
                      <span className="block font-semibold text-ink">{item.name}</span>
                      <span className="block text-[11px] text-ink-faint">
                        {item.sku || "no SKU"} · {item.vendorName || "no vendor"}
                        {item.storageLocation ? ` · ${item.storageLocation}` : ""}
                      </span>
                    </td>
                    <td className="text-[12px] text-ink-soft">{item.category}</td>
                    <td className="tnum text-right font-bold text-ink">
                      {formatQuantity(item.currentStock, 2)}
                      <span className="ml-1 text-[11px] font-normal text-ink-faint">{item.unit}</span>
                    </td>
                    <td className="tnum text-right text-[12px] text-ink-faint">
                      {formatQuantity(item.parLevel, 1)} / {formatQuantity(item.reorderPoint, 1)}
                    </td>
                    <td>
                      <span className="flex items-center gap-1.5">
                        <Meter
                          value={Math.min(item.daysOfCover, 14)}
                          max={14}
                          tone={item.daysOfCover < 1 ? "var(--color-late)" : item.daysOfCover < 3 ? "var(--color-warn)" : "var(--color-ok)"}
                        />
                        <span className="tnum w-10 shrink-0 text-right text-[11px] font-bold text-ink-soft">
                          {item.daysOfCover >= 99 ? "∞" : `${item.daysOfCover.toFixed(1)}d`}
                        </span>
                      </span>
                    </td>
                    <td className="tnum text-right">{formatMoney(item.unitCost)}</td>
                    <td className="tnum text-right font-bold">{formatMoney(item.stockValue)}</td>
                    <td className="tnum text-right">
                      {item.orderPacks > 0 ? (
                        <span className="font-black text-warn">
                          {formatQuantity(item.orderPacks, 0)} pack{item.orderPacks === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td>
                      <Chip tone={HEALTH_META[item.health].tone}>
                        {HEALTH_META[item.health].label}
                        {item.recipesUsedIn > 0 && ` · ${item.recipesUsedIn} recipes`}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {needsOrder.length > 0 && (
        <Card
          title="Suggested order"
          icon="vendor"
          subtitle="Quantities rounded up to whole packs, covering lead time plus safety stock."
          accent="var(--color-warn)"
          action={
            allowed("admin.purchasing") ? (
              <Link href="/admin/vendors" className="btn btn-primary">
                <Icon name="plus" className="size-4" />
                Raise a purchase order
              </Link>
            ) : undefined
          }
        >
          <div className="flex flex-wrap gap-1.5">
            {needsOrder.slice(0, 24).map((item) => (
              <span
                key={item.id}
                className="flex items-center gap-1.5 rounded-lg border border-rule bg-paper px-2.5 py-1 text-[12px]"
              >
                <span className="font-semibold text-ink">{item.name}</span>
                <span className="tnum text-ink-faint">
                  {formatQuantity(item.currentStock, 1)} of {formatQuantity(item.parLevel, 1)} {item.unit}
                </span>
                <span className="tnum font-black text-warn">{formatQuantity(item.orderPacks, 0)} × {formatQuantity(item.packSize, 0)}</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      <ItemDetailModal
        itemId={detailId}
        canEdit={canEdit}
        reasons={data.reasons}
        onClose={() => setDetailId(null)}
        onChanged={async () => {
          await reload();
        }}
        onEdit={(item) => {
          setDetailId(null);
          setEditing(item);
        }}
      />

      {editing && (
        <ItemEditor
          item={editing === "new" ? null : editing}
          categories={data.categories}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

/** Drill-down: the ledger behind one item, and every recipe that consumes it. */
function ItemDetailModal({
  itemId,
  canEdit,
  reasons,
  onClose,
  onChanged,
  onEdit,
}: {
  itemId: string | null;
  canEdit: boolean;
  reasons: string[];
  onClose: () => void;
  onChanged: () => void;
  onEdit: (item: InventoryItem) => void;
}) {
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("restock");
  const [busy, setBusy] = useState(false);

  // Fetch on open — the ledger is long and only worth loading when asked for.
  useEffect(() => {
    if (!itemId) {
      setDetail(null);
      return;
    }
    let live = true;
    void api
      .get<ItemDetail>(`inventory/items/${itemId}`)
      .then((response) => {
        if (live) setDetail(response);
      })
      .catch((error) => {
        if (live) toast(errorMessage(error), "late");
      });
    return () => {
      live = false;
    };
  }, [itemId]);

  if (!itemId) return null;
  const item = detail?.item;

  return (
    <Modal
      open
      onClose={onClose}
      title={item?.name ?? "Loading item…"}
      subtitle={item ? `${item.category} · ${item.sku || "no SKU"} · ${item.vendorName || "no vendor"}` : undefined}
      width="max-w-3xl"
      footer={
        item && canEdit ? (
          <>
            <Button variant="ghost" onClick={() => onEdit(item)}>
              <Icon name="edit" className="size-4" />
              Edit item
            </Button>
            <Button variant="primary" onClick={() => setAdjusting((current) => !current)}>
              <Icon name="inventory" className="size-4" />
              {adjusting ? "Cancel adjustment" : "Adjust stock"}
            </Button>
          </>
        ) : undefined
      }
    >
      {adjusting && item && (
        <div className="mb-3 rounded-xl border border-brand-300 bg-brand-50 px-3 py-2.5">
          <p className="label">Record a stock movement</p>
          <p className="mb-2 text-[11px] text-ink-faint">
            Movements go to the ledger with your name against them. On hand is {formatQuantity(item.currentStock, 2)} {item.unit}.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Reason">
              <select className="field" value={reason} onChange={(event) => setReason(event.target.value)}>
                {ADJUST_REASONS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
                {reasons
                  .filter((entry) => !ADJUST_REASONS.some((known) => known.id === entry))
                  .map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={`Quantity (${item.unit})`} hint="Negative removes stock, positive adds it.">
              <TextInput value={delta} onChange={setDelta} type="number" step="0.01" className="tnum" placeholder="e.g. -2.5" />
            </Field>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !delta.trim() || Number(delta) === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.post(`inventory/items/${item.id}/adjust`, { delta: Number(delta), reason });
                  toast(`Stock adjusted by ${formatQuantity(Number(delta), 2)} ${item.unit}`, "ok");
                  setDelta("");
                  setAdjusting(false);
                  onChanged();
                  const fresh = await api.get<ItemDetail>(`inventory/items/${item.id}`);
                  setDetail(fresh);
                } catch (error) {
                  toast(errorMessage(error), "late");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Post movement
            </Button>
            {Number(delta) !== 0 && (
              <span className="tnum text-[12px] text-ink-soft">
                → {formatQuantity(item.currentStock + Number(delta), 2)} {item.unit}
              </span>
            )}
          </div>
        </div>
      )}

      {!detail ? (
        <Empty title="Loading…" icon="inventory" />
      ) : (
        <div className="scroll-y flex max-h-[62vh] flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Mini label="On hand" value={`${formatQuantity(item!.currentStock, 2)} ${item!.unit}`} />
            <Mini label="Stock value" value={formatMoney(item!.stockValue)} />
            <Mini label="Days of cover" value={item!.daysOfCover >= 99 ? "∞" : `${item!.daysOfCover.toFixed(1)} days`} />
            <Mini label="Reorder point" value={`${formatQuantity(item!.reorderPoint, 2)} ${item!.unit}`} />
            <Mini label="Safety stock" value={`${formatQuantity(item!.safetyStock, 2)} ${item!.unit}`} />
            <Mini label="Par level" value={`${formatQuantity(item!.parLevel, 2)} ${item!.unit}`} />
            <Mini label="Usage" value={`${formatQuantity(item!.avgDailyUsage, 2)}/${formatQuantity(item!.maxDailyUsage, 2)} per day`} />
            <Mini label="Lead time" value={`${item!.leadTimeDays}–${item!.maxLeadTimeDays} days`} />
          </div>

          <div>
            <p className="label">Used in {detail.usedIn.length} recipe{detail.usedIn.length === 1 ? "" : "s"}</p>
            {detail.usedIn.length === 0 ? (
              <p className="text-[12px] text-ink-faint">Nothing on the menu consumes this item directly.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {detail.usedIn.map((recipe) => (
                  <span key={recipe.menuItemId} className="rounded-full border border-rule bg-paper px-2.5 py-1 text-[12px]">
                    <span className="font-semibold text-ink">{recipe.itemName}</span>
                    <span className="tnum ml-1.5 text-ink-faint">
                      {formatQuantity(recipe.quantityRequired, 3)} {recipe.unit}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="label">Recent ledger</p>
            {detail.ledger.length === 0 ? (
              <p className="text-[12px] text-ink-faint">No movements recorded.</p>
            ) : (
              <div className="scroll-y max-h-56 overflow-auto rounded-lg border border-rule">
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Reason</th>
                      <th className="text-right">Movement</th>
                      <th>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.ledger.map((entry) => (
                      <tr key={entry.id}>
                        <td className="tnum whitespace-nowrap text-[11px] text-ink-faint">
                          {formatDay(entry.createdAt)} {entry.createdAt.slice(11, 16)}
                        </td>
                        <td className="text-[12px]">{entry.reason}</td>
                        <td
                          className="tnum text-right font-bold"
                          style={{ color: entry.delta < 0 ? "var(--color-late)" : "var(--color-ok)" }}
                        >
                          {entry.delta > 0 ? "+" : ""}
                          {formatQuantity(entry.delta, 2)} {entry.unit}
                        </td>
                        <td className="truncate text-[11px] text-ink-faint">{entry.actor || "system"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-rule bg-paper px-2.5 py-1.5">
      <p className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="tnum truncate text-[13px] font-bold text-ink">{value}</p>
    </div>
  );
}

/** Create or edit an item. Reorder point and safety stock are derived, not typed. */
function ItemEditor({
  item,
  categories,
  onClose,
  onSaved,
}: {
  item: InventoryItem | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    sku: item?.sku ?? "",
    name: item?.name ?? "",
    category: item?.category ?? categories[0] ?? "",
    unit: item?.unit ?? "kg",
    currentStock: String(item?.currentStock ?? 0),
    unitCost: item ? (item.unitCost / 100).toFixed(2) : "0",
    storageLocation: item?.storageLocation ?? "",
    avgDailyUsage: String(item?.avgDailyUsage ?? 0),
    maxDailyUsage: String(item?.maxDailyUsage ?? 0),
    leadTimeDays: String(item?.leadTimeDays ?? 2),
    maxLeadTimeDays: String(item?.maxLeadTimeDays ?? 3),
    parLevel: String(item?.parLevel ?? 0),
    packSize: String(item?.packSize ?? 1),
    lowStockThreshold: String(item?.lowStockThreshold ?? 0),
    vendorId: item?.vendorId ?? "",
    isActive: item?.isActive ?? true,
  });
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api
      .get<{ vendors: { id: string; name: string }[] }>("vendors")
      .then((response) => {
        if (live) setVendors(response.vendors);
      })
      .catch(() => {
        /* vendor is optional */
      });
    return () => {
      live = false;
    };
  }, []);

  const patch = (key: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));

  return (
    <Modal
      open
      onClose={onClose}
      title={item ? `Edit ${item.name}` : "New inventory item"}
      subtitle="Usage and lead time drive the reorder point — set those accurately and the ordering suggestions follow."
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
                ...form,
                name: form.name.trim(),
                unitCost: Math.round(Number(form.unitCost) * 100),
                currentStock: Number(form.currentStock) || 0,
                avgDailyUsage: Number(form.avgDailyUsage) || 0,
                maxDailyUsage: Number(form.maxDailyUsage) || 0,
                leadTimeDays: Number(form.leadTimeDays) || 0,
                maxLeadTimeDays: Number(form.maxLeadTimeDays) || 0,
                parLevel: Number(form.parLevel) || 0,
                packSize: Number(form.packSize) || 1,
                lowStockThreshold: Number(form.lowStockThreshold) || 0,
                vendorId: form.vendorId || null,
              };
              try {
                if (item) await api.patch(`inventory/items/${item.id}`, payload);
                else await api.post("inventory/items", payload);
                toast(item ? `${payload.name} updated` : `${payload.name} added`, "ok");
                onSaved();
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            {item ? "Save changes" : "Create item"}
          </Button>
        </>
      }
    >
      <div className="scroll-y flex max-h-[62vh] flex-col gap-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Name">
            <TextInput value={form.name} onChange={(value) => patch("name", value)} placeholder="e.g. Basmati rice" autoFocus />
          </Field>
          <Field label="SKU">
            <TextInput value={form.sku} onChange={(value) => patch("sku", value)} placeholder="Auto-generated if blank" />
          </Field>
          <Field label="Category">
            <input
              className="field"
              list="inventory-categories"
              value={form.category}
              onChange={(event) => patch("category", event.target.value)}
              placeholder="Produce, Dairy, Dry store…"
            />
            <datalist id="inventory-categories">
              {categories.map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
          </Field>
          <Field label="Unit">
            <input
              className="field"
              list="inventory-units"
              value={form.unit}
              onChange={(event) => patch("unit", event.target.value)}
            />
            <datalist id="inventory-units">
              {["kg", "g", "ltr", "ml", "pcs", "bundle", "bottle", "tin"].map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
          </Field>
          <Field label="Storage location">
            <TextInput value={form.storageLocation} onChange={(value) => patch("storageLocation", value)} placeholder="Cold room shelf 2" />
          </Field>
          <Field label="Supplier">
            <select className="field" value={form.vendorId} onChange={(event) => patch("vendorId", event.target.value)}>
              <option value="">No supplier</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="On hand">
            <TextInput value={form.currentStock} onChange={(value) => patch("currentStock", value)} type="number" step="0.01" className="tnum" />
          </Field>
          <Field label="Unit cost (Rs)">
            <TextInput value={form.unitCost} onChange={(value) => patch("unitCost", value)} type="number" step="0.01" className="tnum" />
          </Field>
          <Field label="Pack size">
            <TextInput value={form.packSize} onChange={(value) => patch("packSize", value)} type="number" step="1" min="1" className="tnum" />
          </Field>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Avg daily usage" hint="Drives the reorder point.">
            <TextInput value={form.avgDailyUsage} onChange={(value) => patch("avgDailyUsage", value)} type="number" step="0.01" className="tnum" />
          </Field>
          <Field label="Max daily usage" hint="Worst-case day, for safety stock.">
            <TextInput value={form.maxDailyUsage} onChange={(value) => patch("maxDailyUsage", value)} type="number" step="0.01" className="tnum" />
          </Field>
          <Field label="Par level">
            <TextInput value={form.parLevel} onChange={(value) => patch("parLevel", value)} type="number" step="0.01" className="tnum" />
          </Field>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Lead time (days)">
            <TextInput value={form.leadTimeDays} onChange={(value) => patch("leadTimeDays", value)} type="number" step="1" className="tnum" />
          </Field>
          <Field label="Max lead time (days)">
            <TextInput value={form.maxLeadTimeDays} onChange={(value) => patch("maxLeadTimeDays", value)} type="number" step="1" className="tnum" />
          </Field>
          <Field label="Low-stock threshold" hint="Optional override.">
            <TextInput value={form.lowStockThreshold} onChange={(value) => patch("lowStockThreshold", value)} type="number" step="0.01" className="tnum" />
          </Field>
        </div>

        <Toggle checked={form.isActive} onChange={(value) => patch("isActive", value)} label="Active — included in ordering and costing" />

        <p className="rounded-lg bg-paper-sunken px-3 py-2 text-[11px] leading-snug text-ink-faint">
          Par level must sit above the reorder point. Safety stock is derived from max daily usage across the maximum
          lead time, so an item that spikes at festival needs its max usage set honestly.
        </p>
      </div>
    </Modal>
  );
}
