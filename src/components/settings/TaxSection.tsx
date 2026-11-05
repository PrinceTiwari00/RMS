"use client";

import { useState } from "react";
import { Icon, TextInput, Toggle } from "@/components/ui";
import {
  DEFAULT_SURCHARGES,
  DEFAULT_TAX_RULES,
  boolValue,
  localId,
  parseCsv,
  parseJsonSetting,
  type SurchargeRule,
  type TaxRule,
} from "@/domain/settings";
import {
  AddRowButton,
  Notice,
  NumberField,
  Panel,
  Segmented,
  SelectField,
  TextField,
  ToggleRow,
  type SettingsSectionProps,
} from "./controls";

const TIP_CHOICES = [10, 12, 15, 18, 20, 22, 25];

export function TaxSection({ draft, onChange, onChangeMany, categories, canEdit }: SettingsSectionProps) {
  const [customTip, setCustomTip] = useState("");
  const rules = parseJsonSetting<TaxRule[]>(draft.tax_rules, DEFAULT_TAX_RULES);
  const surcharges = parseJsonSetting<SurchargeRule[]>(draft.surcharges, DEFAULT_SURCHARGES);
  const tips = parseCsv(draft.tip_presets).map(Number).filter(Number.isFinite);
  const autoGratuity = boolValue(draft.auto_gratuity_enabled);

  const saveRules = (next: TaxRule[]) => onChange("tax_rules", JSON.stringify(next));
  const patchRule = (id: string, patch: Partial<TaxRule>) => {
    const next = rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule));
    if (patch.rate !== undefined && rules.find((rule) => rule.id === id)?.scope === "all") {
      onChangeMany({ tax_rules: JSON.stringify(next), vat_rate: patch.rate });
    } else saveRules(next);
  };
  const saveSurcharges = (next: SurchargeRule[]) => onChange("surcharges", JSON.stringify(next));
  const patchSurcharge = (id: string, patch: Partial<SurchargeRule>) =>
    saveSurcharges(surcharges.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,.7fr)]">
        <Panel title="Tax rates & pricing rules" description="Set the default sales tax, then map category-specific or tax-exempt rules." icon="report">
          <div className="grid gap-3 sm:grid-cols-[160px_160px_minmax(240px,1fr)]">
            <NumberField
              label="Default VAT / sales tax"
              value={draft.vat_rate}
              onChange={(value) => {
                const next = rules.map((rule) => (rule.scope === "all" ? { ...rule, rate: Number(value) } : rule));
                onChangeMany({ vat_rate: value, tax_rules: JSON.stringify(next) });
              }}
              suffix="%"
              step="0.01"
              max={100}
              disabled={!canEdit}
            />
            <NumberField
              label="Service charge"
              value={draft.service_charge_rate}
              onChange={(value) => onChange("service_charge_rate", value)}
              suffix="%"
              step="0.01"
              max={100}
              disabled={!canEdit}
            />
            <div>
              <span className="label">Menu price tax treatment</span>
              <Segmented
                label="Tax treatment"
                value={draft.vat_inclusive}
                onChange={(value) => onChange("vat_inclusive", value)}
                options={[{ value: "0", label: "Tax exclusive" }, { value: "1", label: "Tax inclusive" }]}
                disabled={!canEdit}
              />
              <p className="mt-1.5 text-[11px] text-ink-faint">
                {draft.vat_inclusive === "1" ? "Tax is extracted from the menu price." : "Tax is added on top of the menu price."}
              </p>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-rule pt-3">
            <div>
              <h3 className="text-[12px] font-extrabold text-ink">Item-specific tax mapping</h3>
              <p className="text-[11px] text-ink-faint">More specific category rules take priority over the default rate.</p>
            </div>
            <AddRowButton
              disabled={!canEdit}
              onClick={() =>
                saveRules([
                  ...rules,
                  { id: localId("tax"), name: "New tax rule", rate: 0, scope: "categories", categoryIds: [], enabled: true },
                ])
              }
            >
              Add tax rule
            </AddRowButton>
          </div>

          <div className="mt-3 flex flex-col gap-2.5">
            {rules.map((rule) => (
              <article key={rule.id} className={`rounded-xl border p-3 ${rule.enabled ? "border-rule" : "border-dashed border-rule bg-paper-sunken/60"}`}>
                <div className="grid items-end gap-3 lg:grid-cols-[minmax(150px,1fr)_110px_minmax(170px,.8fr)_auto_auto]">
                  <TextField label="Rule name" value={rule.name} onChange={(value) => patchRule(rule.id, { name: value })} disabled={!canEdit} />
                  <NumberField label="Rate" value={rule.rate} onChange={(value) => patchRule(rule.id, { rate: Number(value) })} suffix="%" step="0.01" max={100} disabled={!canEdit} />
                  <SelectField
                    label="Applies to"
                    value={rule.scope}
                    onChange={(value) => patchRule(rule.id, { scope: value as TaxRule["scope"] })}
                    options={[
                      { value: "all", label: "All items (default)" },
                      { value: "categories", label: "Selected categories" },
                      { value: "exempt_categories", label: "Tax-exempt categories" },
                    ]}
                    disabled={!canEdit}
                  />
                  <div className="pb-1">
                    <Toggle checked={rule.enabled} onChange={(enabled) => patchRule(rule.id, { enabled })} label={`${rule.name} enabled`} disabled={!canEdit} />
                  </div>
                  <button
                    type="button"
                    disabled={!canEdit || rule.scope === "all"}
                    title={rule.scope === "all" ? "The default tax rule cannot be deleted" : `Delete ${rule.name}`}
                    onClick={() => saveRules(rules.filter((entry) => entry.id !== rule.id))}
                    className="mb-1 rounded-lg p-2 text-ink-faint hover:bg-late-soft hover:text-late disabled:opacity-30"
                  >
                    <Icon name="trash" className="size-4" />
                  </button>
                </div>
                {rule.scope !== "all" && (
                  <div className="mt-3 border-t border-rule pt-3">
                    <p className="label">Mapped menu categories</p>
                    <div className="flex flex-wrap gap-1.5">
                      {categories.map((category) => {
                        const selected = rule.categoryIds.includes(category.id);
                        return (
                          <button
                            key={category.id}
                            type="button"
                            disabled={!canEdit}
                            onClick={() =>
                              patchRule(rule.id, {
                                categoryIds: selected ? rule.categoryIds.filter((id) => id !== category.id) : [...rule.categoryIds, category.id],
                              })
                            }
                            className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors disabled:opacity-40 ${
                              selected ? "border-brand-300 bg-brand-50 text-brand-700" : "border-rule bg-paper-raised text-ink-soft hover:bg-paper-sunken"
                            }`}
                          >
                            <span className="mr-1" aria-hidden="true">{category.icon}</span>{category.name}
                          </button>
                        );
                      })}
                    </div>
                    {!rule.categoryIds.length && <p className="mt-2 text-[11px] font-semibold text-warn">Select at least one category for this rule to match.</p>}
                  </div>
                )}
              </article>
            ))}
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="Large-party auto-gratuity" description="Automatically add gratuity when a check reaches the guest threshold." icon="users">
            <ToggleRow
              title="Enable auto-gratuity"
              description="The charge is shown as a separate line before payment."
              checked={autoGratuity}
              onChange={(value) => onChange("auto_gratuity_enabled", value)}
              disabled={!canEdit}
            />
            <div className={`mt-3 grid grid-cols-2 gap-3 border-t border-rule pt-3 ${!autoGratuity ? "opacity-50" : ""}`}>
              <NumberField
                label="Gratuity"
                value={draft.auto_gratuity_percent}
                onChange={(value) => onChange("auto_gratuity_percent", value)}
                suffix="%"
                max={100}
                disabled={!canEdit || !autoGratuity}
              />
              <NumberField
                label="Party size"
                value={draft.auto_gratuity_threshold}
                onChange={(value) => onChange("auto_gratuity_threshold", value)}
                suffix="guests"
                min={1}
                disabled={!canEdit || !autoGratuity}
              />
            </div>
            <div className="mt-3 rounded-xl bg-brand-50 p-3 text-center">
              <p className="text-[11px] font-semibold text-brand-700">Example</p>
              <p className="mt-1 text-[12px] font-extrabold text-brand-800">
                {draft.auto_gratuity_percent}% added for {draft.auto_gratuity_threshold}+ guests
              </p>
            </div>
          </Panel>

          <Panel title="Tip payout" description="Choose how credit-card tips reach the team." icon="cash">
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: "direct", title: "Direct to server", text: "Tips stay with the employee who owned the check." },
                { id: "pool", title: "Pooled tips", text: "Card tips are collected for a shift-level pool." },
              ].map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => onChange("tip_payout", option.id)}
                  className={`rounded-xl border p-3 text-left transition-colors disabled:opacity-40 ${
                    draft.tip_payout === option.id ? "border-brand-400 bg-brand-50" : "border-rule hover:bg-paper-sunken"
                  }`}
                >
                  <span className="text-[12px] font-extrabold text-ink">{option.title}</span>
                  <span className="mt-1 block text-[10px] leading-relaxed text-ink-faint">{option.text}</span>
                </button>
              ))}
            </div>
          </Panel>
        </div>
      </div>

      <Panel title="Payment terminal tip presets" description="Offer a short, consistent set of choices at checkout. Staff can always enter a custom tip." icon="card">
        <div className="flex flex-wrap items-center gap-2">
          {TIP_CHOICES.map((percent) => {
            const active = tips.includes(percent);
            return (
              <button
                key={percent}
                type="button"
                disabled={!canEdit}
                onClick={() => onChange("tip_presets", active ? tips.filter((tip) => tip !== percent).join(",") : [...tips, percent].sort((a, b) => a - b).join(","))}
                className={`flex h-11 min-w-16 items-center justify-center rounded-xl border px-3 text-[14px] font-extrabold transition-all disabled:opacity-40 ${
                  active ? "border-brand-500 bg-brand-500 text-white shadow-sm" : "border-rule bg-white text-ink-soft hover:border-brand-300"
                }`}
              >
                {percent}%
              </button>
            );
          })}
          {tips.filter((tip) => !TIP_CHOICES.includes(tip)).map((percent) => (
            <button
              key={percent}
              type="button"
              disabled={!canEdit}
              title="Remove preset"
              onClick={() => onChange("tip_presets", tips.filter((tip) => tip !== percent).join(","))}
              className="flex h-11 items-center gap-2 rounded-xl border border-brand-500 bg-brand-50 px-3 text-[14px] font-extrabold text-brand-700"
            >
              {percent}%<Icon name="close" className="size-3" />
            </button>
          ))}
          <div className="flex h-11 items-center overflow-hidden rounded-xl border border-rule bg-white focus-within:border-brand-400">
            <TextInput value={customTip} onChange={(value) => setCustomTip(value.replace(/[^\d.]/g, ""))} placeholder="Custom" inputMode="decimal" className="!w-24 !rounded-none !border-0 !shadow-none" />
            <button
              type="button"
              disabled={!canEdit || !customTip || Number(customTip) > 100}
              onClick={() => {
                const value = Number(customTip);
                if (!Number.isFinite(value) || value < 0 || value > 100) return;
                onChange("tip_presets", [...new Set([...tips, value])].sort((a, b) => a - b).join(","));
                setCustomTip("");
              }}
              className="h-full bg-paper-sunken px-3 text-[11px] font-bold text-brand-700 disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">Selected: {tips.length ? tips.map((tip) => `${tip}%`).join(" · ") : "No presets — custom tips only"}</p>
      </Panel>

      <Panel
        title="Service charges & surcharges"
        description="Configure fixed or percentage-based fees by order channel. Fixed amounts use your selected currency."
        icon="receipt"
        action={
          <AddRowButton
            disabled={!canEdit}
            onClick={() =>
              saveSurcharges([
                ...surcharges,
                { id: localId("fee"), name: "New surcharge", kind: "fixed", value: 0, appliesTo: "all", taxable: false, enabled: true },
              ])
            }
          >
            Add surcharge
          </AddRowButton>
        }
      >
        <div className="mb-3">
          <Notice tone="warn">
            Credit-card surcharges are restricted in some jurisdictions. Confirm local law and card-network rules before enabling a card fee.
          </Notice>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[850px]">
            <div className="grid grid-cols-[minmax(160px,1fr)_130px_130px_150px_90px_70px_36px] items-center gap-3 border-b border-rule px-2 pb-2 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
              <span>Fee name</span><span>Calculation</span><span>Amount / rate</span><span>Order channel</span><span>Taxable</span><span>Active</span><span />
            </div>
            {surcharges.map((rule) => (
              <div key={rule.id} className="grid grid-cols-[minmax(160px,1fr)_130px_130px_150px_90px_70px_36px] items-center gap-3 border-b border-rule px-2 py-2.5 last:border-0">
                <TextInput value={rule.name} onChange={(value) => patchSurcharge(rule.id, { name: value })} disabled={!canEdit} />
                <select className="field !py-2" value={rule.kind} disabled={!canEdit} onChange={(event) => patchSurcharge(rule.id, { kind: event.target.value as SurchargeRule["kind"] })}>
                  <option value="fixed">Fixed amount</option><option value="percent">Percentage</option>
                </select>
                <div className="relative">
                  <input className="field tnum !pr-9 !py-2" type="number" min={0} step="0.01" value={rule.value} disabled={!canEdit} onChange={(event) => patchSurcharge(rule.id, { value: Number(event.target.value) })} />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-bold text-ink-faint">{rule.kind === "percent" ? "%" : draft.currency_symbol}</span>
                </div>
                <select className="field !py-2" value={rule.appliesTo} disabled={!canEdit} onChange={(event) => patchSurcharge(rule.id, { appliesTo: event.target.value as SurchargeRule["appliesTo"] })}>
                  <option value="all">All orders</option><option value="delivery">Delivery</option><option value="takeout">Takeout</option><option value="card">Card payments</option>
                </select>
                <Toggle checked={rule.taxable} onChange={(taxable) => patchSurcharge(rule.id, { taxable })} label={`${rule.name} taxable`} disabled={!canEdit} />
                <Toggle checked={rule.enabled} onChange={(enabled) => patchSurcharge(rule.id, { enabled })} label={`${rule.name} active`} disabled={!canEdit} />
                <button type="button" disabled={!canEdit} onClick={() => saveSurcharges(surcharges.filter((entry) => entry.id !== rule.id))} className="rounded-lg p-1.5 text-ink-faint hover:bg-late-soft hover:text-late" aria-label={`Delete ${rule.name}`}>
                  <Icon name="trash" className="size-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </div>
  );
}
