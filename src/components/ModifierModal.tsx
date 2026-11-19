"use client";

/**
 * Modifier selection modal.
 *
 * Shared by the POS and the guest QR flow so a diner and a server see exactly
 * the same rules. A group with `maxSelect === 1` behaves as a radio list; wider
 * groups behave as checkboxes bounded by min/max. Required groups block
 * confirmation until satisfied — the same constraint the server re-checks in
 * `validateModifierSelection`, so the UI can never promise something the API
 * will reject.
 */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui";
import { formatMoney, toRupees } from "@/domain/money";
import type { MenuItem } from "@/types";

export interface ModifierSelection {
  optionIds: string[];
  quantity: number;
  note: string;
  includeUpsell?: boolean;
}

export function ModifierModal({
  item,
  open,
  initial,
  onClose,
  onConfirm,
  confirmLabel = "Add to ticket",
  showUpsell = false,
}: {
  item: MenuItem | null;
  open: boolean;
  /** Pre-selected option ids when re-opening an existing line. */
  initial?: ModifierSelection;
  onClose: () => void;
  onConfirm: (selection: ModifierSelection) => void;
  confirmLabel?: string;
  showUpsell?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [includeUpsell, setIncludeUpsell] = useState(false);

  // Reset whenever a different item (or a re-open of an existing line) arrives.
  useEffect(() => {
    if (!open || !item) return;
    setSelected(initial?.optionIds ?? defaultOptions(item));
    setQuantity(initial?.quantity ?? 1);
    setNote(initial?.note ?? "");
    setIncludeUpsell(Boolean(initial?.includeUpsell));
  }, [open, item?.id, initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => {
    if (!item) return { unit: 0, total: 0 };
    const extras = item.groups
      .flatMap((group) => group.options)
      .filter((option) => selected.includes(option.id))
      .reduce((sum, option) => sum + option.price, 0);
    const unit = item.price + extras;
    const upsellExtra = showUpsell && includeUpsell && item.upsellItem ? item.upsellItem.discountedPrice : 0;
    return { unit, total: (unit + upsellExtra) * quantity };
  }, [item, selected, quantity, showUpsell, includeUpsell]);

  if (!open || !item) return null;

  const problems = item.groups
    .map((group) => {
      const chosen = group.options.filter((option) => selected.includes(option.id)).length;
      if (group.isRequired && chosen < group.minSelect) {
        return `Choose ${group.minSelect === group.maxSelect ? "" : "at least "}${group.minSelect} from “${group.name}”`;
      }
      if (chosen > group.maxSelect) return `“${group.name}” allows at most ${group.maxSelect}`;
      return null;
    })
    .filter(Boolean) as string[];

  function toggle(optionId: string, maxSelect: number, groupId: string) {
    setSelected((current) => {
      const already = current.includes(optionId);
      if (already) return current.filter((id) => id !== optionId);
      if (maxSelect === 1) {
        // Single-choice group: replace whatever was picked from this group.
        const siblings = (item?.groups.find((entry) => entry.id === groupId)?.options ?? []).map((option) => option.id);
        return [...current.filter((id) => !siblings.includes(id)), optionId];
      }
      const chosenHere = current.filter((id) =>
        (item?.groups.find((entry) => entry.id === groupId)?.options ?? []).some((option) => option.id === id),
      );
      if (chosenHere.length >= maxSelect) return current; // hard cap — ignore the tap
      return [...current, optionId];
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 backdrop-blur-[2px] sm:items-center sm:p-4">
      <div
        className="card flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={`Customise ${item.name}`}
      >
        {/* ------------------------------------------------------------- header */}
        <div className="flex items-start gap-3 border-b border-rule px-4 py-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-paper-sunken text-2xl">
            {item.emoji || "🍽"}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-extrabold text-ink">{item.name}</h2>
            <p className="mt-0.5 line-clamp-2 text-xs text-ink-faint">{item.description}</p>
            {item.allergens && (
              <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-warn">
                <Icon name="alert" className="size-3.5" />
                Allergens: {item.allergens}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1.5 text-ink-faint hover:bg-paper-sunken hover:text-ink"
          >
            <Icon name="close" className="size-5" />
          </button>
        </div>

        {/* -------------------------------------------------------------- groups */}
        <div className="scroll-y flex-1 px-4 py-3">
          {(item.allergens || item.spiceLevel > 0 || (showUpsell && item.upsellItem)) && (
            <div className="mb-4 divide-y divide-rule rounded-xl border border-rule bg-paper">
              <div className="flex items-center justify-between px-3 py-2 text-xs">
                <span className="font-bold uppercase tracking-wider text-ink-faint">Allergens</span>
                <span className="font-semibold text-ink">{item.allergens || "None listed"}</span>
              </div>
              {item.spiceLevel > 0 && (
                <div className="flex items-center justify-between px-3 py-2 text-xs">
                  <span className="font-bold uppercase tracking-wider text-ink-faint">Spice</span>
                  <span className="flex items-center gap-0.5 text-sm" aria-label={`Spice level ${item.spiceLevel} of 3`}>
                    {[1, 2, 3].map((lvl) => (
                      <span key={lvl} className={lvl <= item.spiceLevel ? "opacity-100" : "opacity-20"}>
                        🌶️
                      </span>
                    ))}
                  </span>
                </div>
              )}
              {showUpsell && item.upsellItem && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                  <div>
                    <span className="font-bold uppercase tracking-wider text-ink-faint">Deal · </span>
                    <span className="font-extrabold text-ember-600">
                      {item.upsellItem.emoji} + {item.upsellItem.name} ({item.upsellItem.discountPercent}% off)
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIncludeUpsell((v) => !v)}
                    className={`rounded-full px-3 py-1 text-[11px] font-extrabold transition-colors ${
                      includeUpsell
                        ? "bg-ember-500 text-white"
                        : "border border-ember-300 bg-ember-50 text-ember-700 hover:bg-ember-100"
                    }`}
                  >
                    {includeUpsell ? "Added ✓" : `+ ${formatMoney(item.upsellItem.discountedPrice)}`}
                  </button>
                </div>
              )}
            </div>
          )}

          {item.groups.length === 0 && (
            <p className="py-4 text-center text-sm text-ink-faint">
              Ready to add straight to your order.
            </p>
          )}

          {item.groups.map((group) => {
            const single = group.maxSelect === 1;
            const chosen = group.options.filter((option) => selected.includes(option.id)).length;
            const satisfied = !group.isRequired || chosen >= group.minSelect;
            return (
              <div key={group.id} className="mb-4 last:mb-0">
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <p className="text-[13px] font-bold text-ink">
                    {group.name}
                    {group.isRequired && <span className="ml-1 text-late">*</span>}
                  </p>
                  <span className={`text-[11px] font-semibold ${satisfied ? "text-ink-faint" : "text-late"}`}>
                    {single
                      ? group.isRequired
                        ? "Required"
                        : "Optional"
                      : `${chosen}/${group.maxSelect} selected${group.minSelect > 0 ? ` · min ${group.minSelect}` : ""}`}
                  </span>
                </div>

                <div className="flex flex-col gap-1">
                  {group.options.map((option) => {
                    const on = selected.includes(option.id);
                    const disabled = !on && !single && chosen >= group.maxSelect;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        disabled={disabled || !option.isAvailable}
                        onClick={() => toggle(option.id, group.maxSelect, group.id)}
                        className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                          on
                            ? "border-brand-400 bg-brand-50"
                            : disabled || !option.isAvailable
                              ? "border-rule bg-paper-sunken opacity-50"
                              : "border-rule bg-paper-raised hover:border-brand-200"
                        }`}
                      >
                        <span
                          className={`flex size-[18px] shrink-0 items-center justify-center border-2 ${
                            single ? "rounded-full" : "rounded-[5px]"
                          }`}
                          style={{
                            borderColor: on ? "var(--color-brand-500)" : "var(--color-rule)",
                            background: on ? "var(--color-brand-500)" : "transparent",
                          }}
                        >
                          {on && <Icon name="check" className="size-2.5 text-white" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                          {option.name}
                          {!option.isAvailable && <span className="ml-1.5 text-[11px] text-late">86'd</span>}
                        </span>
                        <span className="tnum shrink-0 text-[12px] font-bold text-ink-soft">
                          {option.price > 0 ? `+ ${formatMoney(option.price)}` : option.price < 0 ? `− ${formatMoney(-option.price)}` : "—"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* ------------------------------------------------------- qty + note */}
          <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-3 border-t border-rule pt-3">
            <div>
              <span className="label">Qty</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Decrease quantity"
                  onClick={() => setQuantity((current) => Math.max(1, current - 1))}
                  className="btn btn-soft !px-2.5 !py-2"
                >
                  <Icon name="minus" className="size-4" />
                </button>
                <span className="tnum w-9 text-center text-lg font-extrabold text-ink">{quantity}</span>
                <button
                  type="button"
                  aria-label="Increase quantity"
                  onClick={() => setQuantity((current) => Math.min(99, current + 1))}
                  className="btn btn-soft !px-2.5 !py-2"
                >
                  <Icon name="plus" className="size-4" />
                </button>
              </div>
            </div>
            <div>
              <span className="label">Note for the kitchen</span>
              <input
                className="field"
                value={note}
                placeholder="e.g. no onion, sauce on the side"
                maxLength={140}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </div>
        </div>

        {/* -------------------------------------------------------------- footer */}
        <div className="border-t border-rule px-4 py-3">
          {problems.length > 0 && (
            <p className="mb-2 flex items-start gap-1.5 text-[12px] font-semibold text-late">
              <Icon name="alert" className="mt-px size-3.5 shrink-0" />
              <span>{problems.join(" · ")}</span>
            </p>
          )}
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="tnum text-[11px] text-ink-faint">
                {formatMoney(totals.unit)} each
                {quantity > 1 && ` × ${quantity}`}
              </p>
              <p className="tnum text-xl font-extrabold leading-tight text-ink">{formatMoney(totals.total)}</p>
            </div>
            <button type="button" onClick={onClose} className="btn btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              disabled={problems.length > 0}
              onClick={() => onConfirm({ optionIds: selected, quantity, note, includeUpsell })}
              className="btn btn-primary !px-5"
            >
              {confirmLabel}
              <span className="tnum ml-1 rounded bg-white/20 px-1.5 py-0.5 text-xs">
                Rs {toRupees(totals.total).toFixed(0)}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Pre-select each group's default option, the way the seed marks them. */
export function defaultOptions(item: MenuItem): string[] {
  return item.groups
    .map((group) => group.options.find((option) => option.isDefault && option.isAvailable))
    .filter((option): option is NonNullable<typeof option> => Boolean(option))
    .map((option) => option.id);
}
