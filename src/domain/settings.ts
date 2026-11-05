/**
 * Structured configuration kept in the settings key/value table.
 *
 * The operational settings used by pricing remain scalar (and are projected by
 * server/settings.ts). Lists such as service periods and printers are JSON so
 * managers can add rows without a schema migration or a code deployment.
 * These types and parsers are framework-free and safe to use in the browser.
 */

export type ServiceStyle = "full_service" | "quick_service" | "bar_nightclub";

export interface OperatingDay {
  day: number;
  open: string;
  close: string;
  closed: boolean;
}

export interface ServicePeriod {
  id: string;
  name: string;
  start: string;
  end: string;
  days: number[];
  behavior: "menu" | "price_override";
  priceAdjustment: number;
  enabled: boolean;
}

export interface TaxRule {
  id: string;
  name: string;
  rate: number;
  scope: "all" | "categories" | "exempt_categories";
  categoryIds: string[];
  enabled: boolean;
}

export interface SurchargeRule {
  id: string;
  name: string;
  kind: "percent" | "fixed";
  value: number;
  appliesTo: "all" | "delivery" | "takeout" | "card";
  taxable: boolean;
  enabled: boolean;
}

export interface PrinterConfig {
  id: string;
  name: string;
  kind: "receipt" | "grill" | "fry" | "bar" | "other";
  host: string;
  port: number;
  paperWidth: "80" | "58";
  codePage: "CP437" | "CP858" | "WPC1252" | "UTF8";
  enabled: boolean;
}

export interface PaymentTerminalConfig {
  id: string;
  name: string;
  model: string;
  connection: "ip" | "bluetooth";
  address: string;
  port: number;
  enabled: boolean;
}

export const WEEKDAYS = [
  { day: 0, short: "Sun", label: "Sunday" },
  { day: 1, short: "Mon", label: "Monday" },
  { day: 2, short: "Tue", label: "Tuesday" },
  { day: 3, short: "Wed", label: "Wednesday" },
  { day: 4, short: "Thu", label: "Thursday" },
  { day: 5, short: "Fri", label: "Friday" },
  { day: 6, short: "Sat", label: "Saturday" },
] as const;

export const DEFAULT_OPERATING_HOURS: OperatingDay[] = WEEKDAYS.map(({ day }) => ({
  day,
  open: "07:00",
  close: day === 5 || day === 6 ? "23:30" : "22:30",
  closed: false,
}));

export const DEFAULT_SERVICE_PERIODS: ServicePeriod[] = [
  {
    id: "period-breakfast",
    name: "Breakfast",
    start: "07:00",
    end: "10:30",
    days: [0, 1, 2, 3, 4, 5, 6],
    behavior: "menu",
    priceAdjustment: 0,
    enabled: true,
  },
  {
    id: "period-lunch",
    name: "Lunch",
    start: "10:30",
    end: "16:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    behavior: "menu",
    priceAdjustment: 0,
    enabled: true,
  },
  {
    id: "period-dinner",
    name: "Dinner",
    start: "16:00",
    end: "22:30",
    days: [0, 1, 2, 3, 4, 5, 6],
    behavior: "menu",
    priceAdjustment: 0,
    enabled: true,
  },
  {
    id: "period-happy-hour",
    name: "Happy Hour",
    start: "16:00",
    end: "18:00",
    days: [1, 2, 3, 4, 5],
    behavior: "price_override",
    priceAdjustment: -10,
    enabled: false,
  },
];

export const DEFAULT_TAX_RULES: TaxRule[] = [
  { id: "tax-vat", name: "Standard VAT", rate: 13, scope: "all", categoryIds: [], enabled: true },
  {
    id: "tax-alcohol",
    name: "Alcohol VAT",
    rate: 13,
    scope: "categories",
    categoryIds: ["cat-bar"],
    enabled: true,
  },
  {
    id: "tax-exempt",
    name: "Tax-exempt items",
    rate: 0,
    scope: "exempt_categories",
    categoryIds: [],
    enabled: false,
  },
];

export const DEFAULT_SURCHARGES: SurchargeRule[] = [
  {
    id: "fee-delivery",
    name: "Delivery fee",
    kind: "fixed",
    value: 100,
    appliesTo: "delivery",
    taxable: false,
    enabled: false,
  },
  {
    id: "fee-packaging",
    name: "Takeout packaging",
    kind: "fixed",
    value: 25,
    appliesTo: "takeout",
    taxable: false,
    enabled: true,
  },
];

export const DEFAULT_PRINTERS: PrinterConfig[] = [
  {
    id: "printer-receipt",
    name: "Receipt Printer",
    kind: "receipt",
    host: "192.168.1.201",
    port: 9100,
    paperWidth: "80",
    codePage: "CP437",
    enabled: true,
  },
  {
    id: "printer-grill",
    name: "Kitchen Grill",
    kind: "grill",
    host: "192.168.1.202",
    port: 9100,
    paperWidth: "80",
    codePage: "CP437",
    enabled: true,
  },
  {
    id: "printer-bar",
    name: "Bar Printer",
    kind: "bar",
    host: "192.168.1.203",
    port: 9100,
    paperWidth: "80",
    codePage: "CP437",
    enabled: false,
  },
];

export const DEFAULT_PAYMENT_TERMINALS: PaymentTerminalConfig[] = [
  {
    id: "emv-register-1",
    name: "Register 1 · EMV Reader",
    model: "Semi-integrated EMV",
    connection: "ip",
    address: "192.168.1.211",
    port: 8080,
    enabled: false,
  },
];

export const DEFAULT_KDS_ROUTING: Record<string, string> = {
  "cat-beverages": "bar",
  "cat-bar": "bar",
};

export function parseJsonSetting<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return structuredClone(fallback);
  try {
    const value = JSON.parse(raw) as unknown;
    return value as T;
  } catch {
    return structuredClone(fallback);
  }
}

export function parseCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function boolValue(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function numberValue(raw: string | undefined, fallback = 0): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function localId(prefix: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}
