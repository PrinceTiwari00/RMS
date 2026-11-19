"use client";

import { useState } from "react";
import { Icon, TextInput } from "@/components/ui";
import { boolValue, numberValue, parseCsv, type ServiceStyle } from "@/domain/settings";
import { Notice, NumberField, Panel, Segmented, ToggleRow, type SettingsSectionProps } from "./controls";

const SERVICE_STYLES: {
  id: ServiceStyle;
  name: string;
  eyebrow: string;
  description: string;
  icon: "table" | "pos" | "host";
  features: string[];
  patch: Record<string, string>;
}[] = [
  {
    id: "full_service",
    name: "Full-service dining",
    eyebrow: "Tables & courses",
    description: "Table assignment, open checks, coursing and printed guest bills before settlement.",
    icon: "table",
    features: ["Table assignment", "Open checks", "Seat tracking"],
    patch: { operating_mode: "full_service", quick_checkout: "0", open_tabs_enabled: "1", print_bill_enabled: "1", seat_tracking_enabled: "1" },
  },
  {
    id: "quick_service",
    name: "Quick service / counter",
    eyebrow: "Order & pay",
    description: "A fast counter flow with immediate checkout and no mandatory table or open-tab step.",
    icon: "pos",
    features: ["Immediate checkout", "Takeout first", "Fast tender"],
    patch: { operating_mode: "quick_service", quick_checkout: "1", open_tabs_enabled: "0", print_bill_enabled: "0", seat_tracking_enabled: "0" },
  },
  {
    id: "bar_nightclub",
    name: "Bar & nightclub",
    eyebrow: "Tabs & rounds",
    description: "Named open tabs, rapid repeat rounds and flexible checkout without table-first service.",
    icon: "host",
    features: ["Open bar tabs", "Named guests", "Late-night hours"],
    patch: { operating_mode: "bar_nightclub", quick_checkout: "0", open_tabs_enabled: "1", print_bill_enabled: "1", seat_tracking_enabled: "0" },
  },
];

export function WorkflowSection({ draft, onChange, onChangeMany, canEdit }: SettingsSectionProps) {
  const [reason, setReason] = useState("");
  const reasons = parseCsv(draft.discount_reasons);
  const offlineEnabled = boolValue(draft.offline_payments_enabled, true);
  const activeStyle = SERVICE_STYLES.find((style) => style.id === draft.operating_mode) ?? SERVICE_STYLES[0];

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Service style" description="Start with a proven workflow, then fine-tune the controls below. Presets never change your menu, taxes or business details." icon="pos">
        <div className="grid gap-3 lg:grid-cols-3">
          {SERVICE_STYLES.map((style) => {
            const active = draft.operating_mode === style.id;
            return (
              <button
                key={style.id}
                type="button"
                disabled={!canEdit}
                onClick={() => onChangeMany(style.patch)}
                className={`relative overflow-hidden rounded-2xl border p-4 text-left transition-all disabled:opacity-50 ${
                  active ? "border-brand-500 bg-brand-50 shadow-[0_0_0_1px_var(--color-brand-500)]" : "border-rule bg-white hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
                }`}
              >
                {active && (
                  <span className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-brand-500 text-white">
                    <Icon name="check" className="size-3" />
                  </span>
                )}
                <span className={`flex size-10 items-center justify-center rounded-xl ${active ? "bg-brand-500 text-white" : "bg-paper-sunken text-ink-soft"}`}>
                  <Icon name={style.icon} className="size-5" />
                </span>
                <span className="mt-3 block text-[10px] font-bold uppercase tracking-[0.09em] text-ink-faint">{style.eyebrow}</span>
                <span className="mt-0.5 block text-[15px] font-extrabold text-ink">{style.name}</span>
                <span className="mt-1.5 block min-h-12 text-[11px] leading-relaxed text-ink-soft">{style.description}</span>
                <span className="mt-3 flex flex-wrap gap-1.5">
                  {style.features.map((feature) => <span key={feature} className="rounded-full border border-rule bg-white/70 px-2 py-0.5 text-[9px] font-bold text-ink-soft">{feature}</span>)}
                </span>
              </button>
            );
          })}
        </div>
      </Panel>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,.75fr)]">
        <Panel title="Terminal behavior" description={`${activeStyle.name} is the default flow for new tickets.`} icon="display">
          <div className="divide-y divide-rule">
            <ToggleRow
              title="Immediate checkout"
              description="Take payment as soon as the order is placed, without keeping a check open."
              checked={boolValue(draft.quick_checkout)}
              onChange={(value) => onChange("quick_checkout", value)}
              disabled={!canEdit}
            />
            <ToggleRow
              title="Open tabs & checks"
              description="Allow staff to add rounds or dishes before the guest settles the bill."
              checked={boolValue(draft.open_tabs_enabled, true)}
              onChange={(value) => onChange("open_tabs_enabled", value)}
              disabled={!canEdit}
            />
            <ToggleRow
              title="Print guest bill before payment"
              description="Offer an itemized bill before opening the tender screen."
              checked={boolValue(draft.print_bill_enabled, true)}
              onChange={(value) => onChange("print_bill_enabled", value)}
              disabled={!canEdit}
            />
            <ToggleRow
              title="QR table ordering"
              description="Allow guests to order from the menu using their table's signed QR link."
              checked={boolValue(draft.qr_ordering_enabled, true)}
              onChange={(value) => onChange("qr_ordering_enabled", value)}
              disabled={!canEdit}
            />
            <ToggleRow
              title="Staff approval for QR orders"
              description="Hold QR guest orders in the staff queue until a server confirms and sends them to the kitchen."
              checked={boolValue(draft.qr_require_staff_approval, true)}
              onChange={(value) => onChange("qr_require_staff_approval", value)}
              disabled={!canEdit || !boolValue(draft.qr_ordering_enabled, true)}
            />
            <ToggleRow
              title="Customer-facing display"
              description="Show the live ticket, promotions and payment QR on the guest display."
              checked={boolValue(draft.cfd_enabled, true)}
              onChange={(value) => onChange("cfd_enabled", value)}
              disabled={!canEdit}
            />
          </div>
        </Panel>

        <Panel title="Current order flow" description="A compact preview of the selected terminal mode." icon="arrow-right">
          <div className="flex flex-col">
            {(draft.operating_mode === "quick_service"
              ? [
                  ["pos", "Build the order", "Counter, takeout or delivery"],
                  ["kitchen", "Send to preparation", "Items route to their stations"],
                  ["card", "Take payment", "Immediate checkout"],
                  ["receipt", "Hand over receipt", "Print or send digitally"],
                ]
              : [
                  [draft.operating_mode === "bar_nightclub" ? "host" : "table", draft.operating_mode === "bar_nightclub" ? "Open a named tab" : "Assign a table", `${draft.guests || "Guest"} details stay with the check`],
                  ["pos", "Add dishes & rounds", "Open check remains editable"],
                  ["kitchen", "Course & prepare", "KDS tracks every station"],
                  ["receipt", "Print bill & settle", "Split by seat, item or evenly"],
                ]
            ).map(([icon, title, detail], index, steps) => (
              <div key={title} className="relative flex gap-3 pb-4 last:pb-0">
                {index < steps.length - 1 && <span className="absolute bottom-0 left-[15px] top-8 w-px bg-rule" />}
                <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 ring-4 ring-white">
                  <Icon name={icon as "pos"} className="size-4" />
                </span>
                <div>
                  <p className="text-[12px] font-extrabold text-ink">{index + 1}. {title}</p>
                  <p className="mt-0.5 text-[11px] text-ink-faint">{detail}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Panel title="Void, comp & discount approvals" description="Choose which sensitive actions need a manager PIN, and standardize the reasons staff can select." icon="lock">
          <div className="divide-y divide-rule">
            <ToggleRow
              title="Line-item voids"
              description="Require a manager PIN before a sent item can be voided."
              checked={boolValue(draft.require_manager_pin_void, true)}
              onChange={(value) => onChange("require_manager_pin_void", value)}
              disabled={!canEdit}
            />
            <ToggleRow
              title="Item comps"
              description="Require approval when an item is made complimentary."
              checked={boolValue(draft.require_manager_pin_comp, true)}
              onChange={(value) => onChange("require_manager_pin_comp", value)}
              disabled={!canEdit}
            />
            <ToggleRow
              title="Bill discounts"
              description="Require a manager PIN for percentage or fixed-amount discounts."
              checked={boolValue(draft.require_manager_pin_discount, true)}
              onChange={(value) => onChange("require_manager_pin_discount", value)}
              disabled={!canEdit}
            />
          </div>
          <div className="mt-3 border-t border-rule pt-3">
            <p className="label">Preset discount reasons</p>
            <div className="flex flex-wrap gap-1.5">
              {reasons.map((entry) => (
                <span key={entry} className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper-sunken px-2.5 py-1 text-[11px] font-bold text-ink-soft">
                  {entry}
                  <button
                    type="button"
                    disabled={!canEdit}
                    aria-label={`Remove ${entry}`}
                    onClick={() => onChange("discount_reasons", reasons.filter((reasonEntry) => reasonEntry !== entry).join(","))}
                    className="text-ink-faint hover:text-late"
                  >
                    <Icon name="close" className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <TextInput value={reason} onChange={setReason} placeholder="Add a reason, e.g. Birthday courtesy" disabled={!canEdit} />
              <button
                type="button"
                disabled={!canEdit || !reason.trim()}
                onClick={() => {
                  const clean = reason.trim().replaceAll(",", "");
                  if (!clean) return;
                  if (!reasons.some((entry) => entry.toLowerCase() === clean.toLowerCase())) onChange("discount_reasons", [...reasons, clean].join(","));
                  setReason("");
                }}
                className="btn btn-soft shrink-0"
              >
                <Icon name="plus" className="size-4" />Add
              </button>
            </div>
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="Guest seat tracking" description="Make split checks faster and more accurate at larger tables." icon="split">
            <ToggleRow
              title="Require seat assignment"
              description="Staff must assign each line to a guest seat once the table reaches the threshold."
              checked={boolValue(draft.seat_tracking_enabled, true)}
              onChange={(value) => onChange("seat_tracking_enabled", value)}
              disabled={!canEdit}
            />
            <div className="mt-3 border-t border-rule pt-3">
              <NumberField
                label="Required for parties of"
                value={draft.seat_tracking_min_guests}
                onChange={(value) => onChange("seat_tracking_min_guests", value)}
                suffix="guests"
                min={1}
                disabled={!canEdit || !boolValue(draft.seat_tracking_enabled, true)}
              />
            </div>
          </Panel>

          <Panel title="Offline payment rules" description="Bound store-and-forward risk while the payment provider is unreachable." icon="card">
            <ToggleRow
              title="Allow offline card approvals"
              description="Store eligible card tenders until the terminal reconnects."
              checked={offlineEnabled}
              onChange={(value) => onChange("offline_payments_enabled", value)}
              disabled={!canEdit}
            />
            <div className={`mt-3 border-t border-rule pt-3 ${!offlineEnabled ? "opacity-50" : ""}`}>
              <NumberField
                label="Combined offline approval cap"
                value={String(numberValue(draft.store_forward_limit, 5_000_000) / 100)}
                onChange={(value) => onChange("store_forward_limit", Math.round(Number(value || 0) * 100))}
                suffix={draft.currency}
                min={0}
                step="100"
                disabled={!canEdit || !offlineEnabled}
                hint="When held offline approvals reach this total, reconnection is required before more card sales."
              />
            </div>
            <div className="mt-3">
              <Notice tone="warn">Offline approval does not guarantee settlement. Keep the cap within your business's acceptable risk.</Notice>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
