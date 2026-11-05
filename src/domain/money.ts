/**
 * Money helpers.
 *
 * Every monetary value in RMS is an **integer number of paisa** (1 NPR = 100
 * paisa). Binary floating point cannot represent 0.1 exactly, and a POS that
 * rounds differently on the ticket, the receipt and the Z-report is a real
 * audit problem — so floats are only allowed at the edges (form input, JSON
 * display) and are converted immediately.
 */

export const PAISA_PER_RUPEE = 100;

/** Nepali/Indian digit grouping: 1234567 -> "12,34,567". */
const groupFormatter = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const wholeFormatter = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** Lakh/crore compact form used on KPI tiles and chart axes. */
const compactFormatter = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
});

/** Convert a rupee amount (possibly float, possibly from a form) to paisa. */
export function toPaisa(rupees: number | string | null | undefined): number {
  if (rupees === null || rupees === undefined || rupees === "") return 0;
  const value = typeof rupees === "string" ? Number.parseFloat(rupees) : rupees;
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * PAISA_PER_RUPEE);
}

/** Convert paisa back to rupees for display / JSON. */
export function toRupees(paisa: number | null | undefined): number {
  return Number(((paisa ?? 0) / PAISA_PER_RUPEE).toFixed(2));
}

export function formatMoney(paisa: number | null | undefined): string {
  return `Rs ${groupFormatter.format((paisa ?? 0) / PAISA_PER_RUPEE)}`;
}

/**
 * Compact money for KPI tiles and chart axes.
 * Below one lakh the exact grouped figure is clearer than a rounded "1L",
 * so compaction only kicks in at Rs 1,00,000.
 */
export function formatMoneyShort(paisa: number | null | undefined): string {
  const rupees = (paisa ?? 0) / PAISA_PER_RUPEE;
  const abs = Math.abs(rupees);
  if (abs >= 100_000) return `Rs ${compactFormatter.format(rupees)}`;
  if (abs >= 1000) return `Rs ${wholeFormatter.format(rupees)}`;
  return `Rs ${groupFormatter.format(rupees)}`;
}

/** Format a plain quantity (stock, hours) with sensible trimming. */
export function formatQuantity(value: number | null | undefined, digits = 2): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return "0";
  return Number.isInteger(num) ? String(num) : num.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * VAT on a paisa amount.
 * @param ratePercent  13 for Nepal VAT
 * @param inclusive    true when the supplied price already contains VAT
 */
export function vatAmount(amountPaisa: number, ratePercent: number, inclusive = false): number {
  const rate = ratePercent / 100;
  if (inclusive) {
    // price = base * (1 + rate)  ->  vat = price * rate / (1 + rate)
    return Math.round((amountPaisa * rate) / (1 + rate));
  }
  return Math.round(amountPaisa * rate);
}

/** Net (VAT-free) portion of a VAT-inclusive price. */
export function netOfVat(amountPaisa: number, ratePercent: number): number {
  return amountPaisa - vatAmount(amountPaisa, ratePercent, true);
}

export function percentOf(amountPaisa: number, percent: number): number {
  return Math.round((amountPaisa * percent) / 100);
}

/** Safe percentage used by reports; returns 0 instead of NaN/Infinity. */
export function ratioPercent(numerator: number, denominator: number, digits = 1): number {
  if (!denominator) return 0;
  const value = (numerator / denominator) * 100;
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Round-half-up to a rupee boundary, used for cash tendering. */
export function roundToRupee(paisa: number): number {
  return Math.round(paisa / PAISA_PER_RUPEE) * PAISA_PER_RUPEE;
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
