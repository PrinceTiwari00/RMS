"use client";

import { Icon, TextInput, Toggle, toast } from "@/components/ui";
import {
  DEFAULT_OPERATING_HOURS,
  DEFAULT_SERVICE_PERIODS,
  WEEKDAYS,
  localId,
  parseJsonSetting,
  type OperatingDay,
  type ServicePeriod,
} from "@/domain/settings";
import {
  AddRowButton,
  DaySelector,
  Notice,
  Panel,
  SelectField,
  TextField,
  type SettingsSectionProps,
} from "./controls";

const CURRENCIES = [
  { code: "NPR", symbol: "Rs", locale: "en-IN", label: "NPR · Nepalese Rupee" },
  { code: "INR", symbol: "₹", locale: "en-IN", label: "INR · Indian Rupee" },
  { code: "USD", symbol: "$", locale: "en-US", label: "USD · US Dollar" },
  { code: "EUR", symbol: "€", locale: "en-IE", label: "EUR · Euro" },
  { code: "GBP", symbol: "£", locale: "en-GB", label: "GBP · British Pound" },
  { code: "AUD", symbol: "A$", locale: "en-AU", label: "AUD · Australian Dollar" },
];

export function StoreSection({ draft, onChange, onChangeMany, canEdit }: SettingsSectionProps) {
  const hours = parseJsonSetting<OperatingDay[]>(draft.operating_hours, DEFAULT_OPERATING_HOURS);
  const periods = parseJsonSetting<ServicePeriod[]>(draft.service_periods, DEFAULT_SERVICE_PERIODS);

  const saveHours = (next: OperatingDay[]) => onChange("operating_hours", JSON.stringify(next));
  const savePeriods = (next: ServicePeriod[]) => onChange("service_periods", JSON.stringify(next));
  const patchPeriod = (id: string, patch: Partial<ServicePeriod>) =>
    savePeriods(periods.map((period) => (period.id === id ? { ...period, ...patch } : period)));

  function uploadLogo(file: File | undefined) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast("Choose a PNG, JPEG or WebP logo", "late");
      return;
    }
    if (file.size > 250 * 1024) {
      toast("Logo must be smaller than 250 KB", "late");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onChange("logo_data_url", String(reader.result ?? ""));
    reader.onerror = () => toast("The logo could not be read", "late");
    reader.readAsDataURL(file);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(270px,.75fr)]">
        <Panel
          title="Business details"
          description="Your legal and customer-facing identity. These details appear across guest ordering and receipts."
          icon="vendor"
        >
          <div className="mb-4 flex flex-wrap items-center gap-4 rounded-xl border border-rule bg-paper p-3">
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-rule bg-white text-lg font-black text-brand-700">
              {draft.logo_data_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={draft.logo_data_url} alt="Restaurant logo preview" className="size-full object-contain" />
              ) : (
                (draft.restaurant_name || "TK").slice(0, 2).toUpperCase()
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-ink">Receipt & invoice logo</p>
              <p className="mt-0.5 text-[11px] text-ink-faint">PNG, JPEG or WebP · up to 250 KB · a square mark works best.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <label className={`btn btn-soft !px-3 !py-1.5 !text-xs ${canEdit ? "cursor-pointer" : "pointer-events-none opacity-40"}`}>
                  <Icon name="plus" className="size-3.5" />
                  {draft.logo_data_url ? "Replace logo" : "Upload logo"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    disabled={!canEdit}
                    onChange={(event) => {
                      uploadLogo(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                </label>
                {draft.logo_data_url && (
                  <button type="button" disabled={!canEdit} onClick={() => onChange("logo_data_url", "")} className="text-[11px] font-bold text-late hover:underline">
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Restaurant name" value={draft.restaurant_name} onChange={(value) => onChange("restaurant_name", value)} disabled={!canEdit} />
            <TextField label="Legal tax entity" value={draft.legal_tax_entity} onChange={(value) => onChange("legal_tax_entity", value)} disabled={!canEdit} />
            <TextField label="PAN / VAT / Tax ID" value={draft.pan_vat} onChange={(value) => onChange("pan_vat", value)} disabled={!canEdit} />
            <TextField label="Phone number" value={draft.phone} onChange={(value) => onChange("phone", value)} inputMode="tel" disabled={!canEdit} />
            <TextField
              label="Physical address"
              value={draft.address}
              onChange={(value) => onChange("address", value)}
              className="sm:col-span-2"
              disabled={!canEdit}
            />
            <TextField label="Website" value={draft.website} onChange={(value) => onChange("website", value)} inputMode="url" placeholder="https://example.com" disabled={!canEdit} />
            <TextField label="Short tagline" value={draft.restaurant_tagline} onChange={(value) => onChange("restaurant_tagline", value)} disabled={!canEdit} />
            <TextField
              label="Receipt footer"
              value={draft.receipt_footer}
              onChange={(value) => onChange("receipt_footer", value)}
              className="sm:col-span-2"
              disabled={!canEdit}
            />
            <TextField
              label="Guest Wi-Fi network (SSID)"
              value={draft.wifi_ssid ?? ""}
              onChange={(value) => onChange("wifi_ssid", value)}
              placeholder="Restaurant_Guest"
              disabled={!canEdit}
            />
            <TextField
              label="Guest Wi-Fi password"
              value={draft.wifi_password ?? ""}
              onChange={(value) => onChange("wifi_password", value)}
              placeholder="welcome2026"
              disabled={!canEdit}
            />
            <TextField
              label="Loyalty reward milestone"
              value={draft.loyalty_reward_name ?? ""}
              onChange={(value) => onChange("loyalty_reward_name", value)}
              placeholder="Free Mango Lassi"
              disabled={!canEdit}
            />
            <TextField
              label="Points needed to redeem"
              type="number"
              value={draft.loyalty_reward_points ?? "200"}
              onChange={(value) => onChange("loyalty_reward_points", value)}
              disabled={!canEdit}
            />
          </div>
        </Panel>

        <ReceiptPreview draft={draft} />
      </div>

      <Panel
        title="Operating hours"
        description="Set each day's opening and closing time. A closing time after midnight is supported for late-night service."
        icon="clock"
        action={<span className="chip border border-rule bg-paper-sunken text-ink-soft">{hours.filter((day) => !day.closed).length} days open</span>}
      >
        <div className="overflow-x-auto">
          <div className="min-w-[650px]">
            <div className="grid grid-cols-[minmax(120px,1fr)_110px_130px_24px_130px_90px] items-center gap-3 border-b border-rule px-2 pb-2 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
              <span>Day</span><span>Status</span><span>Opens</span><span /><span>Closes</span><span>Service</span>
            </div>
            {WEEKDAYS.map(({ day, label }) => {
              const config = hours.find((entry) => entry.day === day) ?? { day, open: "09:00", close: "22:00", closed: false };
              const overnight = config.close <= config.open && !config.closed;
              return (
                <div key={day} className="grid grid-cols-[minmax(120px,1fr)_110px_130px_24px_130px_90px] items-center gap-3 border-b border-rule px-2 py-2.5 last:border-0">
                  <span className="text-[13px] font-bold text-ink">{label}</span>
                  <div className="flex items-center gap-2">
                    <Toggle
                      checked={!config.closed}
                      disabled={!canEdit}
                      label={`${label} open`}
                      onChange={(open) => saveHours(hours.map((entry) => (entry.day === day ? { ...entry, closed: !open } : entry)))}
                    />
                    <span className={`text-[11px] font-semibold ${config.closed ? "text-ink-faint" : "text-ok"}`}>{config.closed ? "Closed" : "Open"}</span>
                  </div>
                  <input
                    aria-label={`${label} opening time`}
                    type="time"
                    className="field !py-1.5 tnum"
                    value={config.open}
                    disabled={!canEdit || config.closed}
                    onChange={(event) => saveHours(hours.map((entry) => (entry.day === day ? { ...entry, open: event.target.value } : entry)))}
                  />
                  <span className="text-center text-ink-faint">→</span>
                  <input
                    aria-label={`${label} closing time`}
                    type="time"
                    className="field !py-1.5 tnum"
                    value={config.close}
                    disabled={!canEdit || config.closed}
                    onChange={(event) => saveHours(hours.map((entry) => (entry.day === day ? { ...entry, close: event.target.value } : entry)))}
                  />
                  <span className={`text-[10px] font-bold ${overnight ? "text-warn" : "text-ink-faint"}`}>{config.closed ? "—" : overnight ? "+1 day" : "Same day"}</span>
                </div>
              );
            })}
          </div>
        </div>
      </Panel>

      <Panel
        title="Meal periods & menu automation"
        description="Schedule menu switches or automatic price adjustments. Overlapping periods such as Happy Hour can layer on top of Dinner."
        icon="schedule"
        action={
          <AddRowButton
            disabled={!canEdit}
            onClick={() =>
              savePeriods([
                ...periods,
                {
                  id: localId("period"),
                  name: "New service period",
                  start: "12:00",
                  end: "15:00",
                  days: [0, 1, 2, 3, 4, 5, 6],
                  behavior: "menu",
                  priceAdjustment: 0,
                  enabled: true,
                },
              ])
            }
          >
            Add period
          </AddRowButton>
        }
      >
        <div className="flex flex-col gap-2.5">
          {periods.map((period) => (
            <article key={period.id} className={`rounded-xl border p-3 ${period.enabled ? "border-rule bg-paper-raised" : "border-dashed border-rule bg-paper-sunken/60"}`}>
              <div className="grid items-end gap-3 lg:grid-cols-[minmax(140px,1fr)_110px_110px_auto_auto]">
                <TextField label="Period name" value={period.name} onChange={(value) => patchPeriod(period.id, { name: value })} disabled={!canEdit} />
                <TextField label="Starts" type="time" value={period.start} onChange={(value) => patchPeriod(period.id, { start: value })} disabled={!canEdit} />
                <TextField label="Ends" type="time" value={period.end} onChange={(value) => patchPeriod(period.id, { end: value })} disabled={!canEdit} />
                <div>
                  <span className="label">Active days</span>
                  <DaySelector days={period.days} onChange={(days) => patchPeriod(period.id, { days })} disabled={!canEdit} />
                </div>
                <div className="flex items-center justify-end gap-2 pb-1">
                  <Toggle checked={period.enabled} onChange={(enabled) => patchPeriod(period.id, { enabled })} label={`${period.name} enabled`} disabled={!canEdit} />
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => savePeriods(periods.filter((entry) => entry.id !== period.id))}
                    aria-label={`Delete ${period.name}`}
                    className="rounded-lg p-1.5 text-ink-faint hover:bg-late-soft hover:text-late disabled:opacity-40"
                  >
                    <Icon name="trash" className="size-4" />
                  </button>
                </div>
              </div>
              <div className="mt-3 grid items-end gap-3 border-t border-rule pt-3 sm:grid-cols-[minmax(200px,1fr)_160px_minmax(180px,1fr)]">
                <SelectField
                  label="When this period starts"
                  value={period.behavior}
                  onChange={(value) => patchPeriod(period.id, { behavior: value as ServicePeriod["behavior"] })}
                  options={[
                    { value: "menu", label: "Switch to its assigned menu" },
                    { value: "price_override", label: "Apply a price override" },
                  ]}
                  disabled={!canEdit}
                />
                {period.behavior === "price_override" ? (
                  <TextField
                    label="Price adjustment (%)"
                    type="number"
                    value={period.priceAdjustment}
                    onChange={(value) => patchPeriod(period.id, { priceAdjustment: Number(value) })}
                    disabled={!canEdit}
                  />
                ) : (
                  <div className="pb-2 text-[11px] font-semibold text-ink-faint">{draft.restaurant_name} · {period.name} menu</div>
                )}
                <p className="pb-2 text-[11px] text-ink-faint">
                  {period.behavior === "price_override"
                    ? `${period.priceAdjustment >= 0 ? "+" : ""}${period.priceAdjustment}% on eligible items during ${period.name}.`
                    : "The standard menu returns automatically when the period ends."}
                </p>
              </div>
            </article>
          ))}
        </div>
      </Panel>

      <Panel title="Regional & localization" description="Set how dates, money and time appear to staff and guests." icon="floor">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            label="Currency"
            value={draft.currency}
            onChange={(value) => {
              const currency = CURRENCIES.find((entry) => entry.code === value) ?? CURRENCIES[0];
              onChangeMany({ currency: currency.code, currency_symbol: currency.symbol, locale: currency.locale });
            }}
            options={CURRENCIES.map((entry) => ({ value: entry.code, label: entry.label }))}
            disabled={!canEdit}
          />
          <TextField label="Currency symbol" value={draft.currency_symbol} onChange={(value) => onChange("currency_symbol", value)} disabled={!canEdit} maxLength={5} />
          <SelectField
            label="Primary language"
            value={draft.language}
            onChange={(value) => onChangeMany({ language: value, locale: value === "ne" ? "ne-NP" : value === "hi" ? "hi-IN" : draft.locale })}
            options={[
              { value: "en", label: "English" },
              { value: "ne", label: "नेपाली · Nepali" },
              { value: "hi", label: "हिन्दी · Hindi" },
            ]}
            disabled={!canEdit}
          />
          <SelectField
            label="Date format"
            value={draft.date_format}
            onChange={(value) => onChange("date_format", value)}
            options={[
              { value: "DD MMM YYYY", label: "05 Nov 2026" },
              { value: "DD/MM/YYYY", label: "05/11/2026" },
              { value: "MM/DD/YYYY", label: "11/05/2026" },
              { value: "YYYY-MM-DD", label: "2026-11-05" },
            ]}
            disabled={!canEdit}
          />
          <SelectField
            label="Time format"
            value={draft.time_format}
            onChange={(value) => onChange("time_format", value)}
            options={[{ value: "24", label: "24-hour · 18:30" }, { value: "12", label: "12-hour · 6:30 PM" }]}
            disabled={!canEdit}
          />
          <SelectField
            label="System time zone"
            value={draft.time_zone}
            onChange={(value) => onChange("time_zone", value)}
            options={[
              { value: "Asia/Kathmandu", label: "Asia/Kathmandu · GMT+5:45" },
              { value: "Asia/Kolkata", label: "Asia/Kolkata · GMT+5:30" },
              { value: "Asia/Dubai", label: "Asia/Dubai · GMT+4" },
              { value: "Europe/London", label: "Europe/London" },
              { value: "Europe/Berlin", label: "Europe/Berlin" },
              { value: "America/New_York", label: "America/New_York" },
              { value: "America/Chicago", label: "America/Chicago" },
              { value: "America/Denver", label: "America/Denver" },
              { value: "America/Los_Angeles", label: "America/Los_Angeles" },
              { value: "Australia/Sydney", label: "Australia/Sydney" },
            ]}
            disabled={!canEdit}
          />
        </div>
        <div className="mt-3">
          <Notice tone="neutral" icon="clock">
            Business-day rollover remains at <strong>{draft.business_day_rollover}:00</strong>. Late-night checks after midnight belong to the previous business day.
          </Notice>
        </div>
      </Panel>
    </div>
  );
}

function ReceiptPreview({ draft }: { draft: Record<string, string> }) {
  const symbol = draft.currency_symbol || "Rs";
  return (
    <aside className="card overflow-hidden bg-paper-sunken/60">
      <div className="border-b border-rule px-4 py-3">
        <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint">Live receipt preview</p>
      </div>
      <div className="p-4">
        <div className="mx-auto max-w-[280px] bg-white px-5 py-5 font-mono text-[10px] leading-relaxed text-ink-soft shadow-sm">
          <div className="text-center">
            {draft.logo_data_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={draft.logo_data_url} alt="" className="mx-auto mb-2 size-10 object-contain" />
            ) : (
              <div className="mx-auto mb-2 flex size-9 items-center justify-center rounded-lg bg-brand-50 font-sans text-xs font-black text-brand-700">
                {(draft.restaurant_name || "TK").slice(0, 2).toUpperCase()}
              </div>
            )}
            <p className="font-sans text-[14px] font-black text-ink">{draft.restaurant_name || "Restaurant name"}</p>
            {draft.legal_tax_entity && <p className="mt-0.5">{draft.legal_tax_entity}</p>}
            <p className="mt-1 whitespace-pre-line">{draft.address || "Restaurant address"}</p>
            <p>{draft.phone || "Phone number"}</p>
            {draft.pan_vat && <p>PAN/VAT: {draft.pan_vat}</p>}
          </div>
          <div className="my-3 border-t border-dashed border-ink-faint" />
          <div className="flex justify-between"><span>Chicken Momo</span><span>{symbol} 320.00</span></div>
          <div className="flex justify-between"><span>Masala Chiya × 2</span><span>{symbol} 160.00</span></div>
          <div className="my-3 border-t border-dashed border-ink-faint" />
          <div className="flex justify-between"><span>Subtotal</span><span>{symbol} 480.00</span></div>
          <div className="flex justify-between"><span>Service ({draft.service_charge_rate || 0}%)</span><span>{symbol} {(480 * Number(draft.service_charge_rate || 0) / 100).toFixed(2)}</span></div>
          <div className="flex justify-between"><span>VAT ({draft.vat_rate || 0}%)</span><span>{symbol} {(480 * Number(draft.vat_rate || 0) / 100).toFixed(2)}</span></div>
          <div className="mt-2 flex justify-between border-t border-ink pt-2 text-[12px] font-black text-ink"><span>TOTAL</span><span>{symbol} {(480 * (1 + Number(draft.service_charge_rate || 0) / 100 + Number(draft.vat_rate || 0) / 100)).toFixed(2)}</span></div>
          <p className="mt-4 text-center">{draft.receipt_footer || "Thank you!"}</p>
          {draft.website && <p className="mt-1 break-all text-center text-[8px]">{draft.website}</p>}
        </div>
      </div>
    </aside>
  );
}
