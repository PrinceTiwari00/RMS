/**
 * Purchasing service — vendors, purchase orders and the transmission log.
 *
 * A nightly job evaluates stock against each item's reorder point, pools the
 * result by vendor and leaves it in draft for a manager to approve before the
 * vendor cutoff. Approved orders are dispatched over EDI 850/SFTP or as a PDF
 * email, and receiving posts the stock and ledger rows in one transaction.
 */
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, notFound } from "@/server/router";
import { isDemoMode } from "@/lib/session";
import { audit } from "@/server/audit";
import { getInventoryItem } from "@/server/inventory";
import { getSettings } from "@/server/settings";
import { buildEdi850, buildPoDocument } from "@/domain/edi";
import { packsToUnits } from "@/domain/inventory";
import { businessDateNow, nowStamp, shiftDate, today, formatClock, zoned } from "@/domain/time";
import type { PoTransmission, PurchaseOrder, PurchaseOrderLine, SessionUser, Vendor } from "@/types";

interface VendorRow {
  id: string;
  name: string;
  contact_name: string;
  email: string;
  phone: string;
  address: string;
  account_number: string;
  payment_terms: string;
  min_order: number;
  lead_time_days: number;
  edi_enabled: number;
  cutoff_time: string;
  preferred: number;
  is_active: number;
  item_count: number | null;
  open_po_count: number | null;
  spend_30d: number | null;
}

const VENDOR_SELECT = `
  SELECT v.*,
         (SELECT COUNT(*) FROM inventory_items ii WHERE ii.vendor_id = v.id AND ii.is_active = 1) AS item_count,
         (SELECT COUNT(*) FROM purchase_orders po WHERE po.vendor_id = v.id AND po.status IN ('draft','approved','sent')) AS open_po_count,
         (SELECT COALESCE(SUM(po.total), 0) FROM purchase_orders po
           WHERE po.vendor_id = v.id AND po.status IN ('sent','received')
             AND date(po.created_at) >= date('now', '-30 day')) AS spend_30d
    FROM vendors v`;

export function getVendors(): Vendor[] {
  return all<VendorRow>(`${VENDOR_SELECT} WHERE v.is_active = 1 ORDER BY v.preferred DESC, v.name`).map((row) => ({
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    accountNumber: row.account_number,
    paymentTerms: row.payment_terms,
    minOrder: row.min_order,
    leadTimeDays: row.lead_time_days,
    ediEnabled: Boolean(row.edi_enabled),
    cutoffTime: row.cutoff_time,
    preferred: Boolean(row.preferred),
    isActive: Boolean(row.is_active),
    itemCount: Number(row.item_count ?? 0),
    openPoCount: Number(row.open_po_count ?? 0),
    spend30d: Number(row.spend_30d ?? 0),
  }));
}

export function getVendor(id: string): Vendor | null {
  return getVendors().find((vendor) => vendor.id === id) ?? null;
}

export interface VendorInput {
  name?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  accountNumber?: string;
  paymentTerms?: string;
  minOrder?: number;
  leadTimeDays?: number;
  ediEnabled?: boolean;
  cutoffTime?: string;
  preferred?: boolean;
  isActive?: boolean;
}

export function createVendor(input: VendorInput, actor: SessionUser | null): Vendor {
  const name = String(input.name ?? "").trim();
  if (!name) throw badRequest("Vendor name is required");
  const id = uuid();
  run(
    `INSERT INTO vendors (id, name, contact_name, email, phone, address, account_number, payment_terms,
       min_order, lead_time_days, edi_enabled, cutoff_time, preferred, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    name,
    input.contactName ?? "",
    input.email ?? "",
    input.phone ?? "",
    input.address ?? "",
    input.accountNumber ?? "",
    input.paymentTerms ?? "net_15",
    Math.round(Number(input.minOrder ?? 0)),
    Math.max(0, Number(input.leadTimeDays ?? 2)),
    input.ediEnabled ? 1 : 0,
    input.cutoffTime ?? "17:00",
    input.preferred ? 1 : 0,
    input.isActive === false ? 0 : 1,
  );
  audit(actor, "purchasing.vendor.create", "vendor", id, name);
  return getVendor(id)!;
}

export function updateVendor(id: string, patch: VendorInput, actor: SessionUser | null): Vendor {
  const row = get<VendorRow>("SELECT * FROM vendors WHERE id = ?", id);
  if (!row) throw notFound("Vendor not found");
  run(
    `UPDATE vendors SET name = ?, contact_name = ?, email = ?, phone = ?, address = ?, account_number = ?,
       payment_terms = ?, min_order = ?, lead_time_days = ?, edi_enabled = ?, cutoff_time = ?, preferred = ?, is_active = ?
      WHERE id = ?`,
    patch.name ?? row.name,
    patch.contactName ?? row.contact_name,
    patch.email ?? row.email,
    patch.phone ?? row.phone,
    patch.address ?? row.address,
    patch.accountNumber ?? row.account_number,
    patch.paymentTerms ?? row.payment_terms,
    patch.minOrder !== undefined ? Math.round(Number(patch.minOrder)) : row.min_order,
    patch.leadTimeDays !== undefined ? Math.max(0, Number(patch.leadTimeDays)) : row.lead_time_days,
    patch.ediEnabled === undefined ? row.edi_enabled : patch.ediEnabled ? 1 : 0,
    patch.cutoffTime ?? row.cutoff_time,
    patch.preferred === undefined ? row.preferred : patch.preferred ? 1 : 0,
    patch.isActive === undefined ? row.is_active : patch.isActive ? 1 : 0,
    id,
  );
  audit(actor, "purchasing.vendor.update", "vendor", id, row.name);
  return getVendor(id)!;
}

// ------------------------------------------------------------- purchase orders
interface PoRow {
  id: string;
  po_number: string;
  vendor_id: string;
  vendor_name: string;
  status: string;
  expected_date: string | null;
  notes: string;
  total: number;
  created_at: string;
  approved_at: string | null;
  sent_at: string | null;
  received_at: string | null;
  edi_enabled: number | null;
  cutoff_time: string | null;
}

const PO_SELECT = `
  SELECT po.*, v.name AS vendor_name, v.edi_enabled, v.cutoff_time
    FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id`;

function mapLine(row: {
  id: string;
  inventory_item_id: string;
  item_name: string;
  unit: string;
  sku: string;
  quantity_packs: number;
  pack_size: number;
  unit_price: number;
  current_stock: number;
  par_level: number;
}): PurchaseOrderLine {
  return {
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    itemName: row.item_name,
    unit: row.unit,
    sku: row.sku,
    quantityPacks: row.quantity_packs,
    packSize: row.pack_size,
    units: packsToUnits(row.quantity_packs, row.pack_size),
    unitPrice: row.unit_price,
    lineTotal: Math.round(row.quantity_packs * row.unit_price),
    currentStock: row.current_stock,
    parLevel: row.par_level,
  };
}

function loadLines(poId: string): PurchaseOrderLine[] {
  return all<Parameters<typeof mapLine>[0]>(
    `SELECT pl.id, pl.inventory_item_id, ii.name AS item_name, ii.unit, ii.sku, pl.quantity_packs,
            ii.pack_size, pl.unit_price, ii.current_stock, ii.par_level
       FROM po_items pl JOIN inventory_items ii ON ii.id = pl.inventory_item_id
      WHERE pl.po_id = ? ORDER BY ii.name`,
    poId,
  ).map(mapLine);
}

function loadTransmissions(poId: string): PoTransmission[] {
  return all<{ id: string; channel: string; destination: string; status: string; attempts: number; reference: string; payload: string; created_at: string }>(
    "SELECT * FROM po_transmissions WHERE po_id = ? ORDER BY created_at DESC",
    poId,
  ).map((row) => ({
    id: row.id,
    channel: row.channel as PoTransmission["channel"],
    destination: row.destination,
    status: row.status as PoTransmission["status"],
    attempts: row.attempts,
    reference: row.reference,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}

/** Has the vendor's cutoff already passed for today? */
function pastCutoff(cutoff: string | null): boolean {
  if (!cutoff) return false;
  const now = zoned();
  const [hours, minutes] = cutoff.split(":").map(Number);
  return now.hour * 60 + now.minute > (hours || 0) * 60 + (minutes || 0);
}

export function getPurchaseOrders(filter: { status?: string; vendorId?: string } = {}): PurchaseOrder[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status && filter.status !== "all") {
    clauses.push("po.status = ?");
    params.push(filter.status);
  }
  if (filter.vendorId && filter.vendorId !== "all") {
    clauses.push("po.vendor_id = ?");
    params.push(filter.vendorId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return all<PoRow>(`${PO_SELECT} ${where} ORDER BY po.created_at DESC LIMIT 200`, ...params).map((row) => ({
    id: row.id,
    poNumber: row.po_number,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    status: row.status as PurchaseOrder["status"],
    expectedDate: row.expected_date,
    notes: row.notes,
    total: row.total,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    lines: loadLines(row.id),
    transmissions: loadTransmissions(row.id),
    ediEnabled: Boolean(row.edi_enabled),
    pastCutoff: pastCutoff(row.cutoff_time),
  }));
}

export function getPurchaseOrder(id: string): PurchaseOrder | null {
  return getPurchaseOrders().find((po) => po.id === id) ?? null;
}

function nextPoNumber(): string {
  const row = get<{ next: number }>(
    "SELECT COALESCE(MAX(CAST(SUBSTR(po_number, 4) AS INTEGER)), 1000) + 1 AS next FROM purchase_orders",
  );
  return `PO-${row?.next ?? 1001}`;
}

export interface PoLineInput {
  inventoryItemId: string;
  quantityPacks: number;
  unitPrice?: number;
}

export function createDraftPo(input: { vendorId: string; lines: PoLineInput[]; expectedDate?: string; notes?: string }, actor: SessionUser | null): PurchaseOrder {
  const vendor = getVendor(input.vendorId);
  if (!vendor) throw notFound("Vendor not found");
  if (!input.lines?.length) throw badRequest("Add at least one line to the purchase order");

  const id = uuid();
  const poNumber = nextPoNumber();
  const expectedDate = input.expectedDate ?? shiftDate(today(), vendor.leadTimeDays);

  const total = tx(() => {
    run(
      `INSERT INTO purchase_orders (id, po_number, vendor_id, status, expected_date, notes, total, created_at)
       VALUES (?, ?, ?, 'draft', ?, ?, 0, ?)`,
      id,
      poNumber,
      vendor.id,
      expectedDate,
      String(input.notes ?? ""),
      nowStamp(),
    );
    let sum = 0;
    for (const line of input.lines) {
      const item = getInventoryItem(line.inventoryItemId);
      if (!item) throw notFound(`Inventory item ${line.inventoryItemId} not found`);
      const packs = Math.max(0, Number(line.quantityPacks));
      if (!Number.isFinite(packs) || packs <= 0) throw badRequest(`${item.name}: order quantity must be greater than zero`);
      const unitPrice = line.unitPrice !== undefined ? Math.round(Number(line.unitPrice)) : Math.round(item.unitCost * item.packSize);
      run(
        "INSERT INTO po_items (id, po_id, inventory_item_id, quantity_packs, unit_price) VALUES (?, ?, ?, ?, ?)",
        uuid(),
        id,
        item.id,
        packs,
        unitPrice,
      );
      sum += packs * unitPrice;
    }
    run("UPDATE purchase_orders SET total = ? WHERE id = ?", Math.round(sum), id);
    return Math.round(sum);
  });

  if (vendor.minOrder && total < vendor.minOrder) {
    run("UPDATE purchase_orders SET notes = TRIM(notes || ?) WHERE id = ?", ` Below vendor minimum of Rs ${(vendor.minOrder / 100).toFixed(2)}.`, id);
  }
  audit(actor, "purchasing.po.create", "purchase_order", id, `${poNumber} for ${vendor.name} — Rs ${(total / 100).toFixed(2)}`);
  return getPurchaseOrder(id)!;
}

export function updatePoLine(lineId: string, patch: { quantityPacks?: number; unitPrice?: number }): void {
  const line = get<{ id: string; po_id: string; quantity_packs: number; unit_price: number }>("SELECT * FROM po_items WHERE id = ?", lineId);
  if (!line) throw notFound("Purchase order line not found");
  const po = get<{ status: string }>("SELECT status FROM purchase_orders WHERE id = ?", line.po_id);
  if (!po || po.status !== "draft") throw badRequest("Only a draft purchase order can be edited");
  run(
    "UPDATE po_items SET quantity_packs = ?, unit_price = ? WHERE id = ?",
    patch.quantityPacks !== undefined ? Math.max(0, Number(patch.quantityPacks)) : line.quantity_packs,
    patch.unitPrice !== undefined ? Math.round(Number(patch.unitPrice)) : line.unit_price,
    lineId,
  );
  recomputeTotal(line.po_id);
}

export function removePoLine(lineId: string): void {
  const line = get<{ id: string; po_id: string }>("SELECT * FROM po_items WHERE id = ?", lineId);
  if (!line) throw notFound("Purchase order line not found");
  const po = get<{ status: string }>("SELECT status FROM purchase_orders WHERE id = ?", line.po_id);
  if (!po || po.status !== "draft") throw badRequest("Only a draft purchase order can be edited");
  run("DELETE FROM po_items WHERE id = ?", lineId);
  recomputeTotal(line.po_id);
}

function recomputeTotal(poId: string): void {
  const total = Number(
    get<{ total: number }>("SELECT COALESCE(SUM(quantity_packs * unit_price), 0) AS total FROM po_items WHERE po_id = ?", poId)?.total ?? 0,
  );
  run("UPDATE purchase_orders SET total = ? WHERE id = ?", Math.round(total), poId);
}

function requireStatus(poId: string, expected: string): { id: string; po_number: string; vendor_id: string } {
  const po = get<{ id: string; po_number: string; vendor_id: string; status: string }>(
    "SELECT id, po_number, vendor_id, status FROM purchase_orders WHERE id = ?",
    poId,
  );
  if (!po) throw notFound("Purchase order not found");
  if (po.status !== expected) throw badRequest(`That purchase order is ${po.status}, not ${expected}`);
  return po;
}

export function approvePo(poId: string, actor: SessionUser | null): PurchaseOrder {
  const po = requireStatus(poId, "draft");
  run("UPDATE purchase_orders SET status = 'approved', approved_at = ? WHERE id = ?", nowStamp(), poId);
  audit(actor, "purchasing.po.approve", "purchase_order", poId, po.po_number);
  return getPurchaseOrder(poId)!;
}

/**
 * Dispatch to the vendor. EDI-enabled vendors get an X12 850 over SFTP;
 * everyone else gets a PDF-style document by email. Both are logged with the
 * exact payload so a failed transmission can be retried from the admin portal.
 */
export function sendPo(poId: string, channel: "edi_sftp" | "pdf_email" | "auto", actor: SessionUser | null): PurchaseOrder {
  if (!isDemoMode()) throw badRequest("Vendor delivery transport is not configured. Export the purchase order for manual delivery; automatic dispatch is unavailable.");
  const po = requireStatus(poId, "approved");
  const vendor = getVendor(po.vendor_id);
  if (!vendor) throw notFound("Vendor not found");
  const order = getPurchaseOrder(poId);
  if (!order) throw notFound("Purchase order not found");

  const useEdi = channel === "edi_sftp" || (channel === "auto" && vendor.ediEnabled);
  if (useEdi && !vendor.ediEnabled) throw badRequest(`${vendor.name} is not set up for EDI`);

  const settings = getSettings();
  const payload = useEdi
    ? buildEdi850({
        poNumber: order.poNumber,
        sender: (settings.panVat || "TERAIKITCHEN").slice(0, 15),
        receiver: vendor.accountNumber || vendor.name.slice(0, 15),
        items: order.lines.map((line) => ({ qty: line.quantityPacks, price: line.unitPrice, sku: line.sku || line.inventoryItemId })),
      })
    : buildPoDocument({
        poNumber: order.poNumber,
        vendorName: vendor.name,
        restaurantName: settings.restaurantName,
        expectedDate: order.expectedDate ?? shiftDate(today(), vendor.leadTimeDays),
        lines: order.lines.map((line) => ({
          name: line.itemName,
          unit: line.unit,
          packs: line.quantityPacks,
          units: line.units,
          unitPrice: line.unitPrice,
        })),
      });

  const destination = useEdi ? `sftp://edi.${vendor.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.np/inbox` : vendor.email || "no email on file";
  const failed = !useEdi && !vendor.email;

  tx(() => {
    run(
      `INSERT INTO po_transmissions (id, po_id, channel, destination, status, attempts, reference, payload, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      uuid(),
      poId,
      useEdi ? "edi_sftp" : "pdf_email",
      destination,
      failed ? "failed" : "sent",
      failed ? "" : useEdi ? `EDI-850-${Math.floor(Math.random() * 9000 + 1000)}` : `MAIL-${Date.now().toString(36).toUpperCase()}`,
      payload,
      nowStamp(),
    );
    if (!failed) run("UPDATE purchase_orders SET status = 'sent', sent_at = ? WHERE id = ?", nowStamp(), poId);
  });
  audit(actor, "purchasing.po.send", "purchase_order", poId, `${order.poNumber} via ${useEdi ? "EDI 850 / SFTP" : "PDF email"}${failed ? " — FAILED (no email on file)" : ""}`);
  if (failed) throw badRequest(`${vendor.name} has no email address — add one or switch the vendor to EDI`);
  return getPurchaseOrder(poId)!;
}

/** Receive the delivery: post stock and ledger rows atomically. */
export function receivePo(poId: string, actor: SessionUser | null, overrides: Record<string, number> = {}): { movements: number } {
  const po = requireStatus(poId, "sent");
  const lines = loadLines(poId);
  if (!lines.length) throw badRequest("That purchase order has no lines to receive");
  const stamp = nowStamp();
  const businessDate = businessDateNow();

  const movements = tx(() => {
    let count = 0;
    for (const line of lines) {
      const receivedPacks = overrides[line.id] !== undefined ? Number(overrides[line.id]) : line.quantityPacks;
      if (!Number.isFinite(receivedPacks) || receivedPacks < 0) throw badRequest(`${line.itemName}: received quantity cannot be negative`);
      const units = packsToUnits(receivedPacks, line.packSize);
      if (!units) continue;
      run("UPDATE inventory_items SET current_stock = current_stock + ? WHERE id = ?", units, line.inventoryItemId);
      run(
        `INSERT INTO inventory_transactions (id, inventory_item_id, delta, reason, reference_id, actor, created_at, business_date)
         VALUES (?, ?, ?, 'restock', ?, ?, ?, ?)`,
        uuid(),
        line.inventoryItemId,
        units,
        poId,
        actor?.name ?? "system",
        stamp,
        businessDate,
      );
      count += 1;
    }
    const changed = run("UPDATE purchase_orders SET status = 'received', received_at = ? WHERE id = ? AND status = 'sent'", stamp, poId).changes;
    if (!changed) throw badRequest("That purchase order has already been received");
    return count;
  });

  audit(actor, "purchasing.po.receive", "purchase_order", poId, `${movements} stock line(s) received`);
  return { movements };
}

export function cancelPo(poId: string, actor: SessionUser | null): PurchaseOrder {
  const po = get<{ id: string; status: string; po_number: string }>("SELECT id, status, po_number FROM purchase_orders WHERE id = ?", poId);
  if (!po) throw notFound("Purchase order not found");
  if (po.status === "received") throw badRequest("A received purchase order cannot be cancelled");
  run("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?", poId);
  audit(actor, "purchasing.po.cancel", "purchase_order", poId, po.po_number);
  return getPurchaseOrder(poId)!;
}

/**
 * The nightly automation: draft one PO per vendor for everything at or below
 * its reorder point, sized in whole packs up to par level.
 */
/** One candidate row per item that needs ordering. */
interface ReorderCandidate {
  id: string;
  name: string;
  vendorId: string;
  packs: number;
  unitPrice: number;
}

export function generateSuggestedPos(actor: SessionUser | null): { created: string[]; skipped: string[] } {
  const items = all<{
    id: string;
    name: string;
    vendor_id: string | null;
    current_stock: number;
    par_level: number;
    pack_size: number;
    unit_cost: number;
    avg_daily_usage: number;
    max_daily_usage: number;
    lead_time_days: number;
    max_lead_time_days: number;
    low_stock_threshold: number;
  }>("SELECT * FROM inventory_items WHERE is_active = 1");

  const byVendor = new Map<string, ReorderCandidate[]>();
  const skipped: string[] = [];

  for (const item of items) {
    const rop =
      item.avg_daily_usage * item.lead_time_days +
      Math.max(0, item.max_daily_usage * item.max_lead_time_days - item.avg_daily_usage * item.lead_time_days);
    const threshold = Math.max(rop, item.low_stock_threshold);
    if (item.current_stock > threshold) continue;
    if (!item.vendor_id) {
      skipped.push(`${item.name} — no vendor assigned`);
      continue;
    }
    const packSize = item.pack_size > 0 ? item.pack_size : 1;
    const packs = item.par_level > item.current_stock ? Math.ceil((item.par_level - item.current_stock) / packSize) : 0;
    if (packs <= 0) {
      skipped.push(`${item.name} — already at par`);
      continue;
    }
    const bucket = byVendor.get(item.vendor_id) ?? [];
    bucket.push({ id: item.id, name: item.name, vendorId: item.vendor_id, packs, unitPrice: Math.round(item.unit_cost * packSize) });
    byVendor.set(item.vendor_id, bucket);
  }

  const created: string[] = [];
  for (const [vendorId, lines] of byVendor) {
    const po = createDraftPo(
      {
        vendorId,
        expectedDate: shiftDate(today(), getVendor(vendorId)?.leadTimeDays ?? 2),
        notes: "Auto-generated from reorder points.",
        lines: lines.map((line) => ({ inventoryItemId: line.id, quantityPacks: line.packs, unitPrice: line.unitPrice })),
      },
      actor,
    );
    created.push(po.poNumber);
  }
  if (created.length) {
    audit(actor, "purchasing.autogenerate", "purchase_order", null, `drafted ${created.length} PO(s): ${created.join(", ")}`);
  }
  return { created, skipped };
}

/** The EDI/PDF document for a PO, for preview and download in the admin portal. */
export function poDocument(poId: string): { channel: "edi_sftp" | "pdf_email"; content: string } {
  const order = getPurchaseOrder(poId);
  if (!order) throw notFound("Purchase order not found");
  const vendor = getVendor(order.vendorId);
  if (!vendor) throw notFound("Vendor not found");
  const settings = getSettings();
  if (vendor.ediEnabled) {
    return {
      channel: "edi_sftp",
      content: buildEdi850({
        poNumber: order.poNumber,
        sender: (settings.panVat || "TERAIKITCHEN").slice(0, 15),
        receiver: vendor.accountNumber || vendor.name.slice(0, 15),
        items: order.lines.map((line) => ({ qty: line.quantityPacks, price: line.unitPrice, sku: line.sku || line.inventoryItemId })),
      }),
    };
  }
  return {
    channel: "pdf_email",
    content: buildPoDocument({
      poNumber: order.poNumber,
      vendorName: vendor.name,
      restaurantName: settings.restaurantName,
      expectedDate: order.expectedDate ?? shiftDate(today(), vendor.leadTimeDays),
      lines: order.lines.map((line) => ({ name: line.itemName, unit: line.unit, packs: line.quantityPacks, units: line.units, unitPrice: line.unitPrice })),
    }),
  };
}

/** Retry a failed transmission — the manual half of the job queue. */
export function retryTransmission(transmissionId: string, actor: SessionUser | null): PoTransmission {
  if (!isDemoMode()) throw badRequest("Vendor delivery transport is not configured; retry cannot confirm delivery.");
  const row = get<{ id: string; po_id: string; status: string; attempts: number; channel: string }>(
    "SELECT * FROM po_transmissions WHERE id = ?",
    transmissionId,
  );
  if (!row) throw notFound("Transmission not found");
  if (row.status === "sent") throw badRequest("That transmission already succeeded");
  const nextAttempts = row.attempts + 1;
  // Mirrors the retry policy of the job queue: five attempts, then dead-letter.
  const status = nextAttempts >= 5 ? "dead" : "sent";
  run(
    "UPDATE po_transmissions SET status = ?, attempts = ?, reference = ? WHERE id = ?",
    status,
    nextAttempts,
    status === "sent" ? `RETRY-${nextAttempts}-${Date.now().toString(36).toUpperCase()}` : "",
    transmissionId,
  );
  if (status === "sent") {
    const po = get<{ status: string }>("SELECT status FROM purchase_orders WHERE id = ?", row.po_id);
    if (po && po.status === "approved") run("UPDATE purchase_orders SET status = 'sent', sent_at = ? WHERE id = ?", nowStamp(), row.po_id);
  }
  audit(actor, "purchasing.transmission.retry", "po_transmission", transmissionId, `attempt ${nextAttempts} → ${status}`);
  return loadTransmissions(row.po_id).find((entry) => entry.id === transmissionId)!;
}

export function purchasingSummary() {
  const orders = getPurchaseOrders();
  return {
    draft: orders.filter((po) => po.status === "draft").length,
    approved: orders.filter((po) => po.status === "approved").length,
    sent: orders.filter((po) => po.status === "sent").length,
    received: orders.filter((po) => po.status === "received").length,
    openValue: orders.filter((po) => ["draft", "approved", "sent"].includes(po.status)).reduce((sum, po) => sum + po.total, 0),
    dueToday: orders.filter((po) => po.status === "sent" && po.expectedDate === today()).length,
    pastCutoff: orders.filter((po) => po.status === "approved" && po.pastCutoff).length,
    failedTransmissions: orders.flatMap((po) => po.transmissions).filter((entry) => entry.status === "failed" || entry.status === "dead").length,
    spend30d: getVendors().reduce((sum, vendor) => sum + vendor.spend30d, 0),
    nextCutoff: getVendors().filter((vendor) => vendor.preferred).map((vendor) => `${vendor.name} ${formatClock(`${today()} ${vendor.cutoffTime}`)}`).slice(0, 3),
  };
}
