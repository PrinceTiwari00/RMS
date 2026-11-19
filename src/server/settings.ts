/**
 * Business settings — a single key/value table with a typed operational
 * projection and a raw projection for the configuration portal.
 *
 * Scalar values used during service (VAT, tips, offline limits, feature flags)
 * are read through getSettings(). Extensible lists are validated JSON documents
 * so a manager can add printers, service periods or surcharge rules without a
 * schema migration. Integration secrets are write-only through the raw portal
 * projection: a saved value is replaced by a mask and is never echoed back.
 */
import { all, get, run, tx } from "@/db/client";
import type { Settings, SessionUser, StationInfo } from "@/types";
import { DEFAULT_STATIONS } from "@/domain/kds";
import { nowStamp } from "@/domain/time";
import { audit } from "@/server/audit";
import { badRequest } from "@/server/router";
import {
  DEFAULT_KDS_ROUTING,
  DEFAULT_OPERATING_HOURS,
  DEFAULT_PAYMENT_TERMINALS,
  DEFAULT_PRINTERS,
  DEFAULT_SERVICE_PERIODS,
  DEFAULT_SURCHARGES,
  DEFAULT_TAX_RULES,
  type ServiceStyle,
} from "@/domain/settings";

export const SECRET_MASK = "••••••••••••";

const DEFAULTS: Record<string, string> = {
  restaurant_name: "Terai Kitchen & Bar",
  restaurant_tagline: "Nepali · Indian · Continental",
  legal_tax_entity: "Terai Hospitality Pvt. Ltd.",
  address: "",
  phone: "",
  website: "https://teraikitchen.np",
  logo_data_url: "",
  pan_vat: "",
  currency: "NPR",
  currency_symbol: "Rs",
  locale: "en-IN",
  date_format: "DD MMM YYYY",
  time_format: "24",
  language: "en",
  time_zone: "Asia/Kathmandu",
  operating_hours: JSON.stringify(DEFAULT_OPERATING_HOURS),
  service_periods: JSON.stringify(DEFAULT_SERVICE_PERIODS),
  vat_rate: "13",
  vat_inclusive: "0",
  tax_rules: JSON.stringify(DEFAULT_TAX_RULES),
  service_charge_rate: "10",
  auto_gratuity_enabled: "0",
  auto_gratuity_percent: "18",
  auto_gratuity_threshold: "6",
  tip_presets: "15,18,20,25",
  tip_payout: "direct",
  surcharges: JSON.stringify(DEFAULT_SURCHARGES),
  operating_mode: "full_service",
  quick_checkout: "0",
  open_tabs_enabled: "1",
  print_bill_enabled: "1",
  require_manager_pin_void: "1",
  require_manager_pin_discount: "1",
  require_manager_pin_comp: "1",
  discount_reasons: "Manager Comp,Employee Meal,Promotional,Spill / Waste",
  seat_tracking_enabled: "1",
  seat_tracking_min_guests: "6",
  offline_payments_enabled: "1",
  printers: JSON.stringify(DEFAULT_PRINTERS),
  kds_routing: JSON.stringify(DEFAULT_KDS_ROUTING),
  payment_terminals: JSON.stringify(DEFAULT_PAYMENT_TERMINALS),
  cash_drawer_cash_sale: "1",
  cash_drawer_shift_close: "0",
  cash_drawer_manual_pin: "1",
  auto_lock_seconds: "300",
  pin_length: "4",
  smtp_enabled: "0",
  smtp_host: "",
  smtp_port: "587",
  smtp_username: "",
  smtp_password: "",
  smtp_from_email: "",
  smtp_from_name: "",
  sftp_enabled: "0",
  sftp_host: "",
  sftp_port: "22",
  sftp_username: "",
  sftp_private_key: "",
  sftp_path: "/incoming/edi850",
  twilio_enabled: "0",
  twilio_account_sid: "",
  twilio_auth_token: "",
  twilio_from_number: "",
  sendgrid_enabled: "0",
  sendgrid_api_key: "",
  sendgrid_from_email: "",
  notify_waitlist_sms: "1",
  notify_digital_receipts: "1",
  notify_purchase_orders: "1",
  doordash_enabled: "0",
  doordash_store_id: "",
  doordash_api_key: "",
  ubereats_enabled: "0",
  ubereats_store_id: "",
  ubereats_api_key: "",
  delivery_auto_accept: "0",
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
  wifi_ssid: "Terai_Guest",
  wifi_password: "terai2026",
  qr_require_staff_approval: "1",
  loyalty_reward_name: "Free Mango Lassi",
  loyalty_reward_points: "200",
  loyalty_points_per_100: "10",
  stations: "",
};

const SECRET_KEYS = new Set([
  "smtp_password",
  "sftp_private_key",
  "twilio_auth_token",
  "sendgrid_api_key",
  "doordash_api_key",
  "ubereats_api_key",
]);

const SECRET_ENV_KEYS: Record<string, string> = {
  smtp_password: "RMS_SMTP_PASSWORD",
  sftp_private_key: "RMS_SFTP_PRIVATE_KEY",
  twilio_auth_token: "RMS_TWILIO_AUTH_TOKEN",
  sendgrid_api_key: "RMS_SENDGRID_API_KEY",
  doordash_api_key: "RMS_DOORDASH_API_KEY",
  ubereats_api_key: "RMS_UBEREATS_API_KEY",
};

const SETTING_KEYS = new Set(Object.keys(DEFAULTS));
const BOOLEAN_KEYS = new Set([
  "vat_inclusive",
  "auto_gratuity_enabled",
  "quick_checkout",
  "open_tabs_enabled",
  "print_bill_enabled",
  "require_manager_pin_void",
  "require_manager_pin_discount",
  "require_manager_pin_comp",
  "seat_tracking_enabled",
  "offline_payments_enabled",
  "cash_drawer_cash_sale",
  "cash_drawer_shift_close",
  "cash_drawer_manual_pin",
  "smtp_enabled",
  "sftp_enabled",
  "twilio_enabled",
  "sendgrid_enabled",
  "notify_waitlist_sms",
  "notify_digital_receipts",
  "notify_purchase_orders",
  "doordash_enabled",
  "ubereats_enabled",
  "delivery_auto_accept",
  "qr_ordering_enabled",
  "cfd_enabled",
  "qr_require_staff_approval",
]);

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
  const values = new Map(rows.map((row) => [row.key, row.value]));
  // Deployment-injected credentials take precedence and need never be written
  // to SQLite. The raw portal projection still returns only a mask.
  for (const [key, environmentKey] of Object.entries(SECRET_ENV_KEYS)) {
    const injected = process.env[environmentKey];
    if (injected) values.set(key, injected);
  }
  return values;
}

function jsonObject(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, String(entry)]));
  } catch {
    return {};
  }
}

export function getSettings(): Settings {
  const values = raw();
  const read = (key: string) => values.get(key) ?? DEFAULTS[key];
  const operatingMode = read("operating_mode") as ServiceStyle;
  return {
    restaurantName: read("restaurant_name"),
    tagline: read("restaurant_tagline"),
    legalTaxEntity: read("legal_tax_entity"),
    address: read("address"),
    phone: read("phone"),
    website: read("website"),
    logoDataUrl: read("logo_data_url"),
    panVat: read("pan_vat"),
    currency: read("currency"),
    currencySymbol: read("currency_symbol"),
    locale: read("locale"),
    dateFormat: read("date_format"),
    timeFormat: read("time_format") === "12" ? "12" : "24",
    language: read("language"),
    timeZone: read("time_zone"),
    vatRate: num(read("vat_rate"), 13),
    vatInclusive: bool(read("vat_inclusive")),
    serviceChargeRate: num(read("service_charge_rate"), 10),
    tipPresets: read("tip_presets")
      .split(",")
      .map((part) => Number.parseFloat(part.trim()))
      .filter((part) => Number.isFinite(part)),
    autoGratuityEnabled: bool(read("auto_gratuity_enabled")),
    autoGratuityPercent: num(read("auto_gratuity_percent"), 18),
    autoGratuityThreshold: Math.round(num(read("auto_gratuity_threshold"), 6)),
    tipPayout: read("tip_payout") === "pool" ? "pool" : "direct",
    operatingMode: ["full_service", "quick_service", "bar_nightclub"].includes(operatingMode)
      ? operatingMode
      : "full_service",
    seatTrackingEnabled: bool(read("seat_tracking_enabled"), true),
    seatTrackingMinGuests: Math.round(num(read("seat_tracking_min_guests"), 6)),
    managerPinForVoid: bool(read("require_manager_pin_void"), true),
    managerPinForDiscount: bool(read("require_manager_pin_discount"), true),
    managerPinForComp: bool(read("require_manager_pin_comp"), true),
    offlinePaymentsEnabled: bool(read("offline_payments_enabled"), true),
    autoLockSeconds: Math.round(num(read("auto_lock_seconds"), 300)),
    pinLength: read("pin_length") === "6" ? 6 : 4,
    kdsRouting: jsonObject(read("kds_routing")),
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
    wifiSsid: read("wifi_ssid"),
    wifiPassword: read("wifi_password"),
    qrRequireStaffApproval: bool(read("qr_require_staff_approval"), true),
    loyaltyRewardName: read("loyalty_reward_name"),
    loyaltyRewardPoints: Math.max(10, Math.round(num(read("loyalty_reward_points"), 200))),
    loyaltyPointsPer100: Math.max(1, Math.round(num(read("loyalty_points_per_100"), 10))),
  };
}

/** Everything stored in the settings table, for the admin settings screen. */
export function getRawSettings(): Record<string, string> {
  const values = raw();
  const out: Record<string, string> = {};
  for (const key of SETTING_KEYS) {
    const value = values.get(key) ?? DEFAULTS[key];
    out[key] = SECRET_KEYS.has(key) && value ? SECRET_MASK : value;
  }
  return out;
}

function setSetting(key: string, value: string): void {
  run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    key,
    value,
    nowStamp(),
  );
}

function finite(value: string, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw badRequest(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function validateJson(key: string, value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw badRequest(`${key.replaceAll("_", " ")} must be valid JSON`);
  }
  if (key === "kds_routing") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw badRequest("KDS routing must be an object");
    return;
  }
  if (!Array.isArray(parsed)) throw badRequest(`${key.replaceAll("_", " ")} must be a list`);
  if (parsed.length > 100) throw badRequest(`${key.replaceAll("_", " ")} cannot contain more than 100 rows`);
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw badRequest(`${key.replaceAll("_", " ")} contains an invalid row`);
  }
  if (key === "tax_rules") {
    for (const rule of parsed as Record<string, unknown>[]) {
      finite(String(rule.rate ?? ""), `Tax rate for ${rule.name ?? "rule"}`, 0, 100);
    }
  }
  if (key === "service_periods") {
    for (const period of parsed as Record<string, unknown>[]) {
      finite(String(period.priceAdjustment ?? 0), `Price adjustment for ${period.name ?? "period"}`, -100, 100);
    }
  }
  if (key === "surcharges") {
    for (const fee of parsed as Record<string, unknown>[]) {
      finite(String(fee.value ?? ""), `Surcharge for ${fee.name ?? "rule"}`, 0, fee.kind === "percent" ? 100 : Number.MAX_SAFE_INTEGER);
    }
  }
  if (key === "printers" || key === "payment_terminals") {
    for (const device of parsed as Record<string, unknown>[]) {
      const port = finite(String(device.port ?? ""), `Port for ${device.name ?? "device"}`, 1, 65535);
      if (!Number.isInteger(port)) throw badRequest(`Port for ${device.name ?? "device"} must be a whole number`);
    }
  }
}

/** Validate one raw value before any part of a patch is written. */
export function validateSetting(key: string, value: string): void {
  if (value.length > 500_000) throw badRequest(`${key.replaceAll("_", " ")} is too large`);
  if (BOOLEAN_KEYS.has(key) && value !== "0" && value !== "1") throw badRequest(`${key.replaceAll("_", " ")} must be 0 or 1`);
  if (key === "restaurant_name" && (!value.trim() || value.length > 120)) throw badRequest("Restaurant name is required and must be at most 120 characters");
  if (["vat_rate", "service_charge_rate", "auto_gratuity_percent"].includes(key)) {
    finite(value, key.replaceAll("_", " "), 0, 100);
  }
  if (key === "auto_gratuity_threshold") finite(value, "Large party threshold", 1, 200);
  if (key === "seat_tracking_min_guests") finite(value, "Seat tracking threshold", 1, 200);
  if (key === "store_forward_limit" || key === "cash_float") finite(value, key.replaceAll("_", " "), 0);
  if (["smtp_port", "sftp_port"].includes(key)) finite(value, key.replaceAll("_", " "), 1, 65535);
  if (key === "auto_lock_seconds") {
    const seconds = finite(value, "Auto-lock timeout", 0, 3600);
    if (seconds > 0 && seconds < 15) throw badRequest("Auto-lock timeout must be at least 15 seconds, or 0 to disable");
  }
  if (key === "pin_length" && value !== "4" && value !== "6") throw badRequest("PIN length must be 4 or 6 digits");
  if (key === "operating_mode" && !["full_service", "quick_service", "bar_nightclub"].includes(value)) {
    throw badRequest("Unknown service style");
  }
  if (key === "tip_payout" && !["pool", "direct"].includes(value)) throw badRequest("Unknown tip payout mode");
  if (key === "time_format" && !["12", "24"].includes(value)) throw badRequest("Time format must be 12 or 24 hour");
  if (key === "time_zone") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
    } catch {
      throw badRequest("Choose a valid IANA time zone");
    }
  }
  if (key === "website" && value) {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
    } catch {
      throw badRequest("Website must be a complete http:// or https:// URL");
    }
  }
  if (key === "logo_data_url" && value) {
    if (!/^data:image\/(png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(value)) {
      throw badRequest("Logo must be a PNG, JPEG or WebP image");
    }
    if (value.length > 400_000) throw badRequest("Logo must be smaller than 300 KB");
  }
  if (key === "tip_presets") {
    const tips = value.split(",").filter(Boolean);
    if (tips.length > 8) throw badRequest("Use at most eight tip presets");
    for (const tip of tips) finite(tip, "Tip preset", 0, 100);
  }
  if (["loyalty_reward_points", "loyalty_points_per_100"].includes(key)) {
    finite(value, key.replaceAll("_", " "), 1, 100000);
  }
  if (["operating_hours", "service_periods", "tax_rules", "surcharges", "printers", "kds_routing", "payment_terminals"].includes(key)) {
    validateJson(key, value);
  }
}

/**
 * Apply a settings patch atomically. Unknown keys are ignored for backwards
 * compatibility. Masked secrets mean "keep the saved credential"; sending an
 * empty string deliberately clears it. Every accepted change is audited by key,
 * never by secret value.
 */
export function setSettings(patch: Record<string, unknown>, actor: SessionUser | null = null): Record<string, string> {
  const accepted: [string, string][] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTING_KEYS.has(key) || value === undefined || value === null) continue;
    if (SECRET_KEYS.has(key) && value === SECRET_MASK) continue;
    if (SECRET_KEYS.has(key) && SECRET_ENV_KEYS[key] && process.env[SECRET_ENV_KEYS[key]]) {
      throw badRequest(`${key.replaceAll("_", " ")} is managed by the deployment environment and cannot be changed here`);
    }
    const normalized = String(value);
    validateSetting(key, normalized);
    accepted.push([key, normalized]);
  }
  if (accepted.length) {
    tx(() => {
      for (const [key, value] of accepted) setSetting(key, value);
    });
    audit(actor, "admin.settings.update", "settings", null, accepted.map(([key]) => key).join(", "));
  }
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
