"use client";

/**
 * Screen 14 — Vendor & Purchase Order Manager.
 *
 * The lifecycle is split into separately audited steps on purpose: drafting,
 * approving, dispatching and receiving are different actions, so no one person
 * can quietly push an order all the way from a suggestion to a stock movement.
 * This screen makes that visible by only offering the action a PO's current
 * status actually allows, and by naming whoever performed each step.
 *
 * Receiving is the moment stock and the immutable ledger are written together —
 * with per-line overrides so a short delivery is recorded as what actually
 * arrived rather than what was ordered.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, qs } from "@/lib/api";
import { usePoll } from "@/lib/store";
import { Button, Card, Chip, Empty, Field, Icon, Modal, TextInput, Toggle, toast } from "@/components/ui";
import { formatMoney, formatMoneyShort, formatQuantity } from "@/domain/money";
import { formatClock, formatDay, today } from "@/domain/time";
import type { InventoryItem, PoTransmission, PurchaseOrder, Vendor } from "@/types";

interface PurchaseSummary {
  draft: number;
  approved: number;
  sent: number;
  received: number;
  openValue: number;
  dueToday: number;
  pastCutoff: number;
  failedTransmissions: number;
  spend30d: number;
  nextCutoff: string[];
}

interface VendorResponse {
  vendors: Vendor[];
  summary: PurchaseSummary;
}

interface PoResponse {
  orders: PurchaseOrder[];
  vendors: Vendor[];
  summary: PurchaseSummary;
}

const PO_STATUSES = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "approved", label: "Approved" },
  { id: "sent", label: "Sent" },
  { id: "received", label: "Received" },
  { id: "cancelled", label: "Cancelled" },
];

const STATUS_TONE: Record<PurchaseOrder["status"], "neutral" | "info" | "warn" | "ok" | "late"> = {
  draft: "neutral",
  approved: "info",
  sent: "warn",
  received: "ok",
  cancelled: "late",
};

const TRANSMISSION_TONE: Record<PoTransmission["status"], "neutral" | "info" | "ok" | "warn" | "late"> = {
  queued: "neutral",
  sent: "ok",
  failed: "warn",
  dead: "late",
};

export default function VendorsPage() {
  const [tab, setTab] = useState<"orders" | "vendors">("orders");
  const [status, setStatus] = useState("all");
  const [vendorFilter, setVendorFilter] = useState("all");
  const [openPo, setOpenPo] = useState<string | null>(null);
  const [editingVendor, setEditingVendor] = useState<Vendor | "new" | null>(null);
  const [creatingPo, setCreatingPo] = useState(false);

  const { data, reload } = usePoll<PoResponse>(`purchase-orders?${qs({ status, vendorId: vendorFilter })}`, { interval: 20000 });
  const vendors = data?.vendors ?? [];
  const orders = data?.orders ?? [];
  const summary = data?.summary;

  const generate = useCallback(async () => {
    try {
      const result = await api.post<{ created: string[]; skipped: string[] }>("purchase-orders/generate", {});
      if (result.created.length === 0) toast(`Nothing to order — ${result.skipped.length} vendor(s) already covered`, "neutral");
      else toast(`Drafted ${result.created.length} purchase order(s) from the reorder suggestions`, "ok");
      await reload();
    } catch (error) {
      toast(errorMessage(error), "late");
    }
  }, [reload]);

  if (!data) {
    return (
      <div className="p-6">
        <Empty title="Loading purchasing…" icon="vendor" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-[19px] font-extrabold text-ink">Vendors &amp; Purchasing</h1>
          <p className="text-[12px] text-ink-faint">
            Draft, approve, dispatch and receive are separate audited steps — one person cannot push an order through alone.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="soft" onClick={() => void generate()}>
            <Icon name="refresh" className="size-4" />
            Generate from reorder points
          </Button>
          <Button variant="soft" onClick={() => setEditingVendor("new")}>
            <Icon name="plus" className="size-4" />
            New vendor
          </Button>
          <Button variant="primary" onClick={() => setCreatingPo(true)}>
            <Icon name="plus" className="size-4" />
            New purchase order
          </Button>
        </div>
      </div>

      {/* ---------------------------------------------------------------- summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Open commitment</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{formatMoneyShort(summary?.openValue ?? 0)}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            {summary?.draft ?? 0} draft · {summary?.approved ?? 0} approved · {summary?.sent ?? 0} sent
          </p>
        </Card>
        <Card accent={summary?.dueToday ? "var(--color-warn)" : undefined}>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Due today</p>
          <p className="tnum mt-1 text-2xl font-black" style={{ color: summary?.dueToday ? "var(--color-warn)" : "var(--color-ink)" }}>
            {summary?.dueToday ?? 0}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Expecting delivery — receive them</p>
        </Card>
        <Card accent={summary?.pastCutoff ? "var(--color-late)" : undefined}>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Past cutoff</p>
          <p className="tnum mt-1 text-2xl font-black" style={{ color: summary?.pastCutoff ? "var(--color-late)" : "var(--color-ink)" }}>
            {summary?.pastCutoff ?? 0}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Approved but missed today's dispatch window</p>
        </Card>
        <Card accent={summary?.failedTransmissions ? "var(--color-late)" : undefined}>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Failed transmissions</p>
          <p className="tnum mt-1 text-2xl font-black" style={{ color: summary?.failedTransmissions ? "var(--color-late)" : "var(--color-ink)" }}>
            {summary?.failedTransmissions ?? 0}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-faint">EDI or email did not land — retry from the PO</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Spend, last 30 days</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{formatMoneyShort(summary?.spend30d ?? 0)}</p>
          <p className="mt-0.5 truncate text-[11px] text-ink-faint">
            {summary?.nextCutoff?.length ? `Next cutoff: ${summary.nextCutoff[0]}` : `${vendors.length} vendors`}
          </p>
        </Card>
      </div>

      {/* ------------------------------------------------------------------- tabs */}
      <div className="flex gap-1.5 border-b border-rule">
        <Tab active={tab === "orders"} onClick={() => setTab("orders")} count={orders.length}>
          Purchase orders
        </Tab>
        <Tab active={tab === "vendors"} onClick={() => setTab("vendors")} count={vendors.length}>
          Vendors
        </Tab>
      </div>

      {tab === "orders" ? (
        <Card pad={false}>
          <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2.5">
            <div className="flex flex-wrap gap-1">
              {PO_STATUSES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setStatus(entry.id)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
                    status === entry.id ? "bg-ink text-white" : "bg-paper-sunken text-ink-soft hover:bg-rule"
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <select
              className="field !w-auto !py-1.5 text-[12px]"
              value={vendorFilter}
              onChange={(event) => setVendorFilter(event.target.value)}
              aria-label="Filter by vendor"
            >
              <option value="all">All vendors</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.name}
                </option>
              ))}
            </select>
          </div>

          {orders.length === 0 ? (
            <Empty
              title="No purchase orders in this view"
              hint="Draft one by hand, or generate from the reorder points the inventory screen derives."
              icon="vendor"
            />
          ) : (
            <div className="scroll-x">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>PO</th>
                    <th>Vendor</th>
                    <th>Status</th>
                    <th className="text-right">Lines</th>
                    <th className="text-right">Total</th>
                    <th>Expected</th>
                    <th>Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id} className="cursor-pointer" onClick={() => setOpenPo(order.id)}>
                      <td className="tnum font-bold text-ink">{order.poNumber}</td>
                      <td>
                        <span className="block font-semibold text-ink">{order.vendorName}</span>
                        <span className="block text-[11px] text-ink-faint">
                          {order.ediEnabled ? "EDI 850" : "PDF by email"}
                          {order.pastCutoff && order.status === "approved" && <span className="ml-1 font-bold text-late">· past cutoff</span>}
                        </span>
                      </td>
                      <td>
                        <Chip tone={STATUS_TONE[order.status]}>{order.status}</Chip>
                      </td>
                      <td className="tnum text-right">{order.lines.length}</td>
                      <td className="tnum text-right font-bold">{formatMoney(order.total)}</td>
                      <td className="tnum text-[12px] text-ink-soft">
                        {order.expectedDate ? formatDay(order.expectedDate) : "—"}
                        {order.expectedDate === today() && order.status === "sent" && (
                          <span className="ml-1 font-bold text-warn">today</span>
                        )}
                      </td>
                      <td>
                        <span className="flex flex-wrap items-center gap-1 text-[10px] font-bold text-ink-faint">
                          <Step done label="Draft" />
                          <Step done={Boolean(order.approvedAt)} label="Approved" />
                          <Step done={Boolean(order.sentAt)} label="Sent" />
                          <Step done={Boolean(order.receivedAt)} label="Received" />
                          {order.transmissions.some((entry) => entry.status === "failed" || entry.status === "dead") && (
                            <Icon name="alert" className="size-3.5 text-late" />
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {vendors.length === 0 && (
            <Card>
              <Empty title="No vendors yet" hint="Add the suppliers you buy from to start raising orders." icon="vendor" />
            </Card>
          )}
          {vendors.map((vendor) => (
            <Card
              key={vendor.id}
              title={
                <span className="flex items-center gap-2">
                  {vendor.name}
                  {vendor.preferred && <Chip tone="brand">Preferred</Chip>}
                  {vendor.ediEnabled && <Chip tone="info">EDI</Chip>}
                  {!vendor.isActive && <Chip tone="neutral">Inactive</Chip>}
                </span>
              }
              subtitle={vendor.paymentTerms || "No payment terms recorded"}
              action={
                <Button variant="soft" size="sm" onClick={() => setEditingVendor(vendor)}>
                  <Icon name="edit" className="size-3.5" />
                  Edit
                </Button>
              }
            >
              <div className="grid grid-cols-3 gap-2">
                <Mini label="Spend 30d" value={formatMoneyShort(vendor.spend30d)} />
                <Mini label="Items supplied" value={String(vendor.itemCount)} />
                <Mini label="Open POs" value={String(vendor.openPoCount)} tone={vendor.openPoCount ? "var(--color-warn)" : undefined} />
              </div>
              <dl className="mt-2 space-y-0.5 text-[12px]">
                {vendor.contactName && <Row label="Contact" value={vendor.contactName} />}
                {vendor.phone && (
                  <Row
                    label="Phone"
                    value={
                      <a href={`tel:${vendor.phone}`} className="tnum text-brand-600 hover:underline">
                        {vendor.phone}
                      </a>
                    }
                  />
                )}
                {vendor.email && <Row label="Email" value={vendor.email} />}
                {vendor.address && <Row label="Address" value={vendor.address} />}
                <Row label="Lead time" value={`${vendor.leadTimeDays} days`} />
                {vendor.cutoffTime && <Row label="Daily cutoff" value={vendor.cutoffTime} />}
                {vendor.minOrder > 0 && <Row label="Minimum order" value={formatMoney(vendor.minOrder)} />}
              </dl>
              <div className="mt-2 flex flex-wrap gap-1.5 border-t border-rule pt-2">
                <Button variant="ghost" size="sm" onClick={() => { setVendorFilter(vendor.id); setTab("orders"); }}>
                  <Icon name="vendor" className="size-3.5" />
                  View their orders
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setCreatingPo(true); }}>
                  <Icon name="plus" className="size-3.5" />
                  Raise a PO
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <PoDetailModal poId={openPo} onClose={() => setOpenPo(null)} onChanged={() => void reload()} />
      {editingVendor && (
        <VendorEditor
          vendor={editingVendor === "new" ? null : editingVendor}
          onClose={() => setEditingVendor(null)}
          onSaved={() => { setEditingVendor(null); void reload(); }}
        />
      )}
      {creatingPo && <PoCreator vendors={vendors} onClose={() => setCreatingPo(false)} onCreated={(id) => { setCreatingPo(false); void reload(); setOpenPo(id); }} />}
    </div>
  );
}

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <span className="flex items-center gap-0.5" title={label}>
      <span className="size-2 rounded-full" style={{ background: done ? "var(--color-ok)" : "var(--color-rule)" }} />
    </span>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-rule bg-paper px-2.5 py-1.5">
      <p className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="tnum truncate text-[13px] font-black" style={{ color: tone ?? "var(--color-ink)" }}>
        {value}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="shrink-0 text-ink-faint">{label}</dt>
      <dd className="truncate text-right font-semibold text-ink-soft">{value}</dd>
    </div>
  );
}

function Tab({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-bold transition-colors ${
        active ? "border-brand-500 text-brand-700" : "border-transparent text-ink-faint hover:text-ink-soft"
      }`}
    >
      {children}
      <span className="tnum rounded-full bg-paper-sunken px-1.5 text-[11px]">{count}</span>
    </button>
  );
}

/** The full lifecycle for one PO, including the transmission audit trail. */
function PoDetailModal({ poId, onClose, onChanged }: { poId: string | null; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<{ order: PurchaseOrder; vendor: Vendor | null } | null>(null);
  const [document, setDocument] = useState<{ channel: string; content: string } | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!poId) {
      setDetail(null);
      setDocument(null);
      setReceiving(false);
      setOverrides({});
      return;
    }
    let live = true;
    void api
      .get<{ order: PurchaseOrder; vendor: Vendor | null }>(`purchase-orders/${poId}`)
      .then((response) => {
        if (!live) return;
        setDetail(response);
        const seeded: Record<string, string> = {};
        for (const line of response.order.lines) seeded[line.id] = String(line.units);
        setOverrides(seeded);
      })
      .catch((error) => {
        if (live) toast(errorMessage(error), "late");
      });
    return () => {
      live = false;
    };
  }, [poId]);

  const refresh = useCallback(async () => {
    if (!poId) return;
    const fresh = await api.get<{ order: PurchaseOrder; vendor: Vendor | null }>(`purchase-orders/${poId}`);
    setDetail(fresh);
    onChanged();
  }, [poId, onChanged]);

  const act = useCallback(
    async (path: string, body: Record<string, unknown>, message: string) => {
      setBusy(true);
      try {
        await api.post(path, body);
        toast(message, "ok");
        setReceiving(false);
        await refresh();
      } catch (error) {
        toast(errorMessage(error), "late");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  if (!poId || !detail) return null;
  const order = detail.order;
  const vendor = detail.vendor;

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="tnum">{order.poNumber}</span>
          <Chip tone={STATUS_TONE[order.status]}>{order.status}</Chip>
        </span>
      }
      subtitle={`${order.vendorName}${vendor?.paymentTerms ? ` · ${vendor.paymentTerms}` : ""}${order.expectedDate ? ` · expected ${formatDay(order.expectedDate)}` : ""}`}
      width="max-w-4xl"
      footer={
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            onClick={async () => {
              try {
                setDocument(await api.get<{ channel: string; content: string }>(`purchase-orders/${order.id}/document`));
              } catch (error) {
                toast(errorMessage(error), "late");
              }
            }}
          >
            <Icon name="report" className="size-4" />
            View {order.ediEnabled ? "EDI 850" : "document"}
          </Button>

          {order.status === "draft" && (
            <>
              <Button variant="primary" disabled={busy} onClick={() => void act(`purchase-orders/${order.id}/approve`, {}, `${order.poNumber} approved`)}>
                <Icon name="check" className="size-4" />
                Approve
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void act(`purchase-orders/${order.id}/cancel`, {}, `${order.poNumber} cancelled`)}>
                Cancel
              </Button>
            </>
          )}

          {order.status === "approved" && (
            <>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void act(`purchase-orders/${order.id}/send`, { channel: "auto" }, `${order.poNumber} dispatched to ${order.vendorName}`)}
              >
                <Icon name="arrow-right" className="size-4" />
                Send to vendor
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void act(`purchase-orders/${order.id}/cancel`, {}, `${order.poNumber} cancelled`)}>
                Cancel
              </Button>
            </>
          )}

          {order.status === "sent" && (
            <Button variant="primary" disabled={busy} onClick={() => setReceiving((current) => !current)}>
              <Icon name="inventory" className="size-4" />
              {receiving ? "Cancel receiving" : "Receive into stock"}
            </Button>
          )}
        </div>
      }
    >
      {order.pastCutoff && order.status === "approved" && (
        <p className="mb-3 flex items-start gap-2 rounded-lg bg-late-soft px-3 py-2 text-[12px] font-semibold text-late">
          <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
          This order missed {vendor?.cutoffTime ? `today's ${vendor.cutoffTime} cutoff` : "the dispatch cutoff"}. It will
          arrive a day later than planned — send it now or wait for tomorrow's window.
        </p>
      )}

      {vendor && order.total < vendor.minOrder && vendor.minOrder > 0 && order.status === "draft" && (
        <p className="mb-3 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[12px] font-semibold text-warn">
          <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
          Below this vendor's minimum order of {formatMoney(vendor.minOrder)} — currently {formatMoney(order.total)}.
        </p>
      )}

      {receiving ? (
        <div className="mb-3 rounded-xl border border-brand-300 bg-brand-50 px-3 py-2.5">
          <p className="label">Confirm what actually arrived</p>
          <p className="mb-2 text-[11px] text-ink-faint">
            Quantities are pre-filled with what was ordered. Correct any short or damaged delivery — receiving writes the
            stock movement and an immutable ledger row together, and cannot be undone.
          </p>
          <div className="scroll-y max-h-56 overflow-auto">
            {order.lines.map((line) => (
              <div key={line.id} className="mb-1.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">{line.itemName}</span>
                <span className="tnum shrink-0 text-[11px] text-ink-faint">
                  ordered {formatQuantity(line.units, 2)} {line.unit}
                </span>
                <TextInput
                  value={overrides[line.id] ?? ""}
                  onChange={(value) => setOverrides((current) => ({ ...current, [line.id]: value }))}
                  type="number"
                  step="0.01"
                  min="0"
                  className="tnum !w-24 !px-2 !py-1 text-right"
                />
                <span className="w-10 shrink-0 text-[11px] text-ink-faint">{line.unit}</span>
              </div>
            ))}
          </div>
          <Button
            variant="primary"
            size="sm"
            className="mt-2"
            disabled={busy}
            onClick={() =>
              void act(
                `purchase-orders/${order.id}/receive`,
                { overrides: Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, Number(value) || 0])) },
                `${order.poNumber} received into stock`,
              )
            }
          >
            <Icon name="check" className="size-4" />
            Post to stock &amp; ledger
          </Button>
        </div>
      ) : null}

      <div className="scroll-y flex max-h-[58vh] flex-col gap-3">
        <div className="scroll-x">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="text-right">Packs</th>
                <th className="text-right">Units</th>
                <th className="text-right">Unit price</th>
                <th className="text-right">Line total</th>
                <th className="text-right">On hand → par</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <span className="block font-semibold text-ink">{line.itemName}</span>
                    <span className="block text-[11px] text-ink-faint">
                      {line.sku || "no SKU"} · pack of {formatQuantity(line.packSize, 0)} {line.unit}
                    </span>
                  </td>
                  <td className="tnum text-right">{formatQuantity(line.quantityPacks, 0)}</td>
                  <td className="tnum text-right font-bold">
                    {formatQuantity(line.units, 2)} <span className="text-[11px] font-normal text-ink-faint">{line.unit}</span>
                  </td>
                  <td className="tnum text-right">{formatMoney(line.unitPrice)}</td>
                  <td className="tnum text-right font-bold">{formatMoney(line.lineTotal)}</td>
                  <td className="tnum text-right text-[12px] text-ink-faint">
                    {formatQuantity(line.currentStock, 1)} → {formatQuantity(line.parLevel, 1)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="text-right font-extrabold text-ink">
                  Order total
                </td>
                <td className="tnum text-right font-black">{formatMoney(order.total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        {order.notes && (
          <p className="rounded-lg bg-paper-sunken px-3 py-2 text-[12px] italic text-ink-soft">“{order.notes}”</p>
        )}

        <div>
          <p className="label">Lifecycle</p>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Mini label="Created" value={formatDay(order.createdAt)} />
            <Mini label="Approved" value={order.approvedAt ? formatDay(order.approvedAt) : "—"} />
            <Mini label="Sent" value={order.sentAt ? formatDay(order.sentAt) : "—"} />
            <Mini label="Received" value={order.receivedAt ? formatDay(order.receivedAt) : "—"} />
          </dl>
        </div>

        {order.transmissions.length > 0 && (
          <div>
            <p className="label">Transmissions</p>
            <ul className="flex flex-col gap-1.5">
              {order.transmissions.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-paper px-2.5 py-1.5">
                  <Chip tone={TRANSMISSION_TONE[entry.status]}>{entry.status}</Chip>
                  <span className="text-[11px] font-bold uppercase text-ink-faint">
                    {entry.channel === "edi_sftp" ? "EDI 850 · SFTP" : "PDF · email"}
                  </span>
                  <span className="truncate text-[12px] text-ink-soft">{entry.destination}</span>
                  <span className="tnum text-[11px] text-ink-faint">
                    {entry.attempts} attempt{entry.attempts === 1 ? "" : "s"} · {formatClock(entry.createdAt)}
                  </span>
                  {entry.reference && <span className="tnum truncate text-[11px] text-ink-faint">{entry.reference}</span>}
                  {(entry.status === "failed" || entry.status === "dead") && (
                    <Button
                      variant="soft"
                      size="sm"
                      className="ml-auto"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api.post(`transmissions/${entry.id}/retry`, {});
                          toast(`Retrying transmission to ${entry.destination}`, "info");
                          await refresh();
                        } catch (error) {
                          toast(errorMessage(error), "late");
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <Icon name="refresh" className="size-3.5" />
                      Retry
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {document && (
          <div>
            <p className="label">
              Document · {document.channel === "edi_sftp" ? "EDI 850 (X12)" : "Purchase order document"}
            </p>
            <pre className="scroll-y max-h-52 overflow-auto rounded-lg bg-ink p-3 font-mono text-[11px] leading-relaxed text-paper">
              {document.content}
            </pre>
          </div>
        )}
      </div>
    </Modal>
  );
}

function VendorEditor({ vendor, onClose, onSaved }: { vendor: Vendor | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: vendor?.name ?? "",
    contactName: vendor?.contactName ?? "",
    email: vendor?.email ?? "",
    phone: vendor?.phone ?? "",
    address: vendor?.address ?? "",
    accountNumber: vendor?.accountNumber ?? "",
    paymentTerms: vendor?.paymentTerms ?? "Net 30",
    minOrder: vendor ? (vendor.minOrder / 100).toFixed(2) : "0",
    leadTimeDays: String(vendor?.leadTimeDays ?? 2),
    cutoffTime: vendor?.cutoffTime ?? "16:00",
    ediEnabled: vendor?.ediEnabled ?? false,
    preferred: vendor?.preferred ?? false,
    isActive: vendor?.isActive ?? true,
  });
  const [busy, setBusy] = useState(false);
  const patch = (key: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));

  return (
    <Modal
      open
      onClose={onClose}
      title={vendor ? `Edit ${vendor.name}` : "New vendor"}
      subtitle="EDI-capable vendors receive an X12 850 over SFTP; everyone else gets a document by email."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !form.name.trim()}
            onClick={async () => {
              setBusy(true);
              const payload = { ...form, name: form.name.trim(), minOrder: Math.round(Number(form.minOrder) * 100), leadTimeDays: Number(form.leadTimeDays) || 0 };
              try {
                if (vendor) await api.patch(`vendors/${vendor.id}`, payload);
                else await api.post("vendors", payload);
                toast(vendor ? `${payload.name} updated` : `${payload.name} added`, "ok");
                onSaved();
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            {vendor ? "Save vendor" : "Create vendor"}
          </Button>
        </>
      }
    >
      <div className="scroll-y flex max-h-[62vh] flex-col gap-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Vendor name">
            <TextInput value={form.name} onChange={(value) => patch("name", value)} placeholder="e.g. Birgunj Fresh Produce" autoFocus />
          </Field>
          <Field label="Contact person">
            <TextInput value={form.contactName} onChange={(value) => patch("contactName", value)} />
          </Field>
          <Field label="Phone">
            <TextInput value={form.phone} onChange={(value) => patch("phone", value)} inputMode="tel" />
          </Field>
          <Field label="Email">
            <TextInput value={form.email} onChange={(value) => patch("email", value)} type="email" />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <TextInput value={form.address} onChange={(value) => patch("address", value)} />
          </Field>
          <Field label="Account number" hint="Used as the EDI receiver qualifier.">
            <TextInput value={form.accountNumber} onChange={(value) => patch("accountNumber", value)} />
          </Field>
          <Field label="Payment terms">
            <TextInput value={form.paymentTerms} onChange={(value) => patch("paymentTerms", value)} placeholder="Net 30, COD…" />
          </Field>
          <Field label="Minimum order (Rs)">
            <TextInput value={form.minOrder} onChange={(value) => patch("minOrder", value)} type="number" step="0.01" className="tnum" />
          </Field>
          <Field label="Lead time (days)">
            <TextInput value={form.leadTimeDays} onChange={(value) => patch("leadTimeDays", value)} type="number" step="1" className="tnum" />
          </Field>
          <Field label="Daily cutoff" hint="Orders approved after this slip to tomorrow.">
            <TextInput value={form.cutoffTime} onChange={(value) => patch("cutoffTime", value)} placeholder="16:00" className="tnum" />
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <Toggle checked={form.ediEnabled} onChange={(value) => patch("ediEnabled", value)} label="EDI enabled — transmit an X12 850 over SFTP" />
          <Toggle checked={form.preferred} onChange={(value) => patch("preferred", value)} label="Preferred supplier for auto-generated orders" />
          <Toggle checked={form.isActive} onChange={(value) => patch("isActive", value)} label="Active" />
        </div>
      </div>
    </Modal>
  );
}

/** Draft a PO from the vendor's own catalogue, pre-filling cost and pack size. */
function PoCreator({ vendors, onClose, onCreated }: { vendors: Vendor[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [picks, setPicks] = useState<Record<string, { packs: string; price: string }>>({});
  const [expectedDate, setExpectedDate] = useState(today());
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!vendorId) {
      setItems([]);
      return;
    }
    let live = true;
    void api
      .get<{ items: InventoryItem[] }>(`inventory?${qs({ vendorId })}`)
      .then((response) => {
        if (!live) return;
        setItems(response.items);
        // Pre-fill anything already at or below its reorder point.
        const seeded: Record<string, { packs: string; price: string }> = {};
        for (const item of response.items) {
          if (item.orderPacks > 0) {
            seeded[item.id] = { packs: String(item.orderPacks), price: (item.unitCost / 100).toFixed(2) };
          }
        }
        setPicks(seeded);
      })
      .catch((error) => {
        if (live) toast(errorMessage(error), "late");
      });
    return () => {
      live = false;
    };
  }, [vendorId]);

  const lines = useMemo(
    () =>
      Object.entries(picks)
        .map(([itemId, pick]) => ({ itemId, packs: Number(pick.packs) || 0, price: Math.round(Number(pick.price) * 100) || 0 }))
        .filter((line) => line.packs > 0),
    [picks],
  );

  const total = useMemo(() => {
    return lines.reduce((sum, line) => {
      const item = items.find((entry) => entry.id === line.itemId);
      const units = line.packs * (item?.packSize ?? 1);
      return sum + units * line.price;
    }, 0);
  }, [lines, items]);

  if (vendors.length === 0) {
    return (
      <Modal open onClose={onClose} title="New purchase order">
        <Empty title="Add a vendor first" hint="A purchase order has to belong to someone." icon="vendor" />
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New purchase order"
      subtitle="Items already below their reorder point are pre-filled with the suggested pack quantity."
      width="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || lines.length === 0}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api.post<{ id: string }>("purchase-orders", {
                  vendorId,
                  expectedDate,
                  notes,
                  lines: lines.map((line) => ({ inventoryItemId: line.itemId, quantityPacks: line.packs, unitPrice: line.price })),
                });
                toast(`Draft purchase order created with ${lines.length} line(s)`, "ok");
                onCreated(result.id);
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            Create draft · {formatMoney(total)}
          </Button>
        </>
      }
    >
      <div className="scroll-y flex max-h-[62vh] flex-col gap-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Vendor">
            <select className="field" value={vendorId} onChange={(event) => setVendorId(event.target.value)}>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.name}
                  {vendor.preferred ? " ★" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Expected delivery">
            <input className="field tnum" type="date" value={expectedDate} onChange={(event) => setExpectedDate(event.target.value)} />
          </Field>
          <Field label="Notes">
            <TextInput value={notes} onChange={setNotes} placeholder="Deliver before 10am…" />
          </Field>
        </div>

        {items.length === 0 ? (
          <Empty title="This vendor supplies no inventory items" hint="Assign items to them from the inventory screen." icon="inventory" />
        ) : (
          <div className="scroll-x">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Suggested</th>
                  <th className="text-right w-24">Packs</th>
                  <th className="text-right w-28">Unit price</th>
                  <th className="text-right">Line total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const pick = picks[item.id];
                  const packs = Number(pick?.packs) || 0;
                  const price = Math.round(Number(pick?.price) * 100) || 0;
                  const lineTotal = packs * item.packSize * price;
                  return (
                    <tr key={item.id} style={{ background: packs > 0 ? "var(--color-brand-50)" : undefined }}>
                      <td>
                        <span className="block font-semibold text-ink">{item.name}</span>
                        <span className="block text-[11px] text-ink-faint">
                          pack of {formatQuantity(item.packSize, 0)} {item.unit}
                          {item.health !== "ok" && <span className="ml-1 font-bold text-warn">· {item.health}</span>}
                        </span>
                      </td>
                      <td className="tnum text-right">
                        {formatQuantity(item.currentStock, 1)} {item.unit}
                      </td>
                      <td className="tnum text-right">
                        {item.orderPacks > 0 ? (
                          <button
                            type="button"
                            className="font-bold text-brand-600 hover:underline"
                            onClick={() =>
                              setPicks((current) => ({
                                ...current,
                                [item.id]: { packs: String(item.orderPacks), price: (item.unitCost / 100).toFixed(2) },
                              }))
                            }
                          >
                            {formatQuantity(item.orderPacks, 0)} packs
                          </button>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="text-right">
                        <TextInput
                          value={pick?.packs ?? ""}
                          onChange={(value) =>
                            setPicks((current) => ({
                              ...current,
                              [item.id]: { packs: value.replace(/[^\d.]/g, ""), price: pick?.price ?? (item.unitCost / 100).toFixed(2) },
                            }))
                          }
                          type="number"
                          step="1"
                          min="0"
                          placeholder="0"
                          className="tnum !w-20 !px-2 !py-1 text-right"
                        />
                      </td>
                      <td className="text-right">
                        <TextInput
                          value={pick?.price ?? (item.unitCost / 100).toFixed(2)}
                          onChange={(value) =>
                            setPicks((current) => ({
                              ...current,
                              [item.id]: { packs: pick?.packs ?? "", price: value.replace(/[^\d.]/g, "") },
                            }))
                          }
                          type="number"
                          step="0.01"
                          className="tnum !w-24 !px-2 !py-1 text-right"
                        />
                      </td>
                      <td className="tnum text-right font-bold">{packs > 0 ? formatMoney(lineTotal) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} className="text-right font-extrabold text-ink">
                    {lines.length} line{lines.length === 1 ? "" : "s"} · draft total
                  </td>
                  <td className="tnum text-right font-black">{formatMoney(total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
