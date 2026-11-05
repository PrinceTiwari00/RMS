"use client";

/**
 * Screen 13 — Recipe Costing & Bill of Materials.
 *
 * Food cost is the only one of the two prime costs that is invisible day to day,
 * so this screen exists to make it concrete: every dish's ingredient list priced
 * at today's unit costs, against what it sells for.
 *
 * The distinction that matters is theoretical versus stored cost. The stored
 * figure is what the menu item was last costed at; the theoretical figure is
 * what its BOM is worth right now. When they diverge, the menu price was set
 * against an ingredient price that no longer exists, and the margin on the
 * executive dashboard is quietly wrong. This screen surfaces that drift instead
 * of hiding it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, qs } from "@/lib/api";
import { usePoll, useStore } from "@/lib/store";
import { Button, Card, Chip, Empty, Field, Icon, Meter, Modal, TextInput, toast } from "@/components/ui";
import { formatMoney, formatMoneyShort, formatQuantity } from "@/domain/money";
import type { InventoryItem, RecipeComponent, RecipeCosting } from "@/types";

interface RecipeTotals {
  items: number;
  costed: number;
  missing: number;
  averageMargin: number;
  averageFoodCost: number;
}

interface RecipesResponse {
  costing: RecipeCosting[];
  totals: RecipeTotals;
  categories: string[];
}

interface RecipeDetail {
  costing: RecipeCosting;
  components: RecipeComponent[];
}

/** Above this food-cost percentage a dish is no longer paying for the room. */
const FOOD_COST_CEILING = 40;
const FOOD_COST_TARGET = 34;

export default function RecipesPage() {
  const { state, allowed } = useStore();
  const canEdit = allowed("admin.recipes");

  const [search, setSearch] = useState("");
  const [station, setStation] = useState("all");
  const [onlyDrift, setOnlyDrift] = useState(false);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [busyRecost, setBusyRecost] = useState<string | null>(null);

  const { data, reload } = usePoll<RecipesResponse>(`recipes?${qs({ search, station })}`, { interval: 30000 });
  const rows = data?.costing ?? [];
  const totals = data?.totals;
  const stations = state?.stations ?? [];

  /** Items whose stored cost has drifted from what their BOM is worth now. */
  const drifted = useMemo(
    () => rows.filter((row) => row.components.length > 0 && Math.abs(row.storedCost - row.theoreticalCost) > 100),
    [rows],
  );
  const visible = useMemo(() => (onlyDrift ? drifted : rows), [onlyDrift, drifted, rows]);

  const recost = useCallback(
    async (menuItemId: string, itemName: string) => {
      setBusyRecost(menuItemId);
      try {
        const result = await api.post<{ cost: number }>(`menu/items/${menuItemId}/recost`, {});
        toast(`${itemName} recosted to ${formatMoney(result.cost)}`, "ok");
        await reload();
      } catch (error) {
        toast(errorMessage(error), "late");
      } finally {
        setBusyRecost(null);
      }
    },
    [reload],
  );

  const recostAll = useCallback(async () => {
    setBusyRecost("all");
    try {
      for (const row of drifted) {
        await api.post(`menu/items/${row.menuItemId}/recost`, {});
      }
      toast(`Recosted ${drifted.length} dish(es) from their current ingredient prices`, "ok");
      await reload();
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusyRecost(null);
    }
  }, [drifted, reload]);

  if (!data) {
    return (
      <div className="p-6">
        <Empty title="Loading recipe costs…" icon="recipe" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-[19px] font-extrabold text-ink">Recipe Costing</h1>
          <p className="text-[12px] text-ink-faint">
            Ingredient cost from each dish's bill of materials, priced at today's unit costs.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {drifted.length > 0 && canEdit && (
            <Button variant="soft" disabled={busyRecost !== null} onClick={() => void recostAll()}>
              <Icon name="refresh" className="size-4" />
              Recost {drifted.length} drifted dish{drifted.length === 1 ? "" : "es"}
            </Button>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------------- totals */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Menu items</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{totals?.items ?? 0}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">{totals?.costed ?? 0} have a bill of materials</p>
        </Card>
        <Card accent={totals?.missing ? "var(--color-late)" : "var(--color-ok)"}>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Uncosted</p>
          <p className="tnum mt-1 text-2xl font-black" style={{ color: totals?.missing ? "var(--color-late)" : "var(--color-ok)" }}>
            {totals?.missing ?? 0}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Selling with no known ingredient cost</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Average margin</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{(totals?.averageMargin ?? 0).toFixed(1)}%</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Across every costed dish</p>
        </Card>
        <Card accent={(totals?.averageFoodCost ?? 0) > FOOD_COST_TARGET ? "var(--color-warn)" : "var(--color-ok)"}>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Average food cost</p>
          <p
            className="tnum mt-1 text-2xl font-black"
            style={{ color: (totals?.averageFoodCost ?? 0) > FOOD_COST_CEILING ? "var(--color-late)" : "var(--color-ink)" }}
          >
            {(totals?.averageFoodCost ?? 0).toFixed(1)}%
          </p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Target {FOOD_COST_TARGET}% or better</p>
        </Card>
        <Card accent={drifted.length ? "var(--color-warn)" : "var(--color-ok)"}>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Cost drift</p>
          <p className="tnum mt-1 text-2xl font-black" style={{ color: drifted.length ? "var(--color-warn)" : "var(--color-ok)" }}>
            {drifted.length}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Stored cost no longer matches the BOM</p>
        </Card>
      </div>

      {drifted.length > 0 && (
        <Card accent="var(--color-warn)">
          <p className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-soft">
            <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-warn" />
            <span>
              <strong className="text-ink">{drifted.length} dish(es) are priced against ingredient costs that have since moved.</strong>{" "}
              Their stored cost is what the menu was built on; the theoretical cost is what the same recipe is worth at
              today's prices. Until they are recosted, every margin figure on the executive dashboard is understated or
              overstated by the difference —{" "}
              <strong className="tnum">
                {formatMoney(drifted.reduce((sum, row) => sum + Math.abs(row.theoreticalCost - row.storedCost), 0))}
              </strong>{" "}
              in total.
            </span>
          </p>
        </Card>
      )}

      {/* --------------------------------------------------------------- filters */}
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2.5">
          <div className="relative">
            <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search dishes…"
              aria-label="Search recipes"
              className="w-56 rounded-lg border border-rule bg-paper-raised py-1.5 pl-8 pr-2.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-brand-400 focus:outline-none"
            />
          </div>

          <select className="field !w-auto !py-1.5 text-[12px]" value={station} onChange={(event) => setStation(event.target.value)} aria-label="Filter by station">
            <option value="all">All stations</option>
            {stations.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setOnlyDrift((current) => !current)}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
              onlyDrift ? "bg-warn text-white" : "bg-paper-sunken text-ink-soft hover:bg-rule"
            }`}
            aria-pressed={onlyDrift}
          >
            <Icon name="alert" className="size-3.5" />
            Only drifted costs
          </button>

          <span className="tnum ml-auto text-[12px] font-semibold text-ink-faint">{visible.length} dishes</span>
        </div>

        {visible.length === 0 ? (
          <Empty
            title={onlyDrift ? "No cost drift — every stored cost matches its BOM" : "No dishes match that filter"}
            icon="recipe"
          />
        ) : (
          <div className="scroll-x">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Dish</th>
                  <th className="text-right">Sells for</th>
                  <th className="text-right">Ingredient cost</th>
                  <th className="text-right">Margin</th>
                  <th className="w-32">Food cost</th>
                  <th className="text-right">Components</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const drift = row.theoreticalCost - row.storedCost;
                  const overCeiling = row.foodCostPercent > FOOD_COST_CEILING;
                  return (
                    <tr key={row.menuItemId} className="cursor-pointer" onClick={() => setOpenItem(row.menuItemId)}>
                      <td>
                        <span className="flex items-center gap-1.5">
                          <span aria-hidden="true">{row.emoji || "🍽"}</span>
                          <span className="font-semibold text-ink">{row.itemName}</span>
                        </span>
                      </td>
                      <td className="tnum text-right font-bold">{formatMoney(row.price)}</td>
                      <td className="tnum text-right">
                        <span className="font-bold" style={{ color: overCeiling ? "var(--color-late)" : undefined }}>
                          {formatMoney(row.theoreticalCost)}
                        </span>
                        {Math.abs(drift) > 100 && (
                          <span className="block text-[10px] font-semibold text-warn">
                            stored {formatMoney(row.storedCost)}
                          </span>
                        )}
                      </td>
                      <td className="tnum text-right font-bold">{formatMoney(row.margin)}</td>
                      <td>
                        <span className="flex items-center gap-1.5">
                          <Meter
                            value={Math.min(row.foodCostPercent, 100)}
                            max={100}
                            tone={
                              row.foodCostPercent > FOOD_COST_CEILING
                                ? "var(--color-late)"
                                : row.foodCostPercent > FOOD_COST_TARGET
                                  ? "var(--color-warn)"
                                  : "var(--color-ok)"
                            }
                          />
                          <span className="tnum w-11 shrink-0 text-right text-[11px] font-bold">{row.foodCostPercent.toFixed(0)}%</span>
                        </span>
                      </td>
                      <td className="tnum text-right text-ink-soft">
                        {row.components.length}
                        {row.missing.length > 0 && <span className="ml-1 font-bold text-late">· {row.missing.length} unresolved</span>}
                      </td>
                      <td>
                        {row.components.length === 0 ? (
                          <Chip tone="late">No BOM</Chip>
                        ) : row.missing.length > 0 ? (
                          <Chip tone="late">Broken links</Chip>
                        ) : Math.abs(drift) > 100 ? (
                          <Chip tone="warn">Drifted</Chip>
                        ) : overCeiling ? (
                          <Chip tone="warn">Over target</Chip>
                        ) : (
                          <Chip tone="ok">Costed</Chip>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="font-extrabold text-ink">Totals ({visible.length})</td>
                  <td className="tnum text-right font-extrabold">
                    {formatMoneyShort(visible.reduce((sum, row) => sum + row.price, 0))}
                  </td>
                  <td className="tnum text-right font-extrabold">
                    {formatMoneyShort(visible.reduce((sum, row) => sum + row.theoreticalCost, 0))}
                  </td>
                  <td className="tnum text-right font-extrabold text-ok">
                    {formatMoneyShort(visible.reduce((sum, row) => sum + row.margin, 0))}
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {openItem && (
        <BomEditor
          menuItemId={openItem}
          canEdit={canEdit}
          onClose={() => setOpenItem(null)}
          onChanged={() => void reload()}
          onRecost={() => {
            const row = rows.find((entry) => entry.menuItemId === openItem);
            if (row) void recost(row.menuItemId, row.itemName);
          }}
          recosting={busyRecost === openItem}
        />
      )}
    </div>
  );
}

/** Add, price and remove the ingredients behind one dish, with live recosting. */
function BomEditor({
  menuItemId,
  canEdit,
  onClose,
  onChanged,
  onRecost,
  recosting,
}: {
  menuItemId: string;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
  onRecost: () => void;
  recosting: boolean;
}) {
  const [detail, setDetail] = useState<RecipeDetail | null>(null);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [picking, setPicking] = useState(false);
  const [pickItem, setPickItem] = useState("");
  const [pickQty, setPickQty] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api.get<RecipeDetail>(`recipes/${menuItemId}`));
    } catch (error) {
      toast(errorMessage(error), "late");
    }
  }, [menuItemId]);

  useEffect(() => {
    void load();
    let live = true;
    void api
      .get<{ items: InventoryItem[] }>("inventory")
      .then((response) => {
        if (live) setInventory(response.items);
      })
      .catch(() => {
        /* the picker is unusable without inventory, but the BOM still renders */
      });
    return () => {
      live = false;
    };
  }, [load]);

  const costing = detail?.costing;
  const components = detail?.components ?? [];
  const modifierComponents = components.filter((entry) => entry.isModifier);
  const baseComponents = components.filter((entry) => !entry.isModifier);

  const addComponent = useCallback(async () => {
    const item = inventory.find((entry) => entry.id === pickItem);
    const quantity = Number(pickQty);
    if (!item || !(quantity > 0)) return;
    setBusy(true);
    try {
      await api.post(`recipes/${menuItemId}/components`, {
        inventoryItemId: item.id,
        quantityRequired: quantity,
        isModifier: false,
        modifierId: "",
      });
      toast(`${item.name} added to the recipe`, "ok");
      setPicking(false);
      setPickItem("");
      setPickQty("");
      await load();
      onChanged();
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }, [inventory, pickItem, pickQty, menuItemId, load, onChanged]);

  const removeComponent = useCallback(
    async (component: RecipeComponent) => {
      setBusy(true);
      try {
        await api.del(
          `recipes/${menuItemId}/components/${component.inventoryItemId}${component.isModifier ? `?${qs({ modifierId: component.modifierId })}` : ""}`,
        );
        toast(`${component.itemName} removed from the recipe`, "neutral");
        await load();
        onChanged();
      } catch (error) {
        toast(errorMessage(error), "late");
      } finally {
        setBusy(false);
      }
    },
    [menuItemId, load, onChanged],
  );

  if (!costing) {
    return (
      <Modal open onClose={onClose} title="Loading recipe…">
        <Empty title="Loading the bill of materials…" icon="recipe" />
      </Modal>
    );
  }

  const drift = costing.theoreticalCost - costing.storedCost;

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span aria-hidden="true">{costing.emoji || "🍽"}</span>
          {costing.itemName}
        </span>
      }
      subtitle="Every quantity is per portion sold. Changing an ingredient price flows straight through to this cost."
      width="max-w-3xl"
      footer={
        <>
          {Math.abs(drift) > 100 && canEdit && (
            <Button variant="soft" disabled={recosting} onClick={onRecost}>
              <Icon name="refresh" className="size-4" />
              Recost menu item
            </Button>
          )}
          {canEdit && !picking && (
            <Button variant="primary" onClick={() => setPicking(true)}>
              <Icon name="plus" className="size-4" />
              Add ingredient
            </Button>
          )}
        </>
      }
    >
      <div className="scroll-y flex max-h-[64vh] flex-col gap-3">
        {/* Cost headline */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Mini label="Sells for" value={formatMoney(costing.price)} />
          <Mini
            label="Ingredient cost"
            value={formatMoney(costing.theoreticalCost)}
            tone={costing.foodCostPercent > FOOD_COST_CEILING ? "var(--color-late)" : undefined}
          />
          <Mini label="Margin" value={formatMoney(costing.margin)} tone="var(--color-ok)" />
          <Mini label="Food cost" value={`${costing.foodCostPercent.toFixed(1)}%`} />
        </div>

        {Math.abs(drift) > 100 && (
          <p className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[12px] font-semibold text-warn">
            <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
            <span>
              The menu item is stored at {formatMoney(costing.storedCost)} but this recipe is now worth{" "}
              {formatMoney(costing.theoreticalCost)} — a drift of {formatMoney(Math.abs(drift))}. Recost to bring the
              stored figure in line, otherwise reported margin for this dish is wrong.
            </span>
          </p>
        )}

        {costing.missing.length > 0 && (
          <p className="flex items-start gap-2 rounded-lg bg-late-soft px-3 py-2 text-[12px] font-semibold text-late">
            <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
            <span>
              {costing.missing.length} component(s) point at inventory items that no longer exist:{" "}
              {costing.missing.join(", ")}. These contribute nothing to the cost, so it is understated.
            </span>
          </p>
        )}

        {/* Base recipe */}
        <div>
          <p className="label">Base recipe ({baseComponents.length})</p>
          {baseComponents.length === 0 ? (
            <p className="rounded-lg border border-dashed border-rule px-3 py-4 text-center text-[12px] text-ink-faint">
              No ingredients recorded. This dish sells with no cost attached, so its margin reads as 100%.
            </p>
          ) : (
            <div className="scroll-x">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Unit cost</th>
                    <th className="text-right">Line cost</th>
                    <th className="w-24">Share</th>
                    {canEdit && <th />}
                  </tr>
                </thead>
                <tbody>
                  {baseComponents.map((component) => (
                    <tr key={`${component.inventoryItemId}-${component.modifierId}`}>
                      <td className="font-semibold text-ink">{component.itemName}</td>
                      <td className="tnum text-right">
                        {formatQuantity(component.quantityRequired, 3)}{" "}
                        <span className="text-[11px] text-ink-faint">{component.unit}</span>
                      </td>
                      <td className="tnum text-right text-ink-soft">{formatMoney(component.unitCost)}</td>
                      <td className="tnum text-right font-bold">{formatMoney(component.lineCost)}</td>
                      <td>
                        <Meter
                          value={component.lineCost}
                          max={Math.max(...baseComponents.map((entry) => entry.lineCost), 1)}
                          tone="var(--color-ember-500)"
                        />
                      </td>
                      {canEdit && (
                        <td className="text-right">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void removeComponent(component)}
                            className="text-ink-faint transition-colors hover:text-late"
                            aria-label={`Remove ${component.itemName}`}
                          >
                            <Icon name="trash" className="size-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} className="text-right font-extrabold text-ink">
                      Theoretical cost per portion
                    </td>
                    <td className="tnum text-right font-black">{formatMoney(costing.theoreticalCost)}</td>
                    <td colSpan={canEdit ? 2 : 1} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* Modifier surcharges */}
        {modifierComponents.length > 0 && (
          <div>
            <p className="label">Modifier-linked components ({modifierComponents.length})</p>
            <p className="mb-1.5 text-[11px] text-ink-faint">
              Ingredients that only apply when a guest chooses a particular option — extra cheese, a double shot. These
              are excluded from the base cost so the headline margin stays honest.
            </p>
            <ul className="flex flex-col gap-1">
              {modifierComponents.map((component) => (
                <li
                  key={`${component.inventoryItemId}-${component.modifierId}`}
                  className="flex items-center gap-2 rounded-lg border border-rule bg-paper px-2.5 py-1.5"
                >
                  <Chip tone="info">option</Chip>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">{component.itemName}</span>
                  <span className="tnum shrink-0 text-[11px] text-ink-faint">
                    {formatQuantity(component.quantityRequired, 3)} {component.unit}
                  </span>
                  <span className="tnum shrink-0 text-[12px] font-bold">{formatMoney(component.lineCost)}</span>
                  {canEdit && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removeComponent(component)}
                      className="shrink-0 text-ink-faint transition-colors hover:text-late"
                      aria-label={`Remove ${component.itemName}`}
                    >
                      <Icon name="trash" className="size-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Add-ingredient picker */}
        {picking && canEdit && (
          <div className="rounded-xl border border-brand-300 bg-brand-50 px-3 py-2.5">
            <p className="label">Add an ingredient</p>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
              <Field label="Inventory item">
                <select className="field" value={pickItem} onChange={(event) => setPickItem(event.target.value)} autoFocus>
                  <option value="">Choose…</option>
                  {inventory.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} — {formatMoney(item.unitCost)}/{item.unit}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Quantity">
                <TextInput value={pickQty} onChange={setPickQty} type="number" step="0.001" min="0" className="tnum" placeholder="0.25" />
              </Field>
              <div className="flex items-end gap-1.5">
                <Button variant="primary" disabled={busy || !pickItem || !(Number(pickQty) > 0)} onClick={() => void addComponent()}>
                  <Icon name="plus" className="size-4" />
                  Add
                </Button>
                <Button variant="ghost" onClick={() => setPicking(false)}>
                  Cancel
                </Button>
              </div>
            </div>
            {pickItem && Number(pickQty) > 0 && (
              <p className="tnum mt-2 text-[12px] font-semibold text-brand-700">
                Adds{" "}
                {formatMoney(
                  Math.round(
                    Number(pickQty) * (inventory.find((entry) => entry.id === pickItem)?.unitCost ?? 0),
                  ),
                )}{" "}
                per portion → new cost{" "}
                {formatMoney(
                  costing.theoreticalCost +
                    Math.round(Number(pickQty) * (inventory.find((entry) => entry.id === pickItem)?.unitCost ?? 0)),
                )}
                , margin{" "}
                {(
                  ((costing.price -
                    (costing.theoreticalCost +
                      Math.round(Number(pickQty) * (inventory.find((entry) => entry.id === pickItem)?.unitCost ?? 0)))) /
                    Math.max(1, costing.price)) *
                  100
                ).toFixed(1)}
                %
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-rule bg-paper px-2.5 py-1.5">
      <p className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="tnum truncate text-[14px] font-black" style={{ color: tone ?? "var(--color-ink)" }}>
        {value}
      </p>
    </div>
  );
}
