"use client";

/**
 * Screen 2 — POS Ordering Dashboard.
 *
 * Three columns, as a server actually works them: categories down the left, the
 * menu grid in the middle, the live ticket on the right. Nothing leaves the
 * right-hand column until "Send" is pressed, so a mistap can still be corrected
 * before the kitchen sees it.
 *
 * The ticket list is polled rather than pushed — there is no websocket layer in
 * this deployment — so a 3-second interval keeps the floor honest without
 * hammering SQLite.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, errorMessage } from "@/lib/api";
import { usePoll, useStore } from "@/lib/store";
import { Button, Chip, Empty, Icon, Modal, TextInput, toast, Avatar } from "@/components/ui";
import { ModifierModal, defaultOptions, type ModifierSelection } from "@/components/ModifierModal";
import { formatMoney } from "@/domain/money";
import type { MenuItem, OrderSnapshot, TableSnapshot } from "@/types";
import type { ServiceStyle } from "@/domain/settings";

export default function PosPage() {
  const { state, user, allowed } = useStore();
  const router = useRouter();

  const categories = state?.categories ?? [];
  const menu = state?.menu ?? [];
  const settings = state?.settings;

  const [categoryId, setCategoryId] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [modifierItem, setModifierItem] = useState<MenuItem | null>(null);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);

  const { data: orderData, reload: reloadOrders } = usePoll<{ orders: OrderSnapshot[] }>("orders", { interval: 3000 });
  const { data: floorData } = usePoll<{ tables: TableSnapshot[] }>("floor", { interval: 4000 });

  const orders = orderData?.orders ?? [];
  const tables = floorData?.tables ?? [];

  // Follow the server's own tickets first; fall back to the most recent open one.
  const myOrders = useMemo(
    () => orders.filter((order) => order.status !== "closed"),
    [orders],
  );
  const activeOrder = useMemo(
    () => myOrders.find((order) => order.id === activeOrderId) ?? myOrders.find((order) => order.serverId === user?.id) ?? myOrders[0] ?? null,
    [myOrders, activeOrderId, user],
  );

  useEffect(() => {
    if (activeOrder && activeOrderId !== activeOrder.id) setActiveOrderId(activeOrder.id);
  }, [activeOrder, activeOrderId]);

  const visibleItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return menu.filter((item) => {
      if (categoryId !== "all" && item.categoryId !== categoryId) return false;
      if (needle && !`${item.name} ${item.description}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [menu, categoryId, search]);

  // ------------------------------------------------------------------- actions
  const addLine = useCallback(
    async (item: MenuItem, selection?: ModifierSelection) => {
      if (!activeOrder) {
        setTicketOpen(true);
        toast("Start a ticket first", "warn");
        return;
      }
      try {
        await api.post(`orders/${activeOrder.id}/lines`, {
          menuItemId: item.id,
          quantity: selection?.quantity ?? 1,
          modifiers: selection?.optionIds ?? defaultOptions(item),
          note: selection?.note ?? "",
        });
        await reloadOrders();
      } catch (error) {
        toast(errorMessage(error), "late");
      }
    },
    [activeOrder, reloadOrders],
  );

  const onItemTap = useCallback(
    (item: MenuItem) => {
      if (!item.isAvailable) {
        toast(`${item.name} is 86'd`, "warn");
        return;
      }
      if (item.groups.length) {
        setEditingLineId(null);
        setModifierItem(item);
      } else {
        void addLine(item);
      }
    },
    [addLine],
  );

  const changeQuantity = useCallback(
    async (lineId: string, quantity: number) => {
      if (!activeOrder || quantity < 1) return;
      try {
        await api.patch(`orders/${activeOrder.id}/lines/${lineId}`, { quantity });
        await reloadOrders();
      } catch (error) {
        toast(errorMessage(error), "late");
      }
    },
    [activeOrder, reloadOrders],
  );

  const voidLine = useCallback(
    async (lineId: string, name: string) => {
      if (!activeOrder) return;
      const reason = window.prompt(`Why is “${name}” being voided?`, "Guest changed order");
      if (reason === null) return;
      const managerPin = settings?.managerPinForVoid && !allowed("admin.users")
        ? window.prompt("Manager PIN required to approve this void") ?? undefined
        : undefined;
      if (settings?.managerPinForVoid && !allowed("admin.users") && managerPin === undefined) return;
      try {
        await api.del(`orders/${activeOrder.id}/lines/${lineId}`, { reason: reason || "Voided", managerPin });
        toast(`Voided ${name}`, "ok");
        await reloadOrders();
      } catch (error) {
        toast(errorMessage(error), "late");
      }
    },
    [activeOrder, reloadOrders, settings?.managerPinForVoid, allowed],
  );

  const send = useCallback(async () => {
    if (!activeOrder) return;
    try {
      await api.post(`orders/${activeOrder.id}/send`);
      toast("Sent to the kitchen", "ok");
      await reloadOrders();
    } catch (error) {
      toast(errorMessage(error), "late");
    }
  }, [activeOrder, reloadOrders]);

  const fire = useCallback(async () => {
    if (!activeOrder) return;
    try {
      await api.post(`orders/${activeOrder.id}/fire`);
      toast("Entrees fired", "ok");
      await reloadOrders();
    } catch (error) {
      toast(errorMessage(error), "late");
    }
  }, [activeOrder, reloadOrders]);

  if (!state) return null;

  const vatRate = settings?.vatRate ?? 13;
  const serviceRate = settings?.serviceChargeRate ?? 0;

  return (
    <div className="flex h-[calc(100vh-49px)] min-h-[560px]">
      {/* ------------------------------------------------------- col 1: categories */}
      <aside className="hidden w-[104px] shrink-0 flex-col border-r border-rule bg-paper-raised md:flex">
        <div className="scroll-y flex-1 py-2">
          <CategoryButton
            active={categoryId === "all"}
            label="All"
            icon="🍽"
            count={menu.length}
            onClick={() => setCategoryId("all")}
          />
          {categories.map((category) => (
            <CategoryButton
              key={category.id}
              active={categoryId === category.id}
              label={category.name}
              icon={category.icon || "•"}
              count={menu.filter((item) => item.categoryId === category.id).length}
              onClick={() => setCategoryId(category.id)}
            />
          ))}
        </div>
      </aside>

      {/* --------------------------------------------------------- col 2: menu grid */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-rule bg-paper-raised px-3 py-2">
          <div className="relative min-w-0 flex-1">
            <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <input
              className="field !pl-8"
              placeholder="Search the menu…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Button variant="primary" onClick={() => setTicketOpen(true)}>
            <Icon name="plus" className="size-4" />
            New ticket
          </Button>
        </div>

        {/* Horizontal category rail for narrow screens where the sidebar is hidden. */}
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto border-b border-rule bg-paper-raised px-3 py-2 md:hidden">
          <RailChip active={categoryId === "all"} onClick={() => setCategoryId("all")}>
            All
          </RailChip>
          {categories.map((category) => (
            <RailChip key={category.id} active={categoryId === category.id} onClick={() => setCategoryId(category.id)}>
              {category.icon} {category.name}
            </RailChip>
          ))}
        </div>

        <div className="scroll-y flex-1 p-3">
          {visibleItems.length === 0 ? (
            <Empty title="No items match that search" hint="Try a different term, or clear the category filter." />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
              {visibleItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onItemTap(item)}
                  disabled={!item.isAvailable}
                  className="card relative flex flex-col gap-1 p-2.5 text-left transition-all hover:-translate-y-px hover:border-brand-300 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0 disabled:hover:shadow-none"
                >
                  <span className="flex items-start justify-between gap-1">
                    <span className="text-2xl leading-none">{item.emoji || "🍽"}</span>
                    {item.groups.length > 0 && (
                      <Icon name="edit" className="size-3.5 shrink-0 text-ink-faint" title="Has modifiers" />
                    )}
                  </span>
                  <span className="line-clamp-2 text-[13px] font-bold leading-tight text-ink">{item.name}</span>
                  <span className="tnum mt-auto text-[13px] font-extrabold text-brand-600">{formatMoney(item.price)}</span>
                  {!item.isAvailable && (
                    <span className="absolute right-1.5 top-1.5 rounded bg-late px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-white">
                      86'd
                    </span>
                  )}
                  {item.isFeatured && item.isAvailable && (
                    <span className="absolute -left-px top-6 rounded-r bg-ember-500 px-1.5 py-0.5 text-[9px] font-black uppercase text-white">
                      ★
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* -------------------------------------------------------- col 3: the ticket */}
      <aside className="flex w-full max-w-[360px] shrink-0 flex-col border-l border-rule bg-paper-raised">
        {!activeOrder ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <Icon name="pos" className="size-9 text-ink-faint/40" />
            <p className="text-sm font-bold text-ink-soft">No open ticket</p>
            <p className="text-xs text-ink-faint">Start a ticket for a table or a takeout order to begin ringing.</p>
            <Button variant="primary" onClick={() => setTicketOpen(true)}>
              <Icon name="plus" className="size-4" />
              New ticket
            </Button>
            {myOrders.length === 0 && (
              <p className="mt-2 text-[11px] text-ink-faint">{myOrders.length} other tickets are open on this terminal.</p>
            )}
          </div>
        ) : (
          <>
            {/* Ticket header + switcher */}
            <div className="border-b border-rule px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-extrabold text-ink">
                    {activeOrder.tableLabel || activeOrder.guestName || "Ticket"}
                    <span className="tnum ml-1.5 font-semibold text-ink-faint">#{activeOrder.checkNumber ?? "—"}</span>
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
                    <Chip tone={activeOrder.status === "sent" ? "info" : "neutral"}>{activeOrder.status}</Chip>
                    <span>{activeOrder.guests} guest{activeOrder.guests === 1 ? "" : "s"}</span>
                    <span>· {activeOrder.channel.replace("_", " ")}</span>
                    {activeOrder.serverName && <span>· {activeOrder.serverName}</span>}
                  </p>
                </div>
                {myOrders.length > 1 && (
                  <select
                    className="field !w-auto !py-1 !text-[11px]"
                    value={activeOrder.id}
                    onChange={(event) => setActiveOrderId(event.target.value)}
                    aria-label="Switch ticket"
                  >
                    {myOrders.map((order) => (
                      <option key={order.id} value={order.id}>
                        #{order.checkNumber ?? "—"} {order.tableLabel || order.guestName}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            {/* Lines */}
            <div className="scroll-y flex-1 px-2 py-2">
              {activeOrder.items.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-ink-faint">
                  Tap the menu to add items.
                  <br />
                  Nothing is sent until you press Send.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {activeOrder.items.map((line) => (
                    <li
                      key={line.id}
                      className={`rounded-lg border px-2 py-1.5 ${
                        line.isVoid ? "border-rule bg-paper-sunken opacity-60" : "border-rule bg-paper"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            aria-label={`Decrease ${line.name}`}
                            disabled={line.isVoid || line.quantity <= 1 || Boolean(line.sentAt)}
                            onClick={() => void changeQuantity(line.id, line.quantity - 1)}
                            className="rounded p-0.5 text-ink-faint hover:bg-rule hover:text-ink disabled:opacity-30"
                          >
                            <Icon name="minus" className="size-3.5" />
                          </button>
                          <span className="tnum w-5 text-center text-[13px] font-extrabold text-ink">{line.quantity}</span>
                          <button
                            type="button"
                            aria-label={`Increase ${line.name}`}
                            disabled={line.isVoid}
                            onClick={() => void changeQuantity(line.id, line.quantity + 1)}
                            className="rounded p-0.5 text-ink-faint hover:bg-rule hover:text-ink disabled:opacity-30"
                          >
                            <Icon name="plus" className="size-3.5" />
                          </button>
                        </div>

                        <div className="min-w-0 flex-1">
                          <p className={`truncate text-[13px] font-bold text-ink ${line.isVoid ? "line-through" : ""}`}>
                            {line.name}
                          </p>
                          {line.modifiers.length > 0 && (
                            <p className="truncate text-[11px] text-ink-faint">
                              {line.modifiers.map((modifier) => modifier.name).join(", ")}
                            </p>
                          )}
                          {line.note && <p className="truncate text-[11px] font-semibold text-ember-600">“{line.note}”</p>}
                          <div className="mt-0.5 flex items-center gap-1.5">
                            {line.seat > 0 && <Chip tone="neutral">seat {line.seat}</Chip>}
                            {line.sentAt ? (
                              <Chip tone={line.kdsStatus === "READY" ? "ok" : line.kdsStatus === "HOLD" ? "warn" : "info"}>
                                {line.kdsStatus.toLowerCase()}
                              </Chip>
                            ) : (
                              <Chip tone="neutral">not sent</Chip>
                            )}
                            {line.isVoid && <Chip tone="late">void · {line.voidReason ?? ""}</Chip>}
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className="tnum text-[13px] font-extrabold text-ink">{formatMoney(line.lineTotal)}</span>
                          {!line.isVoid && (
                            <div className="flex gap-0.5">
                              {line.modifiers.length > 0 && !line.sentAt && (
                                <button
                                  type="button"
                                  aria-label={`Edit ${line.name}`}
                                  onClick={() => {
                                    const item = menu.find((entry) => entry.id === line.menuItemId);
                                    if (!item) return;
                                    setEditingLineId(line.id);
                                    setModifierItem(item);
                                  }}
                                  className="rounded p-0.5 text-ink-faint hover:text-brand-600"
                                >
                                  <Icon name="edit" className="size-3.5" />
                                </button>
                              )}
                              {(allowed("pos.void") || settings?.managerPinForVoid) && (
                                <button
                                  type="button"
                                  aria-label={`Void ${line.name}`}
                                  onClick={() => void voidLine(line.id, line.name)}
                                  className="rounded p-0.5 text-ink-faint hover:text-late"
                                >
                                  <Icon name="trash" className="size-3.5" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Totals + actions */}
            <div className="border-t border-rule px-3 py-2.5">
              <dl className="tnum mb-2 flex flex-col gap-0.5 text-[12px]">
                <Row label={`Subtotal (${activeOrder.itemCount} item${activeOrder.itemCount === 1 ? "" : "s"})`} value={formatMoney(activeOrder.subtotal)} />
                {activeOrder.discount > 0 && (
                  <Row label="Discount" value={`− ${formatMoney(activeOrder.discount)}`} tone="var(--color-late)" />
                )}
                {vatRate > 0 && <Row label={`VAT ${vatRate}%`} value={formatMoney(activeOrder.vat)} />}
                {serviceRate > 0 && activeOrder.serviceCharge > 0 && (
                  <Row label={`Service ${serviceRate}%`} value={formatMoney(activeOrder.serviceCharge)} />
                )}
                <div className="mt-1 flex items-baseline justify-between border-t border-rule pt-1.5">
                  <dt className="text-[13px] font-extrabold text-ink">Total</dt>
                  <dd className="text-lg font-extrabold leading-none text-ink">{formatMoney(activeOrder.total)}</dd>
                </div>
              </dl>

              <div className="grid grid-cols-2 gap-1.5">
                <Button variant="soft" disabled={!activeOrder.hasHold || !allowed("pos.fire")} onClick={() => void fire()}>
                  <Icon name="fire" className="size-4" />
                  Fire
                </Button>
                <Button variant="primary" disabled={activeOrder.activeItems.length === 0 || !allowed("pos.send")} onClick={() => void send()}>
                  Send
                </Button>
                <Button
                  variant="ghost"
                  className="col-span-2"
                  disabled={!allowed("pos.discount") || activeOrder.activeItems.length === 0}
                  onClick={() => router.push(`/checkout/${activeOrder.id}`)}
                >
                  <Icon name="cash" className="size-4" />
                  Payment & checkout
                </Button>
              </div>

              {activeOrder.status === "sent" && !activeOrder.allReady && (
                <p className="mt-2 text-center text-[11px] font-semibold text-warn">
                  {activeOrder.activeItems.filter((line) => line.kdsStatus !== "READY").length} item(s) still in the kitchen
                </p>
              )}
            </div>
          </>
        )}
      </aside>

      {/* ---------------------------------------------------------- modifier modal */}
      <ModifierModal
        item={modifierItem}
        open={Boolean(modifierItem)}
        initial={
          editingLineId
            ? (() => {
                const line = activeOrder?.items.find((entry) => entry.id === editingLineId);
                if (!line) return undefined;
                return {
                  optionIds: line.modifiers.map((modifier) => modifier.modifierId).filter(Boolean) as string[],
                  quantity: line.quantity,
                  note: line.note,
                };
              })()
            : undefined
        }
        confirmLabel={editingLineId ? "Save changes" : "Add to ticket"}
        onClose={() => {
          setModifierItem(null);
          setEditingLineId(null);
        }}
        onConfirm={async (selection) => {
          const item = modifierItem;
          setModifierItem(null);
          if (!item) return;
          if (editingLineId && activeOrder) {
            try {
              await api.patch(`orders/${activeOrder.id}/lines/${editingLineId}`, {
                quantity: selection.quantity,
                note: selection.note,
                modifiers: selection.optionIds,
              });
              toast("Line updated", "ok");
              await reloadOrders();
            } catch (error) {
              toast(errorMessage(error), "late");
            }
            setEditingLineId(null);
          } else {
            await addLine(item, selection);
          }
        }}
      />

      {/* ------------------------------------------------------- new ticket modal */}
      <NewTicketModal
        open={ticketOpen}
        tables={tables}
        operatingMode={settings?.operatingMode ?? "full_service"}
        onClose={() => setTicketOpen(false)}
        onCreated={(orderId) => {
          setActiveOrderId(orderId);
          setTicketOpen(false);
          void reloadOrders();
        }}
      />
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="font-semibold" style={{ color: tone ?? "var(--color-ink-soft)" }}>
        {value}
      </dd>
    </div>
  );
}

function CategoryButton({
  active,
  label,
  icon,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full flex-col items-center gap-0.5 px-1 py-2.5 text-center transition-colors ${
        active ? "bg-brand-500 text-white" : "text-ink-soft hover:bg-paper-sunken"
      }`}
    >
      <span className="text-lg leading-none">{icon}</span>
      <span className="line-clamp-2 text-[11px] font-bold leading-tight">{label}</span>
      <span className={`tnum text-[10px] ${active ? "text-white/70" : "text-ink-faint"}`}>{count}</span>
    </button>
  );
}

function RailChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-bold transition-colors ${
        active ? "bg-brand-500 text-white" : "bg-paper-sunken text-ink-soft"
      }`}
    >
      {children}
    </button>
  );
}

/** Open a ticket on an available table, or as a takeout/QR order. */
function NewTicketModal({
  open,
  tables,
  operatingMode,
  onClose,
  onCreated,
}: {
  open: boolean;
  tables: TableSnapshot[];
  operatingMode: ServiceStyle;
  onClose: () => void;
  onCreated: (orderId: string) => void;
}) {
  const { user } = useStore();
  const [channel, setChannel] = useState<"dine_in" | "takeout">("dine_in");
  const [guests, setGuests] = useState("2");
  const [guestName, setGuestName] = useState("");
  const [busy, setBusy] = useState(false);

  const available = tables.filter((table) => table.status === "available");

  useEffect(() => {
    if (open) setChannel(operatingMode === "quick_service" ? "takeout" : "dine_in");
  }, [open, operatingMode]);

  async function create(tableId?: string) {
    setBusy(true);
    try {
      const order = await api.post<OrderSnapshot>("orders", {
        tableId: tableId ?? null,
        guests: Math.max(1, Number(guests) || 1),
        channel,
        serverId: user?.id ?? null,
        guestName: guestName.trim() || (tableId ? "" : "Takeout"),
      });
      toast(`Ticket #${order.checkNumber} opened`, "ok");
      onCreated(order.id);
      setGuestName("");
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start a new ticket"
      subtitle="Seat a table or ring a takeout order"
      width="max-w-2xl"
    >
      <div className="mb-3 flex gap-1.5">
        {(["dine_in", "takeout"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setChannel(option)}
            className={`btn ${channel === option ? "btn-primary" : "btn-ghost"}`}
          >
            {option === "dine_in" ? "Dine-in" : "Takeout"}
          </button>
        ))}
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="label">Guests</span>
          <TextInput value={guests} onChange={setGuests} type="number" min={1} />
        </label>
        <label className="block">
          <span className="label">Guest name (optional)</span>
          <TextInput value={guestName} onChange={setGuestName} placeholder="e.g. Sharma party" />
        </label>
      </div>

      {channel === "takeout" ? (
        <Button variant="primary" size="lg" className="w-full" disabled={busy} onClick={() => void create()}>
          Open takeout ticket
        </Button>
      ) : (
        <>
          <p className="label">Available tables ({available.length})</p>
          {available.length === 0 ? (
            <Empty title="Every table is occupied" hint="Seat a party from the floor plan, or open a takeout ticket." icon="floor" />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1.5">
              {available.map((table) => (
                <button
                  key={table.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void create(table.id)}
                  className="card flex flex-col items-center gap-0.5 p-2 transition-all hover:-translate-y-px hover:border-brand-300"
                >
                  <span className="text-sm font-extrabold text-ink">{table.label}</span>
                  <span className="text-[11px] text-ink-faint">
                    seats {table.capacity} · {table.sectionName}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <p className="mt-3 text-center text-[11px] text-ink-faint">
        Prefer to seat from the room?{" "}
        <Link href="/floor" className="font-bold text-brand-600 underline">
          Open the floor plan
        </Link>
      </p>
      {user && (
        <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-ink-faint">
          <Avatar name={user.name} initials={user.initials} color={user.color} size={18} />
          Tickets open under {user.name}
        </p>
      )}
    </Modal>
  );
}
