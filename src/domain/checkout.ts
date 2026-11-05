/**
 * Checkout: split strategies, tender validation and change due.
 *
 * A check may be settled with several tenders (split cash + card, three guests
 * paying separately). Each tender becomes its own `payments` row so the Z-report
 * can reconcile the drawer by tender type, and tips are recorded per tender for
 * card tip-adjust at shift close.
 */
import { sum } from "./money";

const rupeeFormatter = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export type TenderMethod = "cash" | "card" | "gift_card" | "wallet" | "esewa" | "khalti" | "comp";

export const TENDER_METHODS: { id: TenderMethod; label: string; icon: string }[] = [
  { id: "cash", label: "Cash", icon: "💵" },
  { id: "card", label: "Card", icon: "💳" },
  { id: "esewa", label: "eSewa", icon: "📱" },
  { id: "khalti", label: "Khalti", icon: "📱" },
  { id: "wallet", label: "QR / Wallet", icon: "🔳" },
  { id: "gift_card", label: "Gift card", icon: "🎁" },
  { id: "comp", label: "Comp", icon: "🚫" },
];

export interface Tender {
  method: TenderMethod;
  /** paisa applied to the check */
  amount: number;
  /** paisa tip attached to this tender */
  tip?: number;
  label?: string;
  authCode?: string;
  last4?: string;
}

export type SplitMode = "none" | "even" | "seat" | "item";

export interface SplitLine {
  id: string;
  name: string;
  quantity: number;
  seat: number;
  /** paisa, includes modifiers */
  amount: number;
}

export interface SplitBucket {
  key: string;
  label: string;
  lines: SplitLine[];
  subtotal: number;
  /** allocated share of VAT + service charge + discount */
  vat: number;
  serviceCharge: number;
  discount: number;
  total: number;
}

/**
 * Distribute a whole-ticket amount (VAT, service charge, discount) across
 * buckets proportionally to their subtotals, pushing the rounding remainder into
 * the last bucket so the parts always add back up to the whole exactly.
 */
export function allocate(amount: number, weights: number[]): number[] {
  const totalWeight = sum(weights);
  if (!totalWeight || !amount) return weights.map(() => 0);
  const shares = weights.map((weight) => Math.floor((amount * weight) / totalWeight));
  const remainder = amount - sum(shares);
  for (let index = 0; index < remainder; index += 1) {
    shares[index % shares.length] += 1;
  }
  return shares;
}

/** Group ticket lines into split buckets for the requested mode. */
export function buildSplit(
  lines: SplitLine[],
  mode: SplitMode,
  extras: { vat: number; serviceCharge: number; discount: number },
): SplitBucket[] {
  if (mode === "none") return [];

  const buckets = new Map<string, SplitBucket>();
  for (const line of lines) {
    const key = mode === "seat" ? `seat-${line.seat || 1}` : mode === "item" ? `line-${line.id}` : "even";
    const bucket =
      buckets.get(key) ??
      ({ key, label: "", lines: [], subtotal: 0, vat: 0, serviceCharge: 0, discount: 0, total: 0 } as SplitBucket);
    bucket.lines.push(line);
    bucket.subtotal += line.amount;
    buckets.set(key, bucket);
  }

  // Even split: divide every line equally across the number of guests.
  if (mode === "even") {
    const seats = new Set(lines.map((line) => line.seat || 1));
    const guestCount = Math.max(1, seats.size);
    const shared = buckets.get("even");
    if (shared) {
      shared.lines = [];
      for (const line of lines) {
        const perGuest = Math.floor(line.amount / guestCount);
        for (let index = 0; index < guestCount; index += 1) {
          const remainder = index === guestCount - 1 ? line.amount - perGuest * guestCount : 0;
          shared.lines.push({
            ...line,
            quantity: line.quantity / guestCount,
            amount: perGuest + remainder,
          });
        }
      }
      shared.subtotal = sum(shared.lines.map((line) => line.amount));
      const perGuestTotal = Math.floor(shared.subtotal / guestCount);
      buckets.clear();
      for (let index = 0; index < guestCount; index += 1) {
        const remainder = index === guestCount - 1 ? shared.subtotal - perGuestTotal * guestCount : 0;
        buckets.set(`guest-${index + 1}`, {
          key: `guest-${index + 1}`,
          label: `Guest ${index + 1}`,
          lines: shared.lines.filter((line) => (line.seat || 1) === index + 1),
          subtotal: perGuestTotal + remainder,
          vat: 0,
          serviceCharge: 0,
          discount: 0,
          total: 0,
        });
      }
    }
  }

  const ordered = [...buckets.values()];
  ordered.forEach((bucket, index) => {
    if (!bucket.label) {
      bucket.label =
        mode === "seat"
          ? `Seat ${bucket.key.replace("seat-", "")}`
          : mode === "item"
            ? `Ticket ${index + 1}`
            : bucket.key;
    }
  });

  const weights = ordered.map((bucket) => bucket.subtotal);
  const vatShares = allocate(extras.vat, weights);
  const serviceShares = allocate(extras.serviceCharge, weights);
  const discountShares = allocate(extras.discount, weights);
  ordered.forEach((bucket, index) => {
    bucket.vat = vatShares[index];
    bucket.serviceCharge = serviceShares[index];
    bucket.discount = discountShares[index];
    bucket.total = bucket.subtotal + bucket.vat + bucket.serviceCharge - bucket.discount;
  });

  return ordered;
}

export interface TenderSummary {
  due: number;
  applied: number;
  tips: number;
  remaining: number;
  changeDue: number;
  overTendered: boolean;
  valid: boolean;
}

/** Validate a set of tenders against an amount due. */
export function summarizeTenders(duePaisa: number, tenders: Tender[]): TenderSummary {
  const applied = sum(tenders.map((tender) => Math.max(0, tender.amount)));
  const tips = sum(tenders.map((tender) => Math.max(0, tender.tip ?? 0)));
  const remaining = duePaisa - applied;
  const cashTenders = tenders.filter((tender) => tender.method === "cash");
  // Only cash may over-tender (that is how change works).
  const changeDue = remaining < 0 && cashTenders.length ? -remaining : 0;
  return {
    due: duePaisa,
    applied,
    tips,
    remaining,
    changeDue,
    overTendered: remaining < 0,
    valid: remaining <= 0 && tenders.every((tender) => tender.amount > 0 || tender.method === "comp"),
  };
}

/** Round-up steps in paisa: Rs 10, 50, 100, 500, 1,000, 5,000. */
const ROUND_UP_STEPS = [1_000, 5_000, 10_000, 50_000, 100_000, 500_000];

/**
 * Cash quick-tender buttons: the exact amount plus progressively rounder sums a
 * guest would actually hand over. Only genuine round-ups are offered, and each
 * amount appears once.
 */
export function cashSuggestions(duePaisa: number, limit = 6): { label: string; amount: number }[] {
  if (duePaisa <= 0) return [];
  const suggestions: { label: string; amount: number }[] = [{ label: "Exact", amount: duePaisa }];
  for (const step of ROUND_UP_STEPS) {
    const amount = Math.ceil(duePaisa / step) * step;
    if (amount <= duePaisa) continue;
    if (suggestions.some((entry) => entry.amount === amount)) continue;
    suggestions.push({ label: `Rs ${rupeeFormatter.format(amount / 100)}`, amount });
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}
