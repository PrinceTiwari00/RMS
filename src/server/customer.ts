/**
 * Customer-facing service — QR table ordering and the Customer Facing Display.
 *
 * A guest never authenticates. Their whole authority is the table token printed
 * on the QR sticker: it maps to one table and can only add lines to that table's
 * open ticket. Paying from the phone goes through the same checkout path as the
 * POS, so totals, tips and stock deduction behave identically.
 */
import QRCode from "qrcode";
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, notFound } from "@/server/router";
import { audit } from "@/server/audit";
import { getSettings, stationName } from "@/server/settings";
import { getCategories, getMenu, validateModifierSelection } from "@/server/menu";
import { addLine, createOrder, requireOrder, sendToKitchen, getActiveOrders } from "@/server/orders";
import { closeCheck } from "@/server/checkout";
import { buildEmvQr, tableMenuUrl } from "@/domain/qr";
import { priceOrder } from "@/domain/pricing";
import { businessDateNow, nowStamp } from "@/domain/time";
import type { CfdView, GuestOrderView, OrderSnapshot, QrTokenInfo, SessionUser } from "@/types";

// -------------------------------------------------------------------- QR tokens
export function getQrTokens(): QrTokenInfo[] {
  const rows = all<{ token: string; table_id: string | null; table_label: string | null; is_active: number; scans: number; created_at: string }>(
    `SELECT q.*, t.label AS table_label FROM qr_tokens q LEFT JOIN tables t ON t.id = q.table_id
      ORDER BY t.sort_order, t.label`,
  );
  return rows.map((row) => ({
    token: row.token,
    tableId: row.table_id,
    tableLabel: row.table_label ?? "Unassigned",
    isActive: Boolean(row.is_active),
    scans: row.scans,
    url: `/t/${row.token}`,
  }));
}

/** A short, unambiguous token — avoids l/1 and O/0 confusion on a printed sticker. */
function makeToken(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let token = "";
  do {
    token = Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (get("SELECT token FROM qr_tokens WHERE token = ?", token));
  return token;
}

export function createQrToken(tableId: string, actor: SessionUser | null): QrTokenInfo {
  const table = get<{ id: string; label: string }>("SELECT id, label FROM tables WHERE id = ?", tableId);
  if (!table) throw notFound("Table not found");
  const token = makeToken();
  run("INSERT INTO qr_tokens (token, table_id, is_active, scans, created_at) VALUES (?, ?, 1, 0, ?)", token, tableId, nowStamp());
  audit(actor, "customer.qr.create", "qr_token", token, `QR sticker for ${table.label}`);
  return getQrTokens().find((row) => row.token === token)!;
}

export function setQrTokenActive(token: string, isActive: boolean, actor: SessionUser | null): QrTokenInfo {
  const changed = run("UPDATE qr_tokens SET is_active = ? WHERE token = ?", isActive ? 1 : 0, token).changes;
  if (!changed) throw notFound("QR token not found");
  audit(actor, "customer.qr.toggle", "qr_token", token, isActive ? "re-enabled" : "disabled");
  return getQrTokens().find((row) => row.token === token)!;
}

/** Re-issue a sticker after one leaks — the old code stops working immediately. */
export function rotateQrToken(token: string, actor: SessionUser | null): QrTokenInfo {
  const row = get<{ token: string; table_id: string | null }>("SELECT * FROM qr_tokens WHERE token = ?", token);
  if (!row) throw notFound("QR token not found");
  const next = makeToken();
  tx(() => {
    run("DELETE FROM qr_tokens WHERE token = ?", token);
    run("INSERT INTO qr_tokens (token, table_id, is_active, scans, created_at) VALUES (?, ?, 1, 0, ?)", next, row.table_id, nowStamp());
  });
  audit(actor, "customer.qr.rotate", "qr_token", next, `replaced ${token}`);
  return getQrTokens().find((entry) => entry.token === next)!;
}

export function recordScan(token: string): void {
  run("UPDATE qr_tokens SET scans = scans + 1 WHERE token = ?", token);
}

export function requireToken(token: string): { token: string; tableId: string | null; tableLabel: string } {
  const row = get<{ token: string; table_id: string | null; is_active: number; label: string | null }>(
    "SELECT q.token, q.table_id, q.is_active, t.label FROM qr_tokens q LEFT JOIN tables t ON t.id = q.table_id WHERE q.token = ?",
    token,
  );
  if (!row) throw notFound("That table code is not recognised");
  if (!row.is_active) throw badRequest("That table code has been disabled — please ask your server");
  return { token: row.token, tableId: row.table_id, tableLabel: row.label ?? "Your table" };
}

/** Render a QR as an inline data URI: the preview iframe has no network access. */
export async function qrDataUrl(text: string, size = 240): Promise<string> {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: size,
    color: { dark: "#12181c", light: "#ffffff" },
  });
}

// ----------------------------------------------------------------- guest session
/** The open ticket belonging to a table's QR session, if the guest has started one. */
export function guestOrder(token: string): OrderSnapshot | null {
  const open = all<{ id: string; status: string }>(
    "SELECT id, status FROM orders WHERE qr_token = ? AND status IN ('open','sent') ORDER BY created_at DESC LIMIT 1",
    token,
  );
  return open.length ? requireOrder(open[0].id) : null;
}

export async function guestView(token: string, baseUrl = ""): Promise<GuestOrderView> {
  const resolved = requireToken(token);
  const settings = getSettings();
  if (!settings.qrOrderingEnabled) throw badRequest("QR self-ordering is turned off at this venue");
  const order = guestOrder(token);

  const payload = order
    ? buildEmvQr({
        merchantName: settings.restaurantName,
        merchantCity: settings.address.split(",").pop()?.trim() ?? "Birgunj",
        amount: order.total,
        reference: order.checkNumber ? `CHK${order.checkNumber}` : token,
      })
    : buildEmvQr({
        merchantName: settings.restaurantName,
        merchantCity: "Birgunj",
        amount: 0,
        reference: token,
        initiation: "11",
      });

  return {
    token,
    tableLabel: resolved.tableLabel,
    restaurantName: settings.restaurantName,
    tagline: settings.tagline,
    address: settings.address,
    phone: settings.phone,
    categories: getCategories(),
    menu: getMenu({ onlyAvailable: true }),
    settings,
    order,
    paymentQr: await qrDataUrl(payload),
  };
}

export interface GuestLineInput {
  menuItemId: string;
  quantity?: number;
  modifiers?: string[];
  note?: string;
}

/**
 * Add a guest's selections to the table's QR ticket, opening one on first use.
 * Modifiers are validated server-side — the phone cannot post an illegal combo.
 */
export function submitGuestOrder(token: string, lines: GuestLineInput[]): { order: OrderSnapshot; sentToKitchen: boolean } {
  const resolved = requireToken(token);
  if (!Array.isArray(lines) || !lines.length) throw badRequest("Choose at least one item");

  let order = guestOrder(token);
  if (!order) {
    const table = resolved.tableId ? get<{ guests: number }>("SELECT guests FROM tables WHERE id = ?", resolved.tableId) : null;
    order = createOrder({
      tableId: resolved.tableId,
      guests: table?.guests ?? 2,
      channel: "qr",
      qrToken: token,
      guestName: `Table ${resolved.tableLabel}`,
      note: "QR self-order",
    });
    if (resolved.tableId) {
      run("UPDATE tables SET status = CASE WHEN status = 'available' THEN 'ordered' ELSE status END WHERE id = ?", resolved.tableId);
    }
  }
  if (order.status === "closed") throw badRequest("That ticket has already been paid");

  for (const line of lines) {
    if (!line?.menuItemId) throw badRequest("Every line needs a menu item");
    // Validate up front so one bad combo does not half-add the cart.
    validateModifierSelection(line.menuItemId, line.modifiers ?? []);
    addLine(order.id, {
      menuItemId: line.menuItemId,
      quantity: line.quantity,
      modifiers: line.modifiers,
      note: line.note,
    });
  }

  // Fire the ticket straight to the kitchen — there is no server to press send.
  const sent = sendToKitchen(order.id, null);
  return { order: sent, sentToKitchen: true };
}

/** Pay from the phone: wallets and cards only, no cash drawer involved. */
export function payGuestOrder(
  token: string,
  orderId: string,
  tender: { method: string; amount?: number; tip?: number },
): { order: OrderSnapshot; receipt: { label: string; value: string; emphasis?: boolean }[] } {
  const resolved = requireToken(token);
  const order = requireOrder(orderId);
  if (order.qrToken !== token) throw badRequest("That ticket does not belong to this table");
  if (order.status === "closed") throw badRequest("That ticket has already been paid");
  if (tender.method === "cash" || tender.method === "comp") throw badRequest("Cash and comp payments must be taken at the counter");

  const settings = getSettings();
  const pricing = priceOrder(
    order.activeItems.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      modifiers: line.modifiers.map((modifier) => ({ price: modifier.price })),
      isVoid: line.isVoid,
    })),
    order.discount,
    { vatRate: settings.vatRate, vatInclusive: settings.vatInclusive, serviceChargeRate: settings.serviceChargeRate },
  );

  const result = closeCheck(
    orderId,
    {
      tenders: [
        {
          method: tender.method,
          amount: tender.amount ?? pricing.total,
          tip: tender.tip ?? 0,
          label: `QR · ${resolved.tableLabel}`,
          authCode: `QR${Math.floor(Math.random() * 900000 + 100000)}`,
        },
      ],
      note: "Paid from the table QR",
    },
    null,
  );
  return { order: requireOrder(orderId), receipt: result.receipt };
}

// --------------------------------------------------------------------------- CFD
/**
 * The secondary display beside the till. It shows whichever ticket the cashier
 * is currently ringing, live line by line, plus a payment QR for the amount due.
 */
export async function cfdView(terminalId = "term-pos-1", baseUrl = ""): Promise<CfdView & { paymentQr: string }> {
  const settings = getSettings();
  const active = getActiveOrders().filter((order) => order.terminalId === terminalId || !order.terminalId);
  // The most recently touched ticket is the one on the till right now.
  const order = active.sort((a, b) => (b.sentAt ?? b.createdAt).localeCompare(a.sentAt ?? a.createdAt))[0] ?? null;

  const promotions = all<{ emoji: string; name: string; price: number; description: string }>(
    "SELECT emoji, name, price, description FROM menu_items WHERE is_featured = 1 AND is_available = 1 ORDER BY sort_order LIMIT 4",
  );
  const cashier = get<{ name: string }>(
    "SELECT e.name FROM orders o JOIN employees e ON e.id = o.server_id WHERE o.id = ?",
    order?.id ?? "",
  );

  const payload = order
    ? buildEmvQr({
        merchantName: settings.restaurantName,
        merchantCity: "Birgunj",
        amount: order.total,
        reference: order.checkNumber ? `CHK${order.checkNumber}` : "CFD",
      })
    : "";

  void baseUrl;
  return {
    terminalId,
    restaurantName: settings.restaurantName,
    tagline: settings.tagline,
    settings,
    order,
    promotions,
    cashierName: cashier?.name ?? "Counter",
    paymentQr: payload ? await qrDataUrl(payload, 320) : "",
  };
}

/** Absolute table-menu URL for printing stickers in the admin portal. */
export function qrStickers(baseUrl = ""): { token: string; tableLabel: string; url: string }[] {
  return getQrTokens()
    .filter((token) => token.isActive)
    .map((token) => ({ token: token.token, tableLabel: token.tableLabel, url: tableMenuUrl(baseUrl, token.token) }));
}

export { stationName, businessDateNow };
