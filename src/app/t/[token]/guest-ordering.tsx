"use client";

/**
 * QR table ordering & full 10-stage guest dining experience.
 *
 * - 01 Scan: Multi-guest table session (`table_sessions` + `table_guests` avatars)
 * - 02 Menu: Search, category pills, dish detail sheet (allergens, spice, modifiers, pairing upsell)
 * - 03 Order: Instant numbered table ticket (`T5 · #1007`, `Sent to staff ✓`)
 * - 05 Wait: Live circular countdown ring, 3-step stepper, Wi-Fi copy, Rewards, Spice Quiz
 * - 06 Call: `Need something?` waiter call + quick chips (`Water`, `Napkins`, `Bill`, `Cutlery`)
 * - 08 Pay: Itemized bill, equal 1-4 ways split, dynamic tip presets
 * - 09 Review: PAID digital receipt, email receipt dispatch, 1-tap 5-star review
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useLiveEvents, usePoll } from "@/lib/store";
import { Button, Chip, Empty, Icon, Modal, Spinner, TextInput, toast } from "@/components/ui";
import { ModifierModal, type ModifierSelection } from "@/components/ModifierModal";
import { WaitEngagementHub } from "@/components/guest/WaitEngagementHub";
import { NeedSomethingModal } from "@/components/guest/NeedSomethingModal";
import { GuestPaymentModal, GuestReceiptAndReview, type GuestPayResult } from "@/components/guest/GuestPaymentModal";
import { formatMoney } from "@/domain/money";
import { priceOrder, type PricingSettings } from "@/domain/pricing";
import type { TenderMethod } from "@/domain/checkout";
import type {
  GuestOrderView,
  GuestReviewInfo,
  MenuItem,
  OrderSnapshot,
  ServiceRequestInfo,
  TableGuest,
  TableSessionInfo,
} from "@/types";

interface GuestResponse extends GuestOrderView {
  pricing: PricingSettings;
  tenders: { id: TenderMethod; label: string; icon: string }[];
  tipPresets: number[];
  demoMode: boolean;
  referrer?: string;
}

interface GuestStatus {
  order: OrderSnapshot | null;
  stage: "idle" | "cart" | "pending_staff" | "cooking" | "ready" | "paid";
  session: TableSessionInfo | null;
  activeRequests: ServiceRequestInfo[];
  estimatedRemainingSeconds: number;
  estimatedTotalSeconds: number;
  paidAmount: number;
  remainingDue: number;
  review: GuestReviewInfo | null;
}

interface CartLine {
  key: number;
  menuItemId: string;
  name: string;
  emoji: string;
  unitPrice: number;
  quantity: number;
  optionIds: string[];
  modifiers: { price: number; name: string }[];
  note: string;
  upsellItemId?: string;
  upsellName?: string;
  upsellOriginalPrice?: number;
  upsellPrice?: number;
}

let cartSequence = 0;

export function GuestOrdering({ token }: { token: string }) {
  const initial = usePoll<GuestResponse>(`guest/${token}`, { interval: 0 });
  const status = usePoll<GuestStatus>(`guest/${token}/status`, { interval: 5000 });
  const [categoryId, setCategoryId] = useState("all");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [modifierItem, setModifierItem] = useState<MenuItem | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [guestModalOpen, setGuestModalOpen] = useState(false);
  const [guestNameInput, setGuestNameInput] = useState("");
  const [currentGuest, setCurrentGuest] = useState<TableGuest | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<GuestPayResult | null>(null);
  const [quizNonce, setQuizNonce] = useState(0);
  const joinedRef = useRef(false);

  const data = initial.data;
  const order = status.data?.order ?? data?.order ?? null;
  const session = status.data?.session ?? data?.session ?? null;
  const activeRequests = status.data?.activeRequests ?? data?.activeRequests ?? [];

  // SSE real-time sync for this restaurant & table
  useLiveEvents(
    (ev) => {
      if (ev.type === "quiz.updated") {
        setQuizNonce((n) => n + 1);
      } else if (
        ev.type === "order.updated" ||
        ev.type === "kds.updated" ||
        ev.type === "help.updated" ||
        ev.type === "table.session" ||
        ev.type === "floor.updated"
      ) {
        void status.reload();
        if (ev.type === "order.updated") void initial.reload();
      }
    },
    { token, enabled: Boolean(data) },
  );

  // Auto-join live shared table session on scan
  useEffect(() => {
    if (!data || joinedRef.current) return;
    joinedRef.current = true;
    const storageKey = `rms_guest_${data.tableId}`;
    let savedGuestId: string | undefined;
    let savedName = "";
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { id?: string; name?: string };
        savedGuestId = parsed.id;
        savedName = parsed.name ?? "";
      }
    } catch {
      /* ignore storage errors */
    }
    void api
      .post<{ session: TableSessionInfo; guest: TableGuest }>(`guest/${token}/join`, {
        guestId: savedGuestId,
        name: savedName,
      })
      .then((res) => {
        setCurrentGuest(res.guest);
        setGuestNameInput(res.guest.name);
        try {
          window.sessionStorage.setItem(storageKey, JSON.stringify({ id: res.guest.id, name: res.guest.name }));
        } catch {
          /* ignore */
        }
        void status.reload();
      })
      .catch(() => {
        /* non-fatal */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.tableId, token]);

  const visibleItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data?.menu ?? []).filter((item) => {
      if (categoryId !== "all" && item.categoryId !== categoryId) return false;
      return !needle || `${item.name} ${item.description} ${item.allergens}`.toLowerCase().includes(needle);
    });
  }, [data?.menu, categoryId, search]);

  const cartCount = cart.reduce(
    (sum, line) => sum + line.quantity + (line.upsellItemId ? line.quantity : 0),
    0,
  );
  const cartPricing = useMemo(() => {
    const pricingInput: { quantity: number; unitPrice: number; modifiers: { price: number; name: string }[] }[] = [];
    for (const line of cart) {
      pricingInput.push({ quantity: line.quantity, unitPrice: line.unitPrice, modifiers: line.modifiers });
      if (line.upsellItemId && line.upsellPrice !== undefined) {
        pricingInput.push({ quantity: line.quantity, unitPrice: line.upsellPrice, modifiers: [] });
      }
    }
    return priceOrder(
      pricingInput,
      0,
      data?.pricing ?? { vatRate: 13, vatInclusive: false, serviceChargeRate: 10 },
    );
  }, [cart, data?.pricing]);

  function addToCart(item: MenuItem, selection: ModifierSelection) {
    const options = item.groups
      .flatMap((group) => group.options)
      .filter((option) => selection.optionIds.includes(option.id));
    const includeUpsell = Boolean(selection.includeUpsell && item.upsellItem);
    setCart((current) => [
      ...current,
      {
        key: ++cartSequence,
        menuItemId: item.id,
        name: item.name,
        emoji: item.emoji,
        unitPrice: item.price,
        quantity: selection.quantity,
        optionIds: selection.optionIds,
        modifiers: options.map((option) => ({ name: option.name, price: option.price })),
        note: selection.note,
        upsellItemId: includeUpsell ? item.upsellItem!.id : undefined,
        upsellName: includeUpsell ? item.upsellItem!.name : undefined,
        upsellOriginalPrice: includeUpsell ? item.upsellItem!.price : undefined,
        upsellPrice: includeUpsell ? item.upsellItem!.discountedPrice : undefined,
      },
    ]);
    setModifierItem(null);
    toast(
      includeUpsell
        ? `${selection.quantity} × ${item.name} + ${item.upsellItem!.name} added`
        : `${selection.quantity} × ${item.name} added`,
      "ok",
    );
  }

  function changeQuantity(key: number, delta: number) {
    setCart((current) =>
      current
        .map((line) => (line.key === key ? { ...line, quantity: Math.max(0, line.quantity + delta) } : line))
        .filter((line) => line.quantity > 0),
    );
  }

  async function submitOrder() {
    if (!cart.length || busy) return;
    setBusy(true);
    try {
      const result = await api.post<{ order: OrderSnapshot; requiresStaffApproval: boolean }>(`guest/${token}/order`, {
        guestId: currentGuest?.id ?? null,
        guestName: currentGuest?.name ?? "",
        lines: cart.map((line) => ({
          menuItemId: line.menuItemId,
          quantity: line.quantity,
          modifiers: line.optionIds,
          note: line.note,
          upsellItemId: line.upsellItemId,
        })),
      });
      setCart([]);
      setCartOpen(false);
      await Promise.all([initial.reload(), status.reload()]);
      toast(
        result.requiresStaffApproval
          ? `${data?.tableLabel ?? ""} · #${result.order.checkNumber ?? ""} Sent to staff ✓`
          : "Order sent to the kitchen ✓",
        "ok",
      );
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }

  async function updateGuestName() {
    if (!data || !guestNameInput.trim()) return;
    try {
      const res = await api.post<{ session: TableSessionInfo; guest: TableGuest }>(`guest/${token}/join`, {
        guestId: currentGuest?.id,
        name: guestNameInput.trim(),
      });
      setCurrentGuest(res.guest);
      window.sessionStorage.setItem(`rms_guest_${data.tableId}`, JSON.stringify({ id: res.guest.id, name: res.guest.name }));
      setGuestModalOpen(false);
      void status.reload();
      toast(`Joined as ${res.guest.name}`, "ok");
    } catch (error) {
      toast(errorMessage(error), "late");
    }
  }

  if (initial.pending && !data) {
    return (
      <main className="flex min-h-screen items-center justify-center gap-3 bg-paper text-ink-faint">
        <Spinner className="size-7" />
        <span className="font-semibold">Opening your table menu…</span>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 text-center">
        <span className="flex size-16 items-center justify-center rounded-2xl bg-brand-500 text-xl font-black text-white">TK</span>
        <Icon name="qr" className="mt-8 size-12 text-ink-faint" />
        <h1 className="mt-4 text-2xl font-black text-ink">We could not open this table</h1>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-soft">{initial.error || "That table code is not available."}</p>
        <p className="mt-4 text-xs text-ink-faint">Please ask a member of staff for a fresh QR code.</p>
      </main>
    );
  }

  if (receipt) {
    return (
      <GuestReceiptAndReview
        token={token}
        data={data}
        result={receipt}
        currentGuest={currentGuest}
        existingReview={status.data?.review ?? null}
        onDone={() => {
          setReceipt(null);
          void Promise.all([initial.reload(), status.reload()]);
        }}
      />
    );
  }

  const cartPanel = (
    <CartContents
      cart={cart}
      pricing={cartPricing}
      busy={busy}
      requiresApproval={data.settings.qrRequireStaffApproval}
      onQuantity={changeQuantity}
      onSubmit={() => void submitOrder()}
    />
  );

  const guests = session?.guests ?? [];
  const openHelpCount = activeRequests.length;

  return (
    <div className="min-h-screen bg-paper pb-24 lg:pb-0">
      <header className="sticky top-0 z-20 border-b border-rule bg-paper-raised/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center gap-3 px-4 py-3 lg:px-6">
          <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-500 text-sm font-black text-white">
            {data.settings.logoDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={data.settings.logoDataUrl} alt={`${data.restaurantName} logo`} className="size-full bg-white object-contain" />
            ) : data.restaurantName.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-black text-ink">{data.restaurantName}</h1>
              <Chip tone="brand">{data.tableLabel}</Chip>
            </div>
            <p className="truncate text-[11px] text-ink-faint">{data.tagline}</p>
          </div>

          {/* Multi-guest session avatars */}
          {guests.length > 0 && (
            <button
              type="button"
              onClick={() => setGuestModalOpen(true)}
              title="Guests at this table"
              className="hidden items-center gap-1.5 rounded-full border border-rule bg-paper px-2.5 py-1 text-xs font-bold text-ink hover:border-brand-300 sm:flex"
            >
              <span className="flex -space-x-1.5">
                {guests.slice(0, 4).map((g) => (
                  <span
                    key={g.id}
                    className="flex size-6 items-center justify-center rounded-full border-2 border-paper-raised text-[10px] font-black text-white"
                    style={{ background: g.color }}
                  >
                    {g.initials}
                  </span>
                ))}
              </span>
              <span className="text-[11px] text-ink-soft">{guests.length} {guests.length === 1 ? "guest" : "guests"}</span>
            </button>
          )}

          {/* Call Waiter / Need Something */}
          <Button
            variant={openHelpCount > 0 ? "primary" : "soft"}
            size="sm"
            onClick={() => setHelpOpen(true)}
            className={openHelpCount > 0 ? "!bg-ember-500 !text-white" : ""}
          >
            <span aria-hidden="true">🔔</span>
            <span className="hidden sm:inline">{openHelpCount > 0 ? `Waiter (${openHelpCount})` : "Need something?"}</span>
            <span className="sm:hidden">{openHelpCount > 0 ? openHelpCount : "Help"}</span>
          </Button>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1500px] gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_370px] lg:p-6">
        <main className="min-w-0">
          {order && (
            <WaitEngagementHub
              token={token}
              tableLabel={data.tableLabel}
              order={order}
              stage={status.data?.stage ?? "cooking"}
              settings={data.settings}
              session={session}
              currentGuest={currentGuest}
              estimatedRemainingSeconds={status.data?.estimatedRemainingSeconds ?? 0}
              estimatedTotalSeconds={status.data?.estimatedTotalSeconds ?? 900}
              paidAmount={status.data?.paidAmount ?? 0}
              remainingDue={status.data?.remainingDue ?? order.total}
              onPay={() => setPaymentOpen(true)}
              onRefresh={() => void status.reload()}
              refreshing={status.pending}
              quizRefreshNonce={quizNonce}
            />
          )}

          <section className="mt-1">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.12em] text-brand-600">
                  Order to {data.tableLabel}
                </p>
                <h2 className="mt-0.5 text-2xl font-black tracking-tight text-ink">What can we bring you?</h2>
              </div>
              {currentGuest && (
                <button
                  type="button"
                  onClick={() => setGuestModalOpen(true)}
                  className="flex items-center gap-1.5 rounded-full border border-rule bg-paper-raised px-3 py-1 text-xs font-bold text-ink-soft hover:border-brand-300"
                >
                  <span
                    className="flex size-5 items-center justify-center rounded-full text-[9px] font-black text-white"
                    style={{ background: currentGuest.color }}
                  >
                    {currentGuest.initials}
                  </span>
                  Ordering as {currentGuest.name}
                </button>
              )}
            </div>

            <div className="relative mb-3">
              <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
              <TextInput
                value={search}
                onChange={setSearch}
                placeholder="Search momo, chiya, vegetarian…"
                className="!pl-9"
              />
            </div>

            <div className="no-scrollbar -mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="Menu categories">
              <CategoryPill active={categoryId === "all"} onClick={() => setCategoryId("all")}>All</CategoryPill>
              {data.categories.map((category) => (
                <CategoryPill key={category.id} active={categoryId === category.id} onClick={() => setCategoryId(category.id)}>
                  {category.icon} {category.name}
                </CategoryPill>
              ))}
            </div>

            {visibleItems.length === 0 ? (
              <Empty title="No dishes match" hint="Try another search or choose a different category." icon="menu" />
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                {visibleItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setModifierItem(item)}
                    className="card group flex min-h-[195px] flex-col p-3 text-left transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
                  >
                    <div className="flex items-start justify-between gap-1.5">
                      <span className="text-4xl" aria-hidden="true">{item.emoji || "🍽"}</span>
                      <div className="flex flex-col items-end gap-1">
                        {item.isFeatured && <Chip tone="ember">Popular</Chip>}
                        {item.upsellItem && <Chip tone="brand">Deal</Chip>}
                      </div>
                    </div>
                    <h3 className="mt-2.5 line-clamp-2 text-sm font-extrabold leading-tight text-ink">{item.name}</h3>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-faint">{item.description}</p>
                    <div className="mt-auto flex items-end justify-between gap-2 pt-3">
                      <div>
                        <span className="tnum text-sm font-black text-brand-600">{formatMoney(item.price)}</span>
                        {item.spiceLevel > 0 && (
                          <span className="ml-1.5 text-[10px]" aria-label={`Spice ${item.spiceLevel}`}>
                            {"🌶️".repeat(Math.min(3, item.spiceLevel))}
                          </span>
                        )}
                      </div>
                      <span className="flex size-7 items-center justify-center rounded-full bg-brand-500 text-white transition-transform group-hover:scale-105">
                        <Icon name="plus" className="size-4" />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </main>

        <aside className="sticky top-20 hidden h-fit max-h-[calc(100vh-100px)] overflow-y-auto lg:block">
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-rule px-4 py-3">
              <div>
                <h2 className="font-extrabold text-ink">Your new order</h2>
                <p className="text-xs text-ink-faint">
                  {data.settings.qrRequireStaffApproval ? "Staff confirms before kitchen fires" : "Goes straight to kitchen"}
                </p>
              </div>
              <Chip tone={cartCount ? "brand" : "neutral"}>{cartCount} item{cartCount === 1 ? "" : "s"}</Chip>
            </div>
            {cartPanel}
          </div>
          <p className="mt-3 px-2 text-center text-[11px] leading-relaxed text-ink-faint">
            Prices include the VAT and service charge shown before you order.
          </p>
        </aside>
      </div>

      {/* Mobile Sticky Bottom Bar */}
      <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-rule bg-paper-raised/95 p-3 backdrop-blur lg:hidden">
        <Button variant="soft" size="lg" onClick={() => setHelpOpen(true)} className="shrink-0">
          🔔
        </Button>
        <Button variant="primary" size="lg" className="flex-1" onClick={() => setCartOpen(true)}>
          <Icon name="receipt" className="size-5" />
          {cartCount
            ? `Place order · ${cartCount} · ${formatMoney(cartPricing.total)}`
            : "Your new order"}
        </Button>
      </div>

      <Modal open={cartOpen} onClose={() => setCartOpen(false)} title="Your new order" subtitle={`Order to ${data.tableLabel}`} width="max-w-xl">
        {cartPanel}
      </Modal>

      <Modal open={guestModalOpen} onClose={() => setGuestModalOpen(false)} title="Table session" subtitle={`${data.tableLabel} · Live co-diners`} width="max-w-sm">
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {guests.map((g) => (
              <div key={g.id} className="flex items-center gap-2 rounded-full border border-rule bg-paper px-3 py-1.5 text-xs font-bold">
                <span className="flex size-5 items-center justify-center rounded-full text-[10px] font-black text-white" style={{ background: g.color }}>
                  {g.initials}
                </span>
                <span>{g.name}</span>
              </div>
            ))}
          </div>
          <div>
            <p className="label">Your display name (for split bills & quiz)</p>
            <div className="flex gap-2">
              <TextInput value={guestNameInput} onChange={setGuestNameInput} placeholder="e.g. Aman" className="flex-1" />
              <Button variant="primary" size="md" onClick={() => void updateGuestName()}>Save</Button>
            </div>
          </div>
        </div>
      </Modal>

      <ModifierModal
        item={modifierItem}
        open={Boolean(modifierItem)}
        confirmLabel="Add to order"
        showUpsell
        onClose={() => setModifierItem(null)}
        onConfirm={(selection) => {
          if (modifierItem) addToCart(modifierItem, selection);
        }}
      />

      <NeedSomethingModal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        token={token}
        tableLabel={data.tableLabel}
        currentGuest={currentGuest}
        activeRequests={activeRequests}
        onRequested={() => void status.reload()}
      />

      {order && (
        <GuestPaymentModal
          open={paymentOpen}
          onClose={() => setPaymentOpen(false)}
          token={token}
          tableLabel={data.tableLabel}
          order={order}
          session={session}
          currentGuest={currentGuest}
          paymentQr={data.paymentQr}
          tenders={data.tenders}
          demoMode={data.demoMode}
          onPaid={(result) => {
            setPaymentOpen(false);
            setReceipt(result);
            void Promise.all([initial.reload(), status.reload()]);
          }}
        />
      )}

      <footer className="mx-auto max-w-[1500px] px-6 pb-6 pt-3 text-center text-[11px] text-ink-faint lg:text-left">
        {data.address && <span>{data.address} · </span>}
        {data.phone && <a href={`tel:${data.phone}`} className="font-semibold text-brand-600">{data.phone}</a>}
      </footer>
    </div>
  );
}

function CategoryPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3.5 py-2 text-xs font-bold transition-colors ${
        active ? "border-brand-500 bg-brand-500 text-white" : "border-rule bg-paper-raised text-ink-soft hover:border-brand-300"
      }`}
    >
      {children}
    </button>
  );
}

function CartContents({
  cart,
  pricing,
  busy,
  requiresApproval,
  onQuantity,
  onSubmit,
}: {
  cart: CartLine[];
  pricing: ReturnType<typeof priceOrder>;
  busy: boolean;
  requiresApproval: boolean;
  onQuantity: (key: number, delta: number) => void;
  onSubmit: () => void;
}) {
  if (!cart.length) {
    return <Empty title="Your order is empty" hint="Choose a dish, select any options, then add it here." icon="receipt" />;
  }

  return (
    <div className="flex flex-col">
      <ul className="max-h-[45vh] divide-y divide-rule overflow-y-auto px-4">
        {cart.map((line) => (
          <li key={line.key} className="flex items-start gap-2.5 py-3">
            <span className="text-xl" aria-hidden="true">{line.emoji || "🍽"}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-ink">{line.name}</p>
              {line.modifiers.length > 0 && (
                <p className="truncate text-xs text-ink-faint">{line.modifiers.map((m) => m.name).join(", ")}</p>
              )}
              {line.upsellName && line.upsellPrice !== undefined && (
                <p className="mt-0.5 text-[11px] font-bold text-ember-600">
                  + {line.upsellName} (Deal · {formatMoney(line.upsellPrice)})
                </p>
              )}
              {line.note && <p className="mt-0.5 text-xs italic text-ink-soft">“{line.note}”</p>}
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={() => onQuantity(line.key, -1)} aria-label="Remove one" className="btn btn-soft !px-2 !py-1">
                  <Icon name="minus" className="size-3.5" />
                </button>
                <span className="tnum w-5 text-center text-sm font-black">{line.quantity}</span>
                <button type="button" onClick={() => onQuantity(line.key, 1)} aria-label="Add one" className="btn btn-soft !px-2 !py-1">
                  <Icon name="plus" className="size-3.5" />
                </button>
              </div>
            </div>
            <span className="tnum text-sm font-extrabold text-ink">
              {formatMoney(
                (line.unitPrice +
                  line.modifiers.reduce((sum, m) => sum + m.price, 0) +
                  (line.upsellPrice ?? 0)) *
                  line.quantity,
              )}
            </span>
          </li>
        ))}
      </ul>

      <div className="border-t border-rule bg-paper px-4 py-3">
        <dl className="tnum space-y-1 text-xs">
          <div className="flex justify-between"><dt className="text-ink-faint">Subtotal</dt><dd className="font-bold">{formatMoney(pricing.subtotal)}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-faint">Service charge</dt><dd className="font-bold">{formatMoney(pricing.serviceCharge)}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-faint">VAT</dt><dd className="font-bold">{formatMoney(pricing.vat)}</dd></div>
          <div className="flex justify-between border-t border-rule pt-2 text-base font-black text-ink">
            <dt>Total</dt>
            <dd>{formatMoney(pricing.total)}</dd>
          </div>
        </dl>

        <Button variant="primary" size="lg" className="mt-3 w-full" disabled={busy} onClick={onSubmit}>
          {busy ? <Spinner className="size-4" /> : <Icon name="arrow-right" className="size-5" />}
          {busy ? "Sending…" : requiresApproval ? "Place order" : "Send to the kitchen"}
        </Button>
      </div>
    </div>
  );
}
