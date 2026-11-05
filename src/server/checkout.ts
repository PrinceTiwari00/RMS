/**
 * Checkout service.
 *
 * Closing a check is the one operation that must never half-happen: tenders,
 * the frozen money snapshot, BOM stock deduction, the audit trail and the table
 * state change all commit together or not at all. Tips are stored per tender so
 * card tip-adjust and the nightly tip payout both have a source of truth.
 */
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, notFound } from "@/server/router";
import { audit } from "@/server/audit";
import { getSettings } from "@/server/settings";
import { requireOrder, getOrder } from "@/server/orders";
import { deductForOrder } from "@/server/inventory";
import { buildSplit, summarizeTenders, type SplitMode, type Tender, type TenderMethod } from "@/domain/checkout";
import { buildEmvQr } from "@/domain/qr";
import QRCode from "qrcode";

/** A tender as persisted, with its receipt identity attached. */
export interface RecordedTender extends Tender {
  id: string;
  status: string;
  createdAt: string;
}
import { priceOrder } from "@/domain/pricing";
import { businessDateNow, nowStamp } from "@/domain/time";
import type { OrderSnapshot, SessionUser } from "@/types";
import type { SplitBucket } from "@/domain/checkout";

/** Store-and-forward risk cap for offline card authorisations. */
export function offlineExposure(): { held: number; limit: number; available: number } {
  const settings = getSettings();
  const held = Number(
    get<{ total: number }>("SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'stored'")?.total ?? 0,
  );
  return { held, limit: settings.storeForwardLimit, available: Math.max(0, settings.storeForwardLimit - held) };
}

export interface SplitPreview {
  mode: SplitMode;
  buckets: SplitBucket[];
  totals: OrderSnapshot;
}

/** Live split preview for the checkout screen — nothing is written. */
export function previewSplit(orderId: string, mode: SplitMode): SplitPreview {
  const order = requireOrder(orderId);
  const buckets = buildSplit(
    order.activeItems.map((line) => ({
      id: line.id,
      name: line.name,
      quantity: line.quantity,
      seat: line.seat || 1,
      amount: line.lineTotal,
    })),
    mode,
    { vat: order.vat, serviceCharge: order.serviceCharge, discount: order.discount },
  );
  return { mode, buckets, totals: order };
}

export interface CloseInput {
  tenders: { method: string; amount: number; tip?: number; label?: string; authCode?: string; last4?: string }[];
  /** Force-close a ticket whose kitchen lines are not all ready (manager only). */
  force?: boolean;
  note?: string;
}

export interface CloseResult {
  orderId: string;
  checkNumber: number | null;
  tableLabel: string;
  subtotal: number;
  discount: number;
  vat: number;
  serviceCharge: number;
  tip: number;
  total: number;
  grandTotal: number;
  changeDue: number;
  tenders: RecordedTender[];
  stockMovements: number;
  closedAt: string;
  receipt: ReceiptLine[];
}

export interface ReceiptLine {
  label: string;
  value: string;
  emphasis?: boolean;
}

export function closeCheck(orderId: string, input: CloseInput, actor: SessionUser | null): CloseResult {
  const order = requireOrder(orderId);
  if (order.status === "closed") throw badRequest("That check is already closed");
  if (!order.activeItems.length) throw badRequest("An empty ticket cannot be checked out");

  if (order.status === "sent" && !order.allReady && !input.force) {
    const outstanding = order.activeItems.filter((line) => line.kdsStatus !== "READY");
    throw badRequest(
      `${outstanding.length} item(s) are not ready yet: ${outstanding.map((line) => line.name).join(", ")}`,
    );
  }

  const settings = getSettings();
  const pricing = priceOrder(
    order.items.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      modifiers: line.modifiers.map((modifier) => ({ price: modifier.price })),
      isVoid: line.isVoid,
    })),
    order.discount,
    { vatRate: settings.vatRate, vatInclusive: settings.vatInclusive, serviceChargeRate: settings.serviceChargeRate },
  );

  const tenders: Tender[] = (input.tenders ?? []).map((tender) => ({
    method: normalizeMethod(tender.method),
    amount: Math.round(Number(tender.amount ?? 0)),
    tip: Math.round(Number(tender.tip ?? 0)),
    label: String(tender.label ?? ""),
    authCode: tender.authCode ?? undefined,
    last4: tender.last4 ?? undefined,
  }));

  if (!tenders.length) throw badRequest("Choose at least one payment method");
  for (const tender of tenders) {
    if (tender.amount <= 0 && tender.method !== "comp") throw badRequest("Tender amount must be greater than zero");
  }

  const summary = summarizeTenders(pricing.total, tenders);
  if (summary.remaining > 0) {
    throw badRequest(`Short by Rs ${(summary.remaining / 100).toFixed(2)} — the check total is Rs ${(pricing.total / 100).toFixed(2)}`);
  }
  // Only cash can over-tender; a card terminal cannot give change back.
  const nonCashOver = tenders.filter((tender) => tender.method !== "cash").reduce((total, tender) => total + tender.amount, 0);
  if (nonCashOver > pricing.total && tenders.every((tender) => tender.method !== "cash")) {
    throw badRequest("A card or wallet tender cannot exceed the amount due");
  }

  const storedExposure = offlineExposure();
  const offlineTenders = tenders.filter((tender) => tender.method === "card" && tender.authCode?.startsWith("OFFLINE"));
  const offlineAmount = offlineTenders.reduce((total, tender) => total + tender.amount, 0);
  if (offlineAmount > storedExposure.available) {
    throw badRequest(`Store-and-forward risk limit reached (Rs ${(storedExposure.available / 100).toFixed(2)} available)`);
  }

  const businessDate = order.businessDate ?? businessDateNow();
  const stamp = nowStamp();
  const tipTotal = tenders.reduce((total, tender) => total + (tender.tip ?? 0), 0);
  const paymentIds: string[] = [];

  const movements = tx(() => {
    for (const tender of tenders) {
      const paymentId = uuid();
      paymentIds.push(paymentId);
      const isOffline = tender.method === "card" && tender.authCode?.startsWith("OFFLINE");
      run(
        `INSERT INTO payments (id, order_id, method, amount, tip, status, label, auth_code, last4, card_token, created_at, business_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        paymentId,
        orderId,
        tender.method,
        tender.amount,
        tender.tip ?? 0,
        isOffline ? "stored" : "captured",
        tender.label ?? "",
        tender.authCode ?? null,
        tender.last4 ?? null,
        isOffline ? `tok_${uuid().slice(0, 12)}` : null,
        stamp,
        businessDate,
      );
    }

    // Freeze the money snapshot on the ticket.
    const closed = run(
      `UPDATE orders SET status = 'closed', subtotal = ?, discount = ?, vat = ?, service_charge = ?, tip = ?, total = ?,
         closed_at = ?, note = COALESCE(NULLIF(?, ''), note), business_date = ?
        WHERE id = ? AND status IN ('open','sent')`,
      pricing.subtotal,
      pricing.discount,
      pricing.vat,
      pricing.serviceCharge,
      tipTotal,
      pricing.total + tipTotal,
      stamp,
      input.note ?? "",
      businessDate,
      orderId,
    ).changes;
    if (!closed) throw badRequest("That ticket has already been closed");

    // Consume the ingredients now that the sale is real.
    const deducted = deductForOrder(orderId, actor);

    // Walk the table through billed -> dirty inside the same transaction.
    if (order.tableId) {
      const table = get<{ status: string }>("SELECT status FROM tables WHERE id = ?", order.tableId);
      if (table && table.status === "ordered") {
        run("UPDATE tables SET status = 'billed' WHERE id = ?", order.tableId);
      }
      const after = get<{ status: string }>("SELECT status FROM tables WHERE id = ?", order.tableId);
      if (after && after.status === "billed") {
        run("UPDATE tables SET status = 'dirty' WHERE id = ?", order.tableId);
      }
      run("UPDATE tables SET guests = 0, seated_at = NULL WHERE id = ? AND status = 'dirty'", order.tableId);
    }
    return deducted;
  });

  audit(
    actor,
    "pos.checkout",
    "order",
    orderId,
    `check ${order.checkNumber ?? ""} closed for Rs ${((pricing.total + tipTotal) / 100).toFixed(2)} via ${tenders.map((tender) => tender.method).join("+")}`,
  );

  return {
    orderId,
    checkNumber: order.checkNumber,
    tableLabel: order.tableLabel,
    subtotal: pricing.subtotal,
    discount: pricing.discount,
    vat: pricing.vat,
    serviceCharge: pricing.serviceCharge,
    tip: tipTotal,
    total: pricing.total,
    grandTotal: pricing.total + tipTotal,
    changeDue: summary.changeDue,
    tenders: all<{ id: string; method: string; amount: number; tip: number; label: string; status: string; created_at: string }>(
      "SELECT * FROM payments WHERE order_id = ? ORDER BY created_at",
      orderId,
    ).map((row) => ({
      id: row.id,
      method: row.method as TenderMethod,
      amount: row.amount,
      tip: row.tip,
      label: row.label,
      status: row.status,
      createdAt: row.created_at,
    })),
    stockMovements: movements.rows,
    closedAt: stamp,
    receipt: buildReceipt(order, pricing, tenders, settings.receiptFooter, tipTotal),
  };
}

export function buildReceipt(
  order: OrderSnapshot,
  pricing: { subtotal: number; discount: number; vat: number; serviceCharge: number; total: number },
  tenders: Tender[],
  footer: string,
  tipTotal: number,
): ReceiptLine[] {
  const settings = getSettings();
  const lines: ReceiptLine[] = [
    { label: settings.restaurantName, value: "", emphasis: true },
    { label: `Check #${order.checkNumber ?? "—"}`, value: order.tableLabel },
  ];
  for (const line of order.activeItems) {
    lines.push({ label: `${line.quantity} × ${line.name}`, value: rs(line.lineTotal) });
    for (const modifier of line.modifiers) {
      lines.push({ label: `    ${modifier.name}`, value: modifier.price ? rs(modifier.price * line.quantity) : "" });
    }
  }
  lines.push({ label: "Subtotal", value: rs(pricing.subtotal) });
  if (pricing.discount) lines.push({ label: "Discount", value: `− ${rs(pricing.discount)}` });
  if (settings.vatRate) lines.push({ label: `VAT ${settings.vatRate}%`, value: rs(pricing.vat) });
  if (pricing.serviceCharge) lines.push({ label: `Service charge ${settings.serviceChargeRate}%`, value: rs(pricing.serviceCharge) });
  lines.push({ label: "TOTAL", value: rs(pricing.total), emphasis: true });
  for (const tender of tenders) {
    lines.push({ label: `${tenderLabel(tender.method)}${tender.label ? ` · ${tender.label}` : ""}`, value: rs(tender.amount) });
    if (tender.tip) lines.push({ label: "    Tip", value: rs(tender.tip) });
  }
  if (tipTotal) lines.push({ label: "Tip total", value: rs(tipTotal) });
  const change = tenders.filter((tender) => tender.method === "cash").reduce((total, tender) => total + tender.amount, 0) - pricing.total;
  if (change > 0) lines.push({ label: "Change", value: rs(change), emphasis: true });
  lines.push({ label: settings.panVat ? `PAN/VAT ${settings.panVat}` : "", value: "" });
  lines.push({ label: footer, value: "" });
  return lines.filter((line) => line.label || line.value);
}

function rs(paisa: number): string {
  return `Rs ${(paisa / 100).toFixed(2)}`;
}

export function tenderLabel(method: string): string {
  const labels: Record<string, string> = {
    cash: "Cash",
    card: "Card",
    esewa: "eSewa",
    khalti: "Khalti",
    wallet: "QR / Wallet",
    gift_card: "Gift card",
    comp: "Comp",
  };
  return labels[method] ?? method;
}

function normalizeMethod(method: string): TenderMethod {
  const allowed = ["cash", "card", "gift_card", "wallet", "esewa", "khalti", "comp"] as const;
  return (allowed as readonly string[]).includes(method) ? (method as TenderMethod) : "cash";
}

/** Forward a store-and-forward authorisation once connectivity is restored. */
export function forwardStoredPayments(actor: SessionUser | null): { forwarded: number } {
  const rows = all<{ id: string; amount: number }>("SELECT id, amount FROM payments WHERE status = 'stored'");
  tx(() => {
    for (const row of rows) run("UPDATE payments SET status = 'captured' WHERE id = ?", row.id);
  });
  if (rows.length) audit(actor, "payments.forward", "payments", null, `${rows.length} offline authorisation(s) captured`);
  return { forwarded: rows.length };
}

/** Tip payout report for the Z-report and shift close. */
export function tipPayoutByServer(businessDate: string): { employeeId: string; name: string; tips: number; checks: number }[] {
  return all<{ employee_id: string | null; name: string | null; tips: number; checks: number }>(
    `SELECT o.server_id AS employee_id, e.name, COALESCE(SUM(p.tip), 0) AS tips, COUNT(DISTINCT o.id) AS checks
       FROM orders o
       LEFT JOIN employees e ON e.id = o.server_id
       LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.status = 'closed' AND o.business_date = ?
      GROUP BY o.server_id ORDER BY tips DESC`,
    businessDate,
  ).map((row) => ({
    employeeId: row.employee_id ?? "",
    name: row.name ?? "Unassigned",
    tips: Math.round(Number(row.tips ?? 0)),
    checks: Number(row.checks ?? 0),
  }));
}

export { getOrder, notFound };


/**
 * EMV QR for the amount still due on a check, rendered as a data URL.
 *
 * Wallets and QR are the dominant rail in Nepal, so the till needs a scannable
 * code for the exact outstanding balance — not a static merchant sticker. The
 * payload is a genuine EMVCo merchant-presented string (CRC-16 checked), so any
 * compliant acquirer app can read it.
 */
export async function paymentQr(orderId: string): Promise<{ payload: string; dataUrl: string; due: number }> {
  const order = requireOrder(orderId);
  const settings = getSettings();
  const paid = order.tenders.reduce((total, tender) => total + Math.max(0, tender.amount), 0);
  const due = Math.max(0, order.total - paid);
  const payload = buildEmvQr({
    merchantName: settings.restaurantName,
    merchantCity: "Birgunj",
    amount: due,
    reference: order.checkNumber ? `CHK${order.checkNumber}` : "TILL",
    initiation: "12",
  });
  const dataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
    color: { dark: "#12181c", light: "#ffffff" },
  });
  return { payload, dataUrl, due };
}
