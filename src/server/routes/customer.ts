/**
 * Customer-facing routes.
 *
 * `guest/*` and `cfd` are public: a diner scanning a table sticker has no staff
 * session. Their only authority is the token, which maps to exactly one table and
 * can only touch that table's open ticket — never another table, never a closed
 * check, never a discount. URLs are relative throughout, because the app runs
 * behind a proxy where the public origin is not localhost.
 */
import { publicRoute, route, created, badRequest } from "@/server/router";
import {
  cfdView,
  createQrToken,
  getQrTokens,
  guestOrder,
  guestView,
  payGuestOrder,
  qrStickers,
  recordScan,
  rotateQrToken,
  setQrTokenActive,
  submitGuestOrder,
} from "@/server/customer";
import { getSettings } from "@/server/settings";
import { arr, bool, num, oneOf, q, qBool, required, str } from "@/server/coerce";
import { requireOrder } from "@/server/orders";
import { priceOrder, tipSuggestions } from "@/domain/pricing";
import { cashSuggestions, TENDER_METHODS } from "@/domain/checkout";
import { isDemoMode } from "@/lib/session";

const GUEST_TENDERS = ["wallet", "esewa", "khalti", "card"] as const;

// ------------------------------------------------------------- guest QR session
publicRoute("GET", "guest/:token", async ({ params, query }) => {
  recordScan(params.token);
  const view = await guestView(params.token);
  const settings = view.settings;
  return {
    ...view,
    // The cart the guest builds client-side, priced by the same engine as the POS.
    pricing: {
      vatRate: settings.vatRate,
      vatInclusive: settings.vatInclusive,
      serviceChargeRate: settings.serviceChargeRate,
    },
    tenders: TENDER_METHODS.filter((tender) => (GUEST_TENDERS as readonly string[]).includes(tender.id)),
    tipPresets: settings.tipPresets,
    demoMode: isDemoMode(),
    referrer: q(query, "ref"),
  };
});

/** Live status of the guest's ticket, polled while the kitchen works. */
publicRoute("GET", "guest/:token/status", ({ params }) => {
  const order = guestOrder(params.token);
  if (!order) return { order: null, stage: "idle" };
  const stage = order.status === "closed" ? "paid" : order.allReady ? "ready" : order.status === "sent" ? "cooking" : "cart";
  return { order, stage };
});

publicRoute("POST", "guest/:token/order", ({ params, body }) => {
  const lines = arr(body, "lines").map((entry) => {
    const line = entry as Record<string, unknown>;
    return {
      menuItemId: String(line.menuItemId ?? ""),
      quantity: line.quantity === undefined ? 1 : Number(line.quantity),
      modifiers: Array.isArray(line.modifiers) ? (line.modifiers as unknown[]).map(String) : [],
      note: line.note === undefined ? "" : String(line.note),
    };
  });
  return submitGuestOrder(params.token, lines);
});

/** Pay from the phone. Cash and comp are refused — no drawer is involved. */
publicRoute("POST", "guest/:token/pay", ({ params, body }) => {
  const method = oneOf(str(body, "method", "wallet"), GUEST_TENDERS, "wallet");
  const orderId = str(body, "orderId");
  const order = orderId ? requireOrder(orderId) : guestOrder(params.token);
  if (!order) throw badRequest("There is no open ticket for this table");
  return payGuestOrder(params.token, order.id, {
    method,
    amount: num(body, "amount") || undefined,
    tip: num(body, "tip", 0),
  });
});

/** The amount due and the tip ladder, so the phone can price before paying. */
publicRoute("GET", "guest/:token/due", ({ params }) => {
  const order = guestOrder(params.token);
  if (!order) return { due: 0, suggestions: [], tips: [] };
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
  return {
    due: pricing.total,
    subtotal: pricing.subtotal,
    vat: pricing.vat,
    serviceCharge: pricing.serviceCharge,
    suggestions: cashSuggestions(pricing.total),
    tips: tipSuggestions(pricing.total, settings.tipPresets),
  };
});

// ------------------------------------------------------- customer facing display
publicRoute("GET", "cfd", async ({ query }) => {
  const settings = getSettings();
  if (!settings.cfdEnabled) throw badRequest("The customer facing display is turned off at this venue");
  return cfdView(q(query, "terminal", "term-pos-1"));
});

// ------------------------------------------------------- admin token management
route("GET", "qr-tokens", "admin.settings", ({ query }) => ({
  tokens: getQrTokens(),
  stickers: qBool(query, "stickers") ? qrStickers() : [],
  enabled: getSettings().qrOrderingEnabled,
}));

route("POST", "qr-tokens", "admin.settings", ({ body, user }) =>
  created(createQrToken(required(body, "tableId", "A table"), user)),
);

route("POST", "qr-tokens/:token/rotate", "admin.settings", ({ params, user }) => ({ token: rotateQrToken(params.token, user) }));

route("PATCH", "qr-tokens/:token", "admin.settings", ({ params, body, user }) => ({
  token: setQrTokenActive(params.token, bool(body, "isActive", true), user),
}));
