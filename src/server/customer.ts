/**
 * Customer-facing service — QR table sessions, digital menu, staff-approved orders,
 * waiter calls, split billing, loyalty rewards, quiz, reviews, and CFD.
 */
import QRCode from "qrcode";
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, notFound } from "@/server/router";
import { audit } from "@/server/audit";
import { emitEvent } from "@/server/events";
import { isDemoMode } from "@/lib/session";
import { getSettings, stationName } from "@/server/settings";
import { getCategories, getMenu, validateModifierSelection } from "@/server/menu";
import { addLine, applyDiscount, createOrder, requireOrder, sendToKitchen, getActiveOrders } from "@/server/orders";
import { buildReceipt, closeCheck, tenderLabel } from "@/server/checkout";
import { deductForOrder } from "@/server/inventory";
import {
  awardPointsForOrder,
  closeTableSession,
  createServiceRequest,
  dispatchEmailReceipt,
  ensureActiveSession,
  getActiveSession,
  getReviewForOrder,
  getTableServiceRequests,
  joinTableGuest,
} from "@/server/engagement";
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

/**
 * Resolve either an opaque QR sticker token (`t16-t5`) or a short table label (`t5`, `T5`, `m1`).
 */
export function resolveToken(rawToken: string): { token: string; tableId: string | null; tableLabel: string; isActive: boolean } | null {
  const direct = get<{ token: string; table_id: string | null; is_active: number; label: string | null }>(
    "SELECT q.token, q.table_id, q.is_active, t.label FROM qr_tokens q LEFT JOIN tables t ON t.id = q.table_id WHERE q.token = ?",
    rawToken,
  );
  if (direct) {
    return {
      token: direct.token,
      tableId: direct.table_id,
      tableLabel: direct.label ?? "Your table",
      isActive: Boolean(direct.is_active),
    };
  }
  const byLabel = get<{ token: string; table_id: string | null; is_active: number; label: string }>(
    `SELECT q.token, q.table_id, q.is_active, t.label
       FROM tables t
       LEFT JOIN qr_tokens q ON q.table_id = t.id AND q.is_active = 1
      WHERE LOWER(t.label) = LOWER(?)
      ORDER BY q.created_at DESC LIMIT 1`,
    rawToken,
  );
  if (!byLabel) return null;
  if (!byLabel.token) {
    // Auto-issue a token if table exists without an active sticker yet.
    const created = createQrToken(byLabel.table_id ?? "", null);
    return { token: created.token, tableId: created.tableId, tableLabel: byLabel.label, isActive: true };
  }
  return {
    token: byLabel.token,
    tableId: byLabel.table_id,
    tableLabel: byLabel.label,
    isActive: Boolean(byLabel.is_active),
  };
}

export function recordScan(token: string): void {
  const resolved = resolveToken(token);
  if (!resolved) return;
  run("UPDATE qr_tokens SET scans = scans + 1 WHERE token = ?", resolved.token);
}

export function requireToken(token: string): { token: string; tableId: string | null; tableLabel: string } {
  const row = resolveToken(token);
  if (!row) throw notFound("That table code is not recognised");
  if (!row.isActive) throw badRequest("That table code has been disabled — please ask your server");
  return { token: row.token, tableId: row.tableId, tableLabel: row.tableLabel };
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
/** The open (or most recently closed) ticket belonging to a table's QR session. */
export function guestOrder(token: string, includeRecentClosed = false): OrderSnapshot | null {
  const resolved = resolveToken(token);
  const canonical = resolved?.token ?? token;
  const open = resolved?.tableId
    ? all<{ id: string }>(
        "SELECT id FROM orders WHERE (qr_token = ? OR table_id = ?) AND status IN ('open','sent') ORDER BY created_at DESC LIMIT 1",
        canonical,
        resolved.tableId,
      )
    : all<{ id: string }>(
        "SELECT id FROM orders WHERE qr_token = ? AND status IN ('open','sent') ORDER BY created_at DESC LIMIT 1",
        canonical,
      );
  if (open.length) return requireOrder(open[0].id);

  if (includeRecentClosed) {
    const closed = resolved?.tableId
      ? get<{ id: string }>(
          "SELECT id FROM orders WHERE (qr_token = ? OR table_id = ?) AND status = 'closed' ORDER BY closed_at DESC LIMIT 1",
          canonical,
          resolved.tableId,
        )
      : get<{ id: string }>(
          "SELECT id FROM orders WHERE qr_token = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 1",
          canonical,
        );
    if (closed) return requireOrder(closed.id);
  }
  return null;
}

/** Estimate remaining prep seconds from the active KDS queue & item prep_minutes. */
export function estimatePrepTime(order: OrderSnapshot | null): { totalSeconds: number; remainingSeconds: number } {
  if (!order || order.status === "closed" || order.allReady) {
    return { totalSeconds: 0, remainingSeconds: 0 };
  }
  const unready = order.activeItems.filter((line) => line.kdsStatus !== "READY");
  if (!unready.length) return { totalSeconds: 0, remainingSeconds: 0 };

  const itemIds = unready.map((line) => line.menuItemId).filter((id): id is string => Boolean(id));
  let maxPrepMin = 12;
  if (itemIds.length) {
    const placeholders = itemIds.map(() => "?").join(",");
    const row = get<{ max_prep: number }>(
      `SELECT COALESCE(MAX(prep_minutes), 12) AS max_prep FROM menu_items WHERE id IN (${placeholders})`,
      ...itemIds,
    );
    maxPrepMin = Math.max(4, Number(row?.max_prep ?? 12));
  }

  // Account for active queue backlog ahead of this ticket.
  const queueRow = get<{ pending: number }>(
    "SELECT COUNT(*) AS pending FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'sent' AND oi.is_void = 0 AND oi.kds_status = 'PENDING' AND o.id != ?",
    order.id,
  );
  const queuePenaltyMin = Math.min(8, Math.floor(Number(queueRow?.pending ?? 0) / 4));
  const totalSeconds = (maxPrepMin + queuePenaltyMin) * 60;

  if (order.status === "open" || !order.sentAt) {
    return { totalSeconds, remainingSeconds: totalSeconds };
  }
  const iso = order.sentAt.includes("T") ? order.sentAt : `${order.sentAt.replace(" ", "T")}Z`;
  const sentMs = Date.parse(iso);
  const elapsedSec = Number.isNaN(sentMs) ? 0 : Math.max(0, Math.floor((Date.now() - sentMs) / 1000));
  const remainingSeconds = Math.max(30, totalSeconds - elapsedSec);
  return { totalSeconds, remainingSeconds };
}

export function paidBreakdown(order: OrderSnapshot | null): { paidAmount: number; remainingDue: number } {
  if (!order) return { paidAmount: 0, remainingDue: 0 };
  const paidAmount = order.tenders
    .filter((t) => t.status !== "refunded")
    .reduce((sum, t) => sum + Math.max(0, t.amount), 0);
  const remainingDue = order.status === "closed" ? 0 : Math.max(0, order.total - paidAmount);
  return { paidAmount, remainingDue };
}

export async function guestView(token: string, baseUrl = ""): Promise<GuestOrderView> {
  const resolved = requireToken(token);
  const settings = getSettings();
  if (!settings.qrOrderingEnabled) throw badRequest("QR self-ordering is turned off at this venue");

  const session = resolved.tableId ? ensureActiveSession(resolved.tableId, resolved.token) : null;
  const order = guestOrder(resolved.token);
  const { paidAmount, remainingDue } = paidBreakdown(order);
  const prep = estimatePrepTime(order);
  const activeRequests = resolved.tableId ? getTableServiceRequests(resolved.tableId) : [];

  const payload = order
    ? buildEmvQr({
        merchantName: settings.restaurantName,
        merchantCity: settings.address.split(",").pop()?.trim() || "Birgunj",
        amount: remainingDue || order.total,
        reference: order.checkNumber ? `CHK${order.checkNumber}` : resolved.token,
      })
    : buildEmvQr({
        merchantName: settings.restaurantName,
        merchantCity: "Birgunj",
        amount: 0,
        reference: resolved.token,
        initiation: "11",
      });

  void baseUrl;
  return {
    token: resolved.token,
    tableId: resolved.tableId,
    tableLabel: resolved.tableLabel,
    restaurantName: settings.restaurantName,
    tagline: settings.tagline,
    address: settings.address,
    phone: settings.phone,
    categories: getCategories(),
    menu: getMenu({ onlyAvailable: true }),
    settings,
    session,
    order,
    paymentQr: await qrDataUrl(payload),
    activeRequests,
    estimatedRemainingSeconds: prep.remainingSeconds,
    estimatedTotalSeconds: prep.totalSeconds,
    paidAmount,
    remainingDue,
    review: order ? getReviewForOrder(order.id) : null,
  };
}

export interface GuestLineInput {
  menuItemId: string;
  quantity?: number;
  modifiers?: string[];
  note?: string;
  upsellItemId?: string | null;
}

/**
 * Add a guest's selections to the table's QR ticket, opening a session & ticket on first use.
 * When `qrRequireStaffApproval` is enabled, the ticket waits in the Staff Console queue until
 * staff taps "Send to kitchen".
 */
export function submitGuestOrder(
  token: string,
  lines: GuestLineInput[],
  meta: { guestId?: string | null; guestName?: string } = {},
): { order: OrderSnapshot; sentToKitchen: boolean; requiresStaffApproval: boolean } {
  const resolved = requireToken(token);
  if (!Array.isArray(lines) || !lines.length) throw badRequest("Choose at least one item");

  const settings = getSettings();
  const requireApproval = settings.qrRequireStaffApproval;
  const session = resolved.tableId ? ensureActiveSession(resolved.tableId, resolved.token) : null;
  const menuItems = new Map(getMenu({ onlyAvailable: true }).map((m) => [m.id, m]));

  let order = guestOrder(resolved.token);
  const guestDisplay = meta.guestName?.trim() || (session?.guests[0]?.name ?? `Table ${resolved.tableLabel}`);

  if (!order) {
    const table = resolved.tableId ? get<{ guests: number }>("SELECT guests FROM tables WHERE id = ?", resolved.tableId) : null;
    const guestCount = Math.max(table?.guests ?? 0, session?.guests.length ?? 0, 2);
    order = createOrder({
      tableId: resolved.tableId,
      guests: guestCount,
      channel: "qr",
      qrToken: resolved.token,
      sessionId: session?.id ?? null,
      guestId: meta.guestId ?? null,
      approvalStatus: requireApproval ? "pending_staff" : "approved",
      guestName: guestDisplay,
      note: "QR self-order",
    });
    if (resolved.tableId) {
      run(
        "UPDATE tables SET status = CASE WHEN status = 'available' THEN 'seated' ELSE status END, guests = MAX(guests, ?), seated_at = COALESCE(seated_at, ?) WHERE id = ?",
        guestCount,
        nowStamp(),
        resolved.tableId,
      );
    }
  }
  if (order.status === "closed") throw badRequest("That ticket has already been paid");

  const alreadySent = order.status === "sent";
  let upsellDiscountTotal = 0;

  for (const line of lines) {
    if (!line?.menuItemId) throw badRequest("Every line needs a menu item");
    validateModifierSelection(line.menuItemId, line.modifiers ?? []);
    const qty = Math.max(1, Math.round(Number(line.quantity ?? 1)));
    addLine(order.id, {
      menuItemId: line.menuItemId,
      quantity: qty,
      modifiers: line.modifiers,
      note: line.note,
      holdForApproval: alreadySent && requireApproval,
    });

    if (line.upsellItemId) {
      const parent = menuItems.get(line.menuItemId);
      const upsell = parent?.upsellItem;
      if (upsell && upsell.id === line.upsellItemId) {
        validateModifierSelection(upsell.id, []);
        addLine(order.id, {
          menuItemId: upsell.id,
          quantity: qty,
          modifiers: [],
          note: `Pairing deal (${upsell.discountPercent}% off with ${parent.name})`,
          holdForApproval: alreadySent && requireApproval,
        });
        upsellDiscountTotal += Math.max(0, upsell.price - upsell.discountedPrice) * qty;
      }
    }
  }

  if (upsellDiscountTotal > 0) {
    applyDiscount(
      order.id,
      {
        kind: "amount",
        value: upsellDiscountTotal,
        reason: "Combo pairing deal",
      },
      null,
    );
  }

  if (!requireApproval && order.status === "open") {
    const sent = sendToKitchen(order.id, null, { fireAllCourses: true });
    emitEvent("floor.updated", { tableId: resolved.tableId });
    return { order: sent, sentToKitchen: true, requiresStaffApproval: false };
  }

  const latest = requireOrder(order.id);
  emitEvent("order.created", { orderId: latest.id, tableId: resolved.tableId, sessionId: session?.id ?? null });
  emitEvent("floor.updated", { tableId: resolved.tableId });
  return {
    order: latest,
    sentToKitchen: latest.status === "sent" && latest.approvalStatus === "approved",
    requiresStaffApproval: requireApproval,
  };
}

/**
 * Pay from the phone: supports both single full payment and split-share partial payments.
 */
export function payGuestOrder(
  token: string,
  orderId: string,
  tender: {
    method: string;
    amount?: number;
    tip?: number;
    label?: string;
    guestId?: string | null;
    guestName?: string;
    email?: string;
  },
): {
  order: OrderSnapshot;
  paidInFull: boolean;
  paidAmount: number;
  remainingDue: number;
  pointsEarned: number;
  emailSent: { recipientEmail: string; status: string } | null;
  receipt: { label: string; value: string; emphasis?: boolean }[];
} {
  if (!isDemoMode()) {
    throw badRequest("Online payment verification is not configured. Please pay with staff at the counter.");
  }
  const resolved = requireToken(token);
  const order = requireOrder(orderId);
  if (order.qrToken !== resolved.token && order.tableId !== resolved.tableId) {
    throw badRequest("That ticket does not belong to this table");
  }
  if (order.status === "closed") throw badRequest("That ticket has already been paid");
  if (tender.method === "cash" || tender.method === "comp") {
    throw badRequest("Cash and comp payments must be taken at the counter");
  }

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

  const alreadyPaid = order.tenders
    .filter((t) => t.status !== "refunded")
    .reduce((sum, t) => sum + Math.max(0, t.amount), 0);
  const currentRemaining = Math.max(0, pricing.total - alreadyPaid);
  const payAmount = Math.min(currentRemaining, Math.max(1, Math.round(Number(tender.amount ?? currentRemaining))));
  const tipAmount = Math.max(0, Math.round(Number(tender.tip ?? 0)));
  const label = tender.label?.trim() || `${tender.guestName?.trim() || resolved.tableLabel} · QR`;

  const isFinal = payAmount >= currentRemaining;

  // Fast-path when no prior partial payments exist and this pays the full bill.
  if (isFinal && alreadyPaid === 0) {
    const result = closeCheck(
      orderId,
      {
        force: true,
        tenders: [
          {
            method: tender.method,
            amount: currentRemaining,
            tip: tipAmount,
            label,
            authCode: `QR${Math.floor(Math.random() * 900000 + 100000)}`,
          },
        ],
        note: "Paid from the table QR",
      },
      null,
    );
    if (resolved.tableId) closeTableSession(resolved.tableId);
    const pointsEarned = awardPointsForOrder(orderId, result.total, tender.guestId);
    const closedOrder = requireOrder(orderId);
    let emailSent: { recipientEmail: string; status: string } | null = null;
    if (tender.email?.trim()) {
      const dispatched = dispatchEmailReceipt(closedOrder, tender.email, isDemoMode());
      emailSent = { recipientEmail: dispatched.recipientEmail, status: dispatched.status };
    }
    emitEvent("payment.updated", { orderId, tableId: resolved.tableId });
    emitEvent("floor.updated", { tableId: resolved.tableId });
    return {
      order: closedOrder,
      paidInFull: true,
      paidAmount: result.total,
      remainingDue: 0,
      pointsEarned,
      emailSent,
      receipt: result.receipt,
    };
  }

  const businessDate = order.businessDate ?? businessDateNow();
  const stamp = nowStamp();

  tx(() => {
    run(
      `INSERT INTO payments (id, order_id, method, amount, tip, status, label, auth_code, created_at, business_date)
       VALUES (?, ?, ?, ?, ?, 'captured', ?, ?, ?, ?)`,
      uuid(),
      orderId,
      tender.method,
      payAmount,
      tipAmount,
      label,
      `QR${Math.floor(Math.random() * 900000 + 100000)}`,
      stamp,
      businessDate,
    );

    if (isFinal) {
      const allTenders = all<{ amount: number; tip: number }>(
        "SELECT amount, tip FROM payments WHERE order_id = ? AND status != 'refunded'",
        orderId,
      );
      const totalTips = allTenders.reduce((sum, t) => sum + Number(t.tip ?? 0), 0);
      run(
        `UPDATE orders SET status = 'closed', subtotal = ?, discount = ?, vat = ?, service_charge = ?, tip = ?, total = ?,
           closed_at = ?, approval_status = 'approved', business_date = ?
          WHERE id = ? AND status IN ('open','sent')`,
        pricing.subtotal,
        pricing.discount,
        pricing.vat,
        pricing.serviceCharge,
        totalTips,
        pricing.total + totalTips,
        stamp,
        businessDate,
        orderId,
      );
      deductForOrder(orderId, null);
      if (order.tableId) {
        run("UPDATE tables SET status = 'dirty', guests = 0, seated_at = NULL WHERE id = ?", order.tableId);
      }
    }
  });

  if (isFinal && resolved.tableId) {
    closeTableSession(resolved.tableId);
  }
  const updated = requireOrder(orderId);
  const { paidAmount: nowPaid, remainingDue: nowDue } = paidBreakdown(updated);
  const pointsEarned = isFinal ? awardPointsForOrder(orderId, pricing.total, tender.guestId) : 0;

  let emailSent: { recipientEmail: string; status: string } | null = null;
  if (isFinal && tender.email?.trim()) {
    const dispatched = dispatchEmailReceipt(updated, tender.email, isDemoMode());
    emailSent = { recipientEmail: dispatched.recipientEmail, status: dispatched.status };
  }

  emitEvent("payment.updated", { orderId, tableId: resolved.tableId });
  emitEvent("floor.updated", { tableId: resolved.tableId });

  const totalTips = updated.tenders.reduce((sum, t) => sum + t.tip, 0);
  const receiptTenders = updated.tenders.map((t) => ({
    ...t,
    authCode: t.authCode ?? undefined,
    last4: t.last4 ?? undefined,
  }));
  const receipt = isFinal
    ? buildReceipt(updated, pricing, receiptTenders, settings.receiptFooter, totalTips)
    : [
        { label: settings.restaurantName, value: "", emphasis: true },
        { label: `Partial payment · ${label}`, value: `Rs ${(payAmount / 100).toFixed(2)}` },
        { label: "Remaining balance", value: `Rs ${(nowDue / 100).toFixed(2)}`, emphasis: true },
      ];

  return {
    order: updated,
    paidInFull: isFinal,
    paidAmount: nowPaid,
    remainingDue: nowDue,
    pointsEarned,
    emailSent,
    receipt,
  };
}

export function guestJoinSession(token: string, input: { name: string; guestId?: string | null }) {
  const resolved = requireToken(token);
  if (!resolved.tableId) throw badRequest("This QR code is not assigned to a table");
  return joinTableGuest(resolved.tableId, resolved.token, input);
}

export function guestCallWaiter(
  token: string,
  input: { requestType?: string; guestId?: string | null; guestName?: string; note?: string },
) {
  const resolved = requireToken(token);
  if (!resolved.tableId) throw badRequest("This QR code is not assigned to a table");
  const session = getActiveSession(resolved.tableId);
  return createServiceRequest({
    tableId: resolved.tableId,
    sessionId: session?.id ?? null,
    guestId: input.guestId ?? null,
    guestName: input.guestName,
    requestType: input.requestType,
    note: input.note,
  });
}

// --------------------------------------------------------------------------- CFD
export async function cfdView(terminalId = "term-pos-1", baseUrl = ""): Promise<CfdView & { paymentQr: string }> {
  const settings = getSettings();
  const active = getActiveOrders().filter((order) => order.terminalId === terminalId || !order.terminalId);
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
export async function qrStickers(baseUrl = ""): Promise<{ token: string; tableLabel: string; url: string; dataUrl: string }[]> {
  const active = getQrTokens().filter((token) => token.isActive);
  return Promise.all(
    active.map(async (token) => {
      const url = tableMenuUrl(baseUrl, token.token);
      const dataUrl = await QRCode.toDataURL(url || `/t/${token.token}`, { width: 220, margin: 1 });
      return { token: token.token, tableLabel: token.tableLabel, url, dataUrl };
    }),
  );
}

export { stationName, businessDateNow, tenderLabel };
