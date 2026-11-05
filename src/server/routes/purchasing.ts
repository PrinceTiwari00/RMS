/**
 * Vendor and purchase-order routes.
 *
 * The lifecycle is deliberately gated by permission at each step: anyone with
 * `admin.purchasing` may draft, but approving, dispatching and receiving are
 * separate audited actions so a single person cannot quietly push an order all
 * the way through to a stock movement.
 */
import { route, created, badRequest } from "@/server/router";
import {
  approvePo,
  cancelPo,
  createDraftPo,
  createVendor,
  generateSuggestedPos,
  getPurchaseOrder,
  getPurchaseOrders,
  getVendor,
  getVendors,
  poDocument,
  purchasingSummary,
  receivePo,
  removePoLine,
  retryTransmission,
  sendPo,
  updatePoLine,
  updateVendor,
} from "@/server/purchasing";
import { arr, has, int, num, oneOf, optBool, optStr, paisa, q, required, str } from "@/server/coerce";
import { getInventoryItems } from "@/server/inventory";

const PO_STATUSES = ["all", "draft", "approved", "sent", "received", "cancelled"] as const;
const SEND_CHANNELS = ["auto", "edi_sftp", "pdf_email"] as const;

// ---------------------------------------------------------------------- vendors
route("GET", "vendors", "admin.purchasing", () => ({ vendors: getVendors(), summary: purchasingSummary() }));

route("GET", "vendors/:id", "admin.purchasing", ({ params }) => {
  const vendor = getVendor(params.id);
  if (!vendor) throw badRequest("Vendor not found");
  return {
    vendor,
    items: getInventoryItems({ vendorId: vendor.id }),
    orders: getPurchaseOrders({ vendorId: vendor.id }),
  };
});

route("POST", "vendors", "admin.purchasing", ({ body, user }) =>
  created(
    createVendor(
      {
        name: required(body, "name", "Vendor name"),
        contactName: optStr(body, "contactName"),
        email: optStr(body, "email"),
        phone: optStr(body, "phone"),
        address: optStr(body, "address"),
        accountNumber: optStr(body, "accountNumber"),
        paymentTerms: optStr(body, "paymentTerms"),
        minOrder: has(body, "minOrder") ? paisa(body, "minOrder") : undefined,
        leadTimeDays: has(body, "leadTimeDays") ? int(body, "leadTimeDays") : undefined,
        ediEnabled: optBool(body, "ediEnabled"),
        cutoffTime: optStr(body, "cutoffTime"),
        preferred: optBool(body, "preferred"),
        isActive: optBool(body, "isActive"),
      },
      user,
    ),
  ),
);

route("PATCH", "vendors/:id", "admin.purchasing", ({ params, body, user }) => ({
  vendor: updateVendor(
    params.id,
    {
      name: optStr(body, "name"),
      contactName: optStr(body, "contactName"),
      email: optStr(body, "email"),
      phone: optStr(body, "phone"),
      address: optStr(body, "address"),
      accountNumber: optStr(body, "accountNumber"),
      paymentTerms: optStr(body, "paymentTerms"),
      minOrder: has(body, "minOrder") ? paisa(body, "minOrder") : undefined,
      leadTimeDays: has(body, "leadTimeDays") ? int(body, "leadTimeDays") : undefined,
      ediEnabled: optBool(body, "ediEnabled"),
      cutoffTime: optStr(body, "cutoffTime"),
      preferred: optBool(body, "preferred"),
      isActive: optBool(body, "isActive"),
    },
    user,
  ),
}));

// ------------------------------------------------------------- purchase orders
route("GET", "purchase-orders", "admin.purchasing", ({ query }) => ({
  orders: getPurchaseOrders({
    status: oneOf(q(query, "status", "all"), PO_STATUSES, "all"),
    vendorId: q(query, "vendorId", "all"),
  }),
  vendors: getVendors(),
  summary: purchasingSummary(),
}));

/** The nightly automation, run by hand from the admin portal. */
route("POST", "purchase-orders/generate", "admin.purchasing", ({ user }) => generateSuggestedPos(user));

route("GET", "purchase-orders/:id", "admin.purchasing", ({ params }) => {
  const order = getPurchaseOrder(params.id);
  if (!order) throw badRequest("Purchase order not found");
  return { order, vendor: getVendor(order.vendorId) };
});

route("POST", "purchase-orders", "admin.purchasing", ({ body, user }) =>
  created(
    createDraftPo(
      {
        vendorId: required(body, "vendorId", "A vendor"),
        expectedDate: optStr(body, "expectedDate"),
        notes: optStr(body, "notes"),
        lines: arr(body, "lines").map((entry) => {
          const line = entry as Record<string, unknown>;
          return {
            inventoryItemId: String(line.inventoryItemId ?? ""),
            quantityPacks: Number(line.quantityPacks ?? 1),
            unitPrice: line.unitPrice === undefined ? undefined : Math.round(Number(line.unitPrice)),
          };
        }),
      },
      user,
    ),
  ),
);

route("PATCH", "purchase-orders/lines/:lineId", "admin.purchasing", ({ params, body }) => {
  updatePoLine(params.lineId, {
    quantityPacks: has(body, "quantityPacks") ? num(body, "quantityPacks") : undefined,
    unitPrice: has(body, "unitPrice") ? paisa(body, "unitPrice") : undefined,
  });
  return { ok: true };
});

route("DELETE", "purchase-orders/lines/:lineId", "admin.purchasing", ({ params }) => {
  removePoLine(params.lineId);
  return { ok: true };
});

route("POST", "purchase-orders/:id/approve", "admin.purchasing", ({ params, user }) => ({ order: approvePo(params.id, user) }));

route("POST", "purchase-orders/:id/send", "admin.purchasing", ({ params, body, user }) => ({
  order: sendPo(params.id, oneOf(str(body, "channel", "auto"), SEND_CHANNELS, "auto"), user),
}));

/** Receiving posts the stock and the immutable ledger rows together. */
route("POST", "purchase-orders/:id/receive", "admin.purchasing", ({ params, body, user }) => {
  const overrides: Record<string, number> = {};
  for (const [lineId, value] of Object.entries(body.overrides ?? {})) {
    overrides[lineId] = Number(value);
  }
  const result = receivePo(params.id, user, overrides);
  return { ...result, order: getPurchaseOrder(params.id) };
});

route("POST", "purchase-orders/:id/cancel", "admin.purchasing", ({ params, user }) => ({ order: cancelPo(params.id, user) }));

/** The exact EDI 850 or PDF-style document that will be transmitted. */
route("GET", "purchase-orders/:id/document", "admin.purchasing", ({ params }) => poDocument(params.id));

route("POST", "transmissions/:id/retry", "admin.purchasing", ({ params, user }) => ({ transmission: retryTransmission(params.id, user) }));
