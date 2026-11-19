/**
 * Customer-facing routes.
 *
 * `guest/*` and `cfd` are public: a diner scanning a table sticker has no staff
 * session. Their only authority is the token (or table label shorthand), which maps
 * to exactly one table and can only touch that table's open session/ticket.
 */
import { publicRoute, route, created, badRequest } from "@/server/router";
import {
  cfdView,
  createQrToken,
  estimatePrepTime,
  getQrTokens,
  guestCallWaiter,
  guestJoinSession,
  guestOrder,
  guestView,
  paidBreakdown,
  payGuestOrder,
  qrStickers,
  recordScan,
  requireToken,
  rotateQrToken,
  setQrTokenActive,
  submitGuestOrder,
} from "@/server/customer";
import {
  activeQuizForTable,
  advanceQuizRound,
  dispatchEmailReceipt,
  getActiveSession,
  getQuizMatchView,
  getReviewForOrder,
  getTableServiceRequests,
  lookupOrLinkLoyalty,
  redeemLoyaltyReward,
  startOrJoinQuiz,
  submitGuestReview,
  submitQuizAnswer,
} from "@/server/engagement";
import { getSettings } from "@/server/settings";
import { arr, bool, int, num, oneOf, optStr, q, qBool, required, str } from "@/server/coerce";
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

/** Live status of the guest's ticket, session, prep countdown, and waiter calls. */
publicRoute("GET", "guest/:token/status", ({ params }) => {
  const resolved = requireToken(params.token);
  const session = resolved.tableId ? getActiveSession(resolved.tableId) : null;
  const order = guestOrder(params.token, true);
  const activeRequests = resolved.tableId ? getTableServiceRequests(resolved.tableId) : [];

  if (!order) {
    return {
      order: null,
      stage: "idle",
      session,
      activeRequests,
      estimatedRemainingSeconds: 0,
      estimatedTotalSeconds: 0,
      paidAmount: 0,
      remainingDue: 0,
      review: null,
    };
  }

  const stage =
    order.status === "closed"
      ? "paid"
      : order.approvalStatus === "pending_staff"
        ? "pending_staff"
        : order.allReady
          ? "ready"
          : order.status === "sent"
            ? "cooking"
            : "cart";

  const prep = estimatePrepTime(order);
  const { paidAmount, remainingDue } = paidBreakdown(order);
  const review = getReviewForOrder(order.id);

  return {
    order,
    stage,
    session,
    activeRequests,
    estimatedRemainingSeconds: prep.remainingSeconds,
    estimatedTotalSeconds: prep.totalSeconds,
    paidAmount,
    remainingDue,
    review,
  };
});

/** Multi-guest join: Aman, Riya, etc. join the same live table session. */
publicRoute("POST", "guest/:token/join", ({ params, body }) =>
  guestJoinSession(params.token, {
    name: str(body, "name", ""),
    guestId: optStr(body, "guestId") ?? null,
  }),
);

publicRoute("POST", "guest/:token/order", ({ params, body }) => {
  const lines = arr(body, "lines").map((entry) => {
    const line = entry as Record<string, unknown>;
    return {
      menuItemId: String(line.menuItemId ?? ""),
      quantity: line.quantity === undefined ? 1 : Number(line.quantity),
      modifiers: Array.isArray(line.modifiers) ? (line.modifiers as unknown[]).map(String) : [],
      note: line.note === undefined ? "" : String(line.note),
      upsellItemId: line.upsellItemId ? String(line.upsellItemId) : null,
    };
  });
  return submitGuestOrder(params.token, lines, {
    guestId: optStr(body, "guestId") ?? null,
    guestName: optStr(body, "guestName") ?? "",
  });
});

/** Call waiter or quick request (Water, Napkins, Bill, Cutlery). */
publicRoute("POST", "guest/:token/help", ({ params, body }) =>
  created(
    guestCallWaiter(params.token, {
      requestType: str(body, "requestType", "call_waiter"),
      guestId: optStr(body, "guestId") ?? null,
      guestName: optStr(body, "guestName") ?? "",
      note: optStr(body, "note") ?? "",
    }),
  ),
);

/** Pay from the phone (full or split share). Cash and comp are refused. */
publicRoute("POST", "guest/:token/pay", ({ params, body }) => {
  const method = oneOf(str(body, "method", "wallet"), GUEST_TENDERS, "wallet");
  const orderId = str(body, "orderId");
  const order = orderId ? requireOrder(orderId) : guestOrder(params.token);
  if (!order) throw badRequest("There is no open ticket for this table");
  return payGuestOrder(params.token, order.id, {
    method,
    amount: num(body, "amount") || undefined,
    tip: num(body, "tip", 0),
    label: optStr(body, "label"),
    guestId: optStr(body, "guestId") ?? null,
    guestName: optStr(body, "guestName"),
    email: optStr(body, "email"),
  });
});

/** The amount due (accounting for any split payments already made) and tip ladder. */
publicRoute("GET", "guest/:token/due", ({ params }) => {
  const order = guestOrder(params.token);
  if (!order) return { due: 0, total: 0, paidAmount: 0, suggestions: [], tips: [] };
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
  const { paidAmount, remainingDue } = paidBreakdown(order);
  const presets = settings.tipPresets.length ? settings.tipPresets : [5, 10, 15];
  return {
    due: remainingDue,
    total: pricing.total,
    paidAmount,
    subtotal: pricing.subtotal,
    vat: pricing.vat,
    serviceCharge: pricing.serviceCharge,
    suggestions: cashSuggestions(remainingDue),
    tips: tipSuggestions(remainingDue, presets),
  };
});

/** Send PAID digital receipt via email. */
publicRoute("POST", "guest/:token/receipt-email", ({ params, body }) => {
  const resolved = requireToken(params.token);
  const orderId = str(body, "orderId");
  const order = orderId ? requireOrder(orderId) : guestOrder(params.token, true);
  if (!order) throw badRequest("Receipt order not found");
  if (order.qrToken !== resolved.token && order.tableId !== resolved.tableId) {
    throw badRequest("That ticket does not belong to this table");
  }
  const email = required(body, "email", "Email address");
  return dispatchEmailReceipt(order, email, isDemoMode());
});

/** 1-tap 5-star review tied to the order ID. */
publicRoute("POST", "guest/:token/review", ({ params, body }) => {
  const resolved = requireToken(params.token);
  const orderId = str(body, "orderId");
  const order = orderId ? requireOrder(orderId) : guestOrder(params.token, true);
  if (!order) throw badRequest("Order not found");
  return submitGuestReview({
    orderId: order.id,
    sessionId: order.sessionId,
    tableId: resolved.tableId,
    guestName: optStr(body, "guestName") ?? order.guestName,
    rating: int(body, "rating", 5),
    tags: Array.isArray(body.tags) ? (body.tags as unknown[]).map(String) : [],
    comment: optStr(body, "comment") ?? "",
  });
});

// ------------------------------------------------------------------ Loyalty
publicRoute("POST", "guest/:token/loyalty", ({ params, body }) => {
  requireToken(params.token);
  return lookupOrLinkLoyalty({
    phone: optStr(body, "phone"),
    email: optStr(body, "email"),
    name: optStr(body, "name"),
    guestId: optStr(body, "guestId") ?? null,
  });
});

publicRoute("POST", "guest/:token/loyalty/redeem", ({ params, body }) => {
  requireToken(params.token);
  return redeemLoyaltyReward(required(body, "accountId", "Loyalty account"));
});

// ------------------------------------------------------------------ Spice Quiz
publicRoute("GET", "guest/:token/quiz", ({ params, query }) => {
  const resolved = requireToken(params.token);
  if (!resolved.tableId) return { match: null };
  const matchId = q(query, "matchId");
  const participantId = q(query, "participantId");
  if (matchId) {
    return { match: getQuizMatchView(matchId, participantId || null) };
  }
  const session = getActiveSession(resolved.tableId);
  return { match: activeQuizForTable(resolved.tableId, session?.id ?? null) };
});

publicRoute("POST", "guest/:token/quiz/join", ({ params, body }) => {
  const resolved = requireToken(params.token);
  if (!resolved.tableId) throw badRequest("This QR code is not assigned to a table");
  const session = getActiveSession(resolved.tableId);
  const mode = oneOf(str(body, "mode", "in_table"), ["in_table", "table_vs_table"] as const, "in_table");
  return startOrJoinQuiz({
    mode,
    tableId: resolved.tableId,
    sessionId: session?.id ?? null,
    guestId: optStr(body, "guestId") ?? null,
    displayName: str(body, "displayName", "Guest"),
    avatarColor: optStr(body, "avatarColor"),
    opponentTableId: optStr(body, "opponentTableId") ?? null,
    forceNew: bool(body, "forceNew", false),
  });
});

publicRoute("POST", "guest/:token/quiz/answer", ({ params, body }) => {
  requireToken(params.token);
  return submitQuizAnswer({
    matchId: required(body, "matchId", "Match"),
    participantId: required(body, "participantId", "Participant"),
    roundNumber: int(body, "roundNumber", 1),
    selectedIndex: int(body, "selectedIndex", 0),
  });
});

publicRoute("POST", "guest/:token/quiz/next", ({ params, body }) => {
  requireToken(params.token);
  return {
    match: advanceQuizRound(required(body, "matchId", "Match"), optStr(body, "participantId") ?? null),
  };
});

// ------------------------------------------------------- customer facing display
publicRoute("GET", "cfd", async ({ query }) => {
  const settings = getSettings();
  if (!settings.cfdEnabled) throw badRequest("The customer facing display is turned off at this venue");
  return cfdView(q(query, "terminal", "term-pos-1"));
});

// ------------------------------------------------------- admin token management
route("GET", "qr-tokens", "admin.settings", async ({ query }) => ({
  tokens: getQrTokens(),
  stickers: qBool(query, "stickers") ? await qrStickers(q(query, "baseUrl")) : [],
  enabled: getSettings().qrOrderingEnabled,
}));

route("POST", "qr-tokens", "admin.settings", ({ body, user }) =>
  created(createQrToken(required(body, "tableId", "A table"), user)),
);

route("POST", "qr-tokens/:token/rotate", "admin.settings", ({ params, user }) => ({ token: rotateQrToken(params.token, user) }));

route("PATCH", "qr-tokens/:token", "admin.settings", ({ params, body, user }) => ({
  token: setQrTokenActive(params.token, bool(body, "isActive", true), user),
}));
