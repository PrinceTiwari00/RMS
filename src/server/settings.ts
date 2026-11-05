/**
 * Business settings — a single key/value table with a typed projection.
 *
 * Everything a restaurant legitimately needs to change without a code deploy
 * lives here: VAT rate, service charge, tip presets, labour target band, cash
 * float, offline card risk limit, feature flags for QR ordering and the CFD.
 */
import { all, get, run } from "@/db/client";
import type { Settings, SessionUser, StationInfo } from "@/types";
import { DEFAULT_STATIONS } from "@/domain/kds";
import { nowStamp } from "@/domain/time";
import { audit } from "@/server/audit";

const DEFAULTS: Record<string, string> = {
  restaurant_name: "Terai Kitchen & Bar",
  restaurant_tagline: "Nepali · Indian · Continental",
  address: "",
  phone: "",
  pan_vat: "",
  currency: "NPR",
  currency_symbol: "Rs",
  locale: "en-IN",
  vat_rate: "13",
  vat_inclusive: "0",
  service_charge_rate: "10",
  tip_presets: "5,10,15",
  cash_float: "1500000",
  business_day_rollover: "4",
  kds_warn_minutes: "8",
  kds_late_minutes: "15",
  labor_target_min: "15",
  labor_target_max: "22",
  store_forward_limit: "5000000",
  receipt_footer: "Thank you! Dhanyabad.",
  qr_ordering_enabled: "1",
  cfd_enabled: "1",
  stations: "",
};

const SETTING_KEYS = new Set(Object.keys(DEFAULTS));

function num(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function raw(): Map<string, string> {
  const rows = all<{ key: string; value: string }>("SELECT key, value FROM settings");
  return new Map(rows.map((row) => [row.key, row.value]));
}

export function getSettings(): Settings {
  const values = raw();
  const read = (key: string) => values.get(key) ?? DEFAULTS[key];
  return {
    restaurantName: read("restaurant_name"),
    tagline: read("restaurant_tagline"),
    address: read("address"),
    phone: read("phone"),
    panVat: read("pan_vat"),
    currency: read("currency"),
    currencySymbol: read("currency_symbol"),
    locale: read("locale"),
    vatRate: num(read("vat_rate"), 13),
    vatInclusive: bool(read("vat_inclusive")),
    serviceChargeRate: num(read("service_charge_rate"), 10),
    tipPresets: read("tip_presets")
      .split(",")
      .map((part) => Number.parseFloat(part.trim()))
      .filter((part) => Number.isFinite(part)),
    cashFloat: Math.round(num(read("cash_float"), 1_500_000)),
    businessDayRollover: num(read("business_day_rollover"), 4),
    kdsWarnMinutes: num(read("kds_warn_minutes"), 8),
    kdsLateMinutes: num(read("kds_late_minutes"), 15),
    laborTargetMin: num(read("labor_target_min"), 15),
    laborTargetMax: num(read("labor_target_max"), 22),
    storeForwardLimit: Math.round(num(read("store_forward_limit"), 5_000_000)),
    receiptFooter: read("receipt_footer"),
    qrOrderingEnabled: bool(read("qr_ordering_enabled"), true),
    cfdEnabled: bool(read("cfd_enabled"), true),
  };
}

/** Everything stored in the settings table, for the admin settings screen. */
export function getRawSettings(): Record<string, string> {
  const values = raw();
  const out: Record<string, string> = {};
  for (const key of SETTING_KEYS) out[key] = values.get(key) ?? DEFAULTS[key];
  return out;
}

export function setSetting(key: string, value: string): void {
  run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, value, nowStamp());
}

/**
 * Apply a settings patch. Unknown keys are ignored rather than erroring, so an
 * older client cannot wedge the admin screen. Every accepted change is audited.
 */
export function setSettings(patch: Record<string, unknown>, actor: SessionUser | null = null): Record<string, string> {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTING_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    setSetting(key, String(value));
    changed.push(key);
  }
  if (changed.length) audit(actor, "admin.settings.update", "settings", null, changed.join(", "));
  return getRawSettings();
}

export function getStations(): StationInfo[] {
  const stored = get<{ value: string }>("SELECT value FROM settings WHERE key = 'stations'")?.value;
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as StationInfo[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      /* fall through to the canonical list */
    }
  }
  return DEFAULT_STATIONS.map((station) => ({ ...station }));
}

export function stationName(id: string): string {
  return getStations().find((station) => station.id === id)?.name ?? id;
}

export function pricingSettings(): { vatRate: number; vatInclusive: boolean; serviceChargeRate: number } {
  const settings = getSettings();
  return {
    vatRate: settings.vatRate,
    vatInclusive: settings.vatInclusive,
    serviceChargeRate: settings.serviceChargeRate,
  };
}
