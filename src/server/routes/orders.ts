/**
 * Ticket routes — creating, editing, firing and checking out orders.
 *
 * The permission split mirrors the floor: opening and editing a ticket is
 * `pos.open`, sending is `pos.send`, voiding is `pos.void` (always audited),
 * discounts are `pos.discount` and taking money is `pos.checkout`.
 */
import { route, created, badRequest } from "@/server/router";
import {
  applyDiscount,
  createOrder,
  fireEntrees,
  getActiveOrders,
  getClosedOrders,
  getOrder,
  nextCheckNumber,
  removeDiscount,
  removeLine,
  sendToKitchen,
  transferOrder,
  updateLine,
  updateOrderMeta,
  addLine,
} from "@/server/orders";
import { closeCheck, forwardStoredPayments, offlineExposure, paymentQr, previewSplit, tipPayoutByServer } from "@/server/checkout";
import { arr, bool, has, int, nullableStr, num, optStr, paisa, q, qBool, required, str } from "@/server/coerce";
import { businessDateNow, today } from "@/domain/time";
import { cashSuggestions, TENDER_METHODS, type SplitMode } from "@/domain/checkout";
import { getSettings } from "@/server/settings";
import { tipSuggestions } from "@/domain/pricing";
import { roundToRupee } from "@/domain/money";
import { authorizeSensitiveAction } from "@/server/approvals";

// --------------------------------------------------------------------- listing
route("GET", "orders", null, ({ query }) => ({
  orders: qBool(query, "closed")
    ? getClosedOrders(q(query, "date", businessDateNow()), int({ limit: query.get("limit") ?? undefined }, "limit", 100))
    : getActiveOrders(),
  nextCheckNumber: nextCheckNumber(),
}));

route("GET", "orders/:id", null, ({ params }) => {
  const order = getOrder(params.id);
  if (!order) throw badRequest("Ticket not found");
  const settings = getSettings();
  return {
    order,
    cashSuggestions: cashSuggestions(order.total),
    tipSuggestions: tipSuggestions(order.total, settings.tipPresets),
    tenders: TENDER_METHODS,
  };
});

// ---------------------------------------------------------------------- create
route("POST", "orders", "pos.open", ({ body, user }) =>
  created(
    createOrder(
      {
        tableId: nullableStr(body, "tableId"),
        guests: int(body, "guests", 2),
        channel: optStr(body, "channel"),
        serverId: nullableStr(body, "serverId") ?? user.id,
        guestName: optStr(body, "guestName"),
        note: optStr(body, "note"),
        qrToken: nullableStr(body, "qrToken"),
      },
      user,
    ),
  ),
);

/** Add one or more lines in a single request — the POS sends a whole course. */
route("POST", "orders/:id/lines", "pos.open", ({ params, body, user }) => {
  const lines = Array.isArray(body.lines)
    ? (body.lines as Record<string, unknown>[])
    : body.menuItemId
      ? [body]
      : [];
  if (!lines.length) throw badRequest("Send either { menuItemId } or { lines: [...] }");
  let order = getOrder(params.id);
  if (!order) throw badRequest("Ticket not found");
  for (const line of lines) {
    order = addLine(
      params.id,
      {
        menuItemId: String(line.menuItemId ?? ""),
        quantity: line.quantity === undefined ? 1 : Number(line.quantity),
        modifiers: Array.isArray(line.modifiers) ? (line.modifiers as string[]).map(String) : [],
        note: line.note === undefined ? "" : String(line.note),
        seat: line.seat === undefined ? 0 : Number(line.seat),
      },
      user,
    );
  }
  return order;
});

route("PATCH", "orders/:id/lines/:lineId", "pos.open", ({ params, body }) =>
  updateLine(params.id, params.lineId, {
    quantity: has(body, "quantity") ? int(body, "quantity") : undefined,
    note: optStr(body, "note"),
    seat: has(body, "seat") ? int(body, "seat") : undefined,
    modifiers: Array.isArray(body.modifiers) ? (body.modifiers as unknown[]).map(String) : undefined,
  }),
);

/** Removing a line that has already been sent is a void, and is audited. */
route("DELETE", "orders/:id/lines/:lineId", "pos.open", ({ params, body, query, user }) => {
  const approver = authorizeSensitiveAction(user, "void", optStr(body, "managerPin"));
  return removeLine(params.id, params.lineId, q(query, "reason") || str(body, "reason", "Removed by server"), user, approver);
});

route("POST", "orders/:id/send", "pos.send", ({ params, user }) => sendToKitchen(params.id, user));

route("POST", "orders/:id/fire", "pos.fire", ({ params, user }) => fireEntrees(params.id, user));

route("PATCH", "orders/:id", "pos.open", ({ params, body }) =>
  updateOrderMeta(params.id, {
    guests: has(body, "guests") ? int(body, "guests") : undefined,
    note: optStr(body, "note"),
    guestName: optStr(body, "guestName"),
    channel: optStr(body, "channel"),
  }),
);

route("POST", "orders/:id/transfer", "pos.open", ({ params, body, user }) =>
  transferOrder(params.id, required(body, "tableId", "A destination table"), user),
);

// -------------------------------------------------------------------- discount
route("POST", "orders/:id/discount", "pos.open", ({ params, body, user }) => {
  const kind = str(body, "kind", "amount");
  if (kind !== "amount" && kind !== "percent") throw badRequest("Discount kind must be 'amount' or 'percent'");
  const approver = authorizeSensitiveAction(user, "discount", optStr(body, "managerPin"));
  return applyDiscount(
    params.id,
    {
      kind,
      value: kind === "amount" ? paisa(body, "value") : num(body, "value"),
      reason: str(body, "reason", "Manager approved"),
      lineId: nullableStr(body, "lineId"),
    },
    user,
    approver,
  );
});

route("DELETE", "orders/:id/discount/:discountId", "pos.open", ({ params, body, user }) => {
  authorizeSensitiveAction(user, "discount", optStr(body, "managerPin"));
  return removeDiscount(params.id, params.discountId, user);
});

// -------------------------------------------------------------------- checkout
route("GET", "orders/:id/split", "pos.split", ({ params, query }) => {
  const mode = str({ mode: query.get("mode") ?? undefined }, "mode", "none") as SplitMode;
  if (!["none", "even", "seat", "item"].includes(mode)) throw badRequest("Unknown split mode");
  return previewSplit(params.id, mode);
});

/** Scannable EMV QR for the outstanding balance on this check. */
route("GET", "orders/:id/payment-qr", "pos.checkout", ({ params }) => paymentQr(params.id));

route("POST", "orders/:id/close", "pos.checkout", ({ params, body, user }) =>
  closeCheck(
    params.id,
    {
      tenders: arr(body, "tenders").map((entry) => {
        const tender = entry as Record<string, unknown>;
        return {
          method: String(tender.method ?? "cash"),
          amount: Math.round(Number(tender.amount ?? 0)),
          tip: Math.round(Number(tender.tip ?? 0)),
          label: tender.label === undefined ? "" : String(tender.label),
          authCode: tender.authCode === undefined ? undefined : String(tender.authCode),
          last4: tender.last4 === undefined ? undefined : String(tender.last4),
        };
      }),
      force: bool(body, "force", false),
      note: optStr(body, "note"),
    },
    user,
  ),
);

/** Store-and-forward headroom for offline card authorisations. */
route("GET", "payments/exposure", "pos.checkout", () => offlineExposure());

route("POST", "payments/forward", "pos.checkout", ({ user }) => forwardStoredPayments(user));

route("GET", "payments/tips", "reports.zreport", ({ query }) => ({
  date: q(query, "date", today()),
  payout: tipPayoutByServer(q(query, "date", today())),
}));

/** Cash denomination helper for the drawer count, rounded to whole rupees. */
route("GET", "payments/cash-suggestions", "pos.checkout", ({ query }) => ({
  suggestions: cashSuggestions(roundToRupee(num({ due: query.get("due") ?? undefined }, "due"))),
}));

