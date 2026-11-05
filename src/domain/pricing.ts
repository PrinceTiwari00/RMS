/**
 * Order pricing.
 *
 * Nepal restaurant maths: list prices are VAT-exclusive, a service charge may
 * apply to the discounted taxable base, and tips sit on top of the total
 * (never taxed). Everything is integer paisa — see `domain/money`.
 */
import { percentOf, sum, vatAmount } from "./money";

export interface PricingModifier {
  price: number;
}

export interface PricingLine {
  quantity: number;
  /** locked `price_at_time` for the base item, in paisa */
  unitPrice: number;
  modifiers?: PricingModifier[];
  isVoid?: boolean | number;
}

export interface PricingSettings {
  /** percent, e.g. 13 */
  vatRate: number;
  /** true when menu prices already contain VAT */
  vatInclusive: boolean;
  /** percent, e.g. 10 */
  serviceChargeRate: number;
}

export interface PricingResult {
  subtotal: number;
  discount: number;
  taxable: number;
  vat: number;
  serviceCharge: number;
  total: number;
  itemCount: number;
}

export const DEFAULT_PRICING: PricingSettings = {
  vatRate: 13,
  vatInclusive: false,
  serviceChargeRate: 0,
};

/** Unit price of a line, including every modifier adjustment. */
export function lineUnitPrice(line: PricingLine): number {
  return line.unitPrice + sum((line.modifiers ?? []).map((modifier) => modifier.price));
}

export function lineTotal(line: PricingLine): number {
  if (line.isVoid) return 0;
  return lineUnitPrice(line) * Math.max(0, line.quantity);
}

export function subtotalOf(lines: PricingLine[]): number {
  return sum(lines.map(lineTotal));
}

/**
 * Full ticket maths.
 * @param discountPaisa already-resolved discount amount (never negative, capped at subtotal)
 */
export function priceOrder(
  lines: PricingLine[],
  discountPaisa = 0,
  settings: PricingSettings = DEFAULT_PRICING,
  tip = 0,
): PricingResult & { tip: number; grandTotal: number } {
  const subtotal = subtotalOf(lines);
  const discount = Math.max(0, Math.min(discountPaisa, subtotal));
  const taxable = subtotal - discount;
  const vat = vatAmount(taxable, settings.vatRate, settings.vatInclusive);
  const serviceCharge = percentOf(taxable, settings.serviceChargeRate);
  const total = taxable + vat + serviceCharge;
  const itemCount = lines.reduce((count, line) => (line.isVoid ? count : count + line.quantity), 0);
  return {
    subtotal,
    discount,
    taxable,
    vat,
    serviceCharge,
    total,
    itemCount,
    tip: Math.max(0, tip),
    grandTotal: total + Math.max(0, tip),
  };
}

/**
 * VAT-inclusive menu prices need the net figure for costing and reporting.
 * Returns the {net, vat} split of a gross amount.
 */
export function splitVat(gross: number, ratePercent: number): { net: number; vat: number } {
  const vat = vatAmount(gross, ratePercent, true);
  return { net: gross - vat, vat };
}

/** Percentage or fixed discount resolved against a base amount. */
export function resolveDiscount(base: number, kind: "amount" | "percent", value: number): number {
  if (kind === "percent") return percentOf(base, Math.max(0, Math.min(100, value)));
  return Math.max(0, Math.min(base, Math.round(value)));
}

/** Suggested tip presets derived from the pre-tip total. */
export function tipSuggestions(total: number, presets: number[]): { percent: number; amount: number }[] {
  return presets.map((percent) => ({ percent, amount: percentOf(total, percent) }));
}
