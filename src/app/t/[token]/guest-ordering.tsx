"use client";

/**
 * QR table ordering — the guest counterpart to the POS.
 *
 * The table token is the guest's only authority. Menu modifiers are selected
 * through the same component as the POS and cart totals use the same pricing
 * engine; the API validates everything again before the ticket reaches the KDS.
 */
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { usePoll } from "@/lib/store";
import { Button, Chip, Empty, Icon, Modal, Spinner, TextInput, toast } from "@/components/ui";
import { ModifierModal, type ModifierSelection } from "@/components/ModifierModal";
import { formatMoney } from "@/domain/money";
import { priceOrder, type PricingSettings } from "@/domain/pricing";
import type { TenderMethod } from "@/domain/checkout";
import type { GuestOrderView, MenuItem, OrderLine, OrderSnapshot } from "@/types";

interface GuestResponse extends GuestOrderView {
  pricing: PricingSettings;
  tenders: { id: TenderMethod; label: string; icon: string }[];
  tipPresets: number[];
  demoMode: boolean;
  referrer?: string;
}

interface GuestStatus {
  order: OrderSnapshot | null;
  stage: "idle" | "cart" | "cooking" | "ready" | "paid";
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
}

interface PaymentResult {
  order: OrderSnapshot;
  receipt: { label: string; value: string; emphasis?: boolean }[];
}

let cartSequence = 0;

export function GuestOrdering({ token }: { token: string }) {
  const initial = usePoll<GuestResponse>(`guest/${token}`);
  const status = usePoll<GuestStatus>(`guest/${token}/status`, { interval: 4000 });
  const [categoryId, setCategoryId] = useState("all");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [modifierItem, setModifierItem] = useState<MenuItem | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<PaymentResult | null>(null);

  const data = initial.data;
  const order = status.data?.order ?? data?.order ?? null;

  const visibleItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data?.menu ?? []).filter((item) => {
      if (categoryId !== "all" && item.categoryId !== categoryId) return false;
      return !needle || `${item.name} ${item.description} ${item.allergens}`.toLowerCase().includes(needle);
    });
  }, [data?.menu, categoryId, search]);

  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const cartPricing = useMemo(
    () =>
      priceOrder(
        cart.map((line) => ({ quantity: line.quantity, unitPrice: line.unitPrice, modifiers: line.modifiers })),
        0,
        data?.pricing ?? { vatRate: 13, vatInclusive: false, serviceChargeRate: 10 },
      ),
    [cart, data?.pricing],
  );

  function addToCart(item: MenuItem, selection: ModifierSelection) {
    const options = item.groups.flatMap((group) => group.options).filter((option) => selection.optionIds.includes(option.id));
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
      },
    ]);
    setModifierItem(null);
    toast(`${selection.quantity} × ${item.name} added`, "ok");
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
      await api.post(`guest/${token}/order`, {
        lines: cart.map((line) => ({
          menuItemId: line.menuItemId,
          quantity: line.quantity,
          modifiers: line.optionIds,
          note: line.note,
        })),
      });
      setCart([]);
      setCartOpen(false);
      await Promise.all([initial.reload(), status.reload()]);
      toast("Order sent to the kitchen", "ok");
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
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
    return <GuestReceipt data={data} result={receipt} onDone={() => setReceipt(null)} />;
  }

  const cartPanel = (
    <CartContents
      cart={cart}
      pricing={cartPricing}
      busy={busy}
      onQuantity={changeQuantity}
      onSubmit={() => void submitOrder()}
    />
  );

  return (
    <div className="min-h-screen bg-paper pb-24 lg:pb-0">
      <header className="border-b border-rule bg-paper-raised">
        <div className="mx-auto flex max-w-[1500px] items-center gap-3 px-4 py-3 lg:px-6">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-sm font-black text-white">
            {data.restaurantName.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-black text-ink">{data.restaurantName}</h1>
            <p className="truncate text-[11px] text-ink-faint">{data.tagline}</p>
          </div>
          <Chip tone="brand">{data.tableLabel}</Chip>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1500px] gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_370px] lg:p-6">
        <main className="min-w-0">
          {order && (
            <CurrentCheck
              order={order}
              onPay={() => setPaymentOpen(true)}
              onRefresh={() => void status.reload()}
              refreshing={status.pending}
            />
          )}

          <section className="mt-2">
            <div className="mb-4">
              <p className="text-[11px] font-black uppercase tracking-[0.12em] text-brand-600">Order to {data.tableLabel}</p>
              <h2 className="mt-1 text-2xl font-black tracking-tight text-ink">What can we bring you?</h2>
              <p className="mt-1 text-sm text-ink-soft">Your selections go straight to the kitchen when you place the order.</p>
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
                    className="card group flex min-h-[190px] flex-col p-3 text-left transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-4xl" aria-hidden="true">{item.emoji || "🍽"}</span>
                      {item.isFeatured && <Chip tone="ember">Popular</Chip>}
                    </div>
                    <h3 className="mt-3 line-clamp-2 text-sm font-extrabold leading-tight text-ink">{item.name}</h3>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-faint">{item.description}</p>
                    <div className="mt-auto flex items-end justify-between gap-2 pt-3">
                      <span className="tnum text-sm font-black text-brand-600">{formatMoney(item.price)}</span>
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

        <aside className="sticky top-5 hidden h-fit max-h-[calc(100vh-40px)] overflow-y-auto lg:block">
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-rule px-4 py-3">
              <div>
                <h2 className="font-extrabold text-ink">Your new order</h2>
                <p className="text-xs text-ink-faint">Not sent to the kitchen yet</p>
              </div>
              <Chip tone={cartCount ? "brand" : "neutral"}>{cartCount} item{cartCount === 1 ? "" : "s"}</Chip>
            </div>
            {cartPanel}
          </div>
          <p className="mt-3 px-2 text-center text-[11px] leading-relaxed text-ink-faint">Prices include the VAT and service charge shown before you order. Please tell staff about any allergies.</p>
        </aside>
      </div>

      <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper-raised/95 p-3 backdrop-blur lg:hidden">
        <Button variant="primary" size="lg" className="w-full" onClick={() => setCartOpen(true)}>
          <Icon name="receipt" className="size-5" />
          {cartCount ? `View new order · ${cartCount} item${cartCount === 1 ? "" : "s"} · ${formatMoney(cartPricing.total)}` : "Your new order"}
        </Button>
      </div>

      <Modal open={cartOpen} onClose={() => setCartOpen(false)} title="Your new order" subtitle={`Order to ${data.tableLabel}`} width="max-w-xl">
        {cartPanel}
      </Modal>

      <ModifierModal
        item={modifierItem}
        open={Boolean(modifierItem)}
        confirmLabel="Add to order"
        onClose={() => setModifierItem(null)}
        onConfirm={(selection) => {
          if (modifierItem) addToCart(modifierItem, selection);
        }}
      />

      {order && (
        <PaymentSheet
          open={paymentOpen}
          onClose={() => setPaymentOpen(false)}
          token={token}
          order={order}
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
  onQuantity,
  onSubmit,
}: {
  cart: CartLine[];
  pricing: ReturnType<typeof priceOrder>;
  busy: boolean;
  onQuantity: (key: number, delta: number) => void;
  onSubmit: () => void;
}) {
  if (!cart.length) {
    return <Empty title="Your order is empty" hint="Choose a dish, select any options, then add it here." icon="receipt" />;
  }

  return (
    <div className="p-3">
      <ul className="flex flex-col gap-2">
        {cart.map((line) => (
          <li key={line.key} className="rounded-xl border border-rule bg-paper p-2.5">
            <div className="flex items-start gap-2">
              <span className="text-2xl" aria-hidden="true">{line.emoji || "🍽"}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-extrabold leading-tight text-ink">{line.name}</p>
                {line.modifiers.length > 0 && <p className="mt-0.5 text-[11px] text-ink-faint">{line.modifiers.map((modifier) => modifier.name).join(", ")}</p>}
                {line.note && <p className="mt-0.5 text-[11px] font-semibold italic text-ember-600">“{line.note}”</p>}
              </div>
              <span className="tnum shrink-0 text-[13px] font-black text-ink">
                {formatMoney((line.unitPrice + line.modifiers.reduce((sum, modifier) => sum + modifier.price, 0)) * line.quantity)}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-ink-faint">Quantity</span>
              <div className="flex items-center gap-2">
                <button type="button" aria-label={`Remove one ${line.name}`} onClick={() => onQuantity(line.key, -1)} className="btn btn-soft !size-8 !p-0">
                  <Icon name="minus" className="size-3.5" />
                </button>
                <span className="tnum w-5 text-center text-sm font-black">{line.quantity}</span>
                <button type="button" aria-label={`Add one ${line.name}`} onClick={() => onQuantity(line.key, 1)} className="btn btn-soft !size-8 !p-0">
                  <Icon name="plus" className="size-3.5" />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <dl className="tnum mt-4 space-y-1.5 border-t border-rule pt-3 text-xs">
        <MoneyLine label="Subtotal" value={pricing.subtotal} />
        <MoneyLine label="VAT" value={pricing.vat} />
        {pricing.serviceCharge > 0 && <MoneyLine label="Service charge" value={pricing.serviceCharge} />}
        <div className="flex items-baseline justify-between border-t border-rule pt-2 text-base">
          <dt className="font-black text-ink">Total</dt>
          <dd className="font-black text-brand-600">{formatMoney(pricing.total)}</dd>
        </div>
      </dl>
      <Button variant="primary" size="lg" className="mt-4 w-full" disabled={busy} onClick={onSubmit}>
        {busy ? <Spinner className="size-4" /> : <Icon name="kitchen" className="size-5" />}
        {busy ? "Sending…" : `Place order · ${formatMoney(pricing.total)}`}
      </Button>
      <p className="mt-2 text-center text-[11px] text-ink-faint">This sends your items to the kitchen immediately.</p>
    </div>
  );
}

function CurrentCheck({ order, onPay, onRefresh, refreshing }: { order: OrderSnapshot; onPay: () => void; onRefresh: () => void; refreshing: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const ready = order.allReady && order.activeItems.length > 0;
  const readyCount = order.activeItems.filter((line) => line.kdsStatus === "READY").length;

  return (
    <section className="card mb-5 overflow-hidden border-brand-200">
      <div className="flex flex-wrap items-center gap-3 bg-brand-50 px-4 py-3">
        <span className={`flex size-10 items-center justify-center rounded-full ${ready ? "bg-ok text-white" : "bg-brand-500 text-white"}`}>
          <Icon name={ready ? "check" : "kitchen"} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-black text-ink">{ready ? "Your food is ready at the pass" : "The kitchen has your order"}</h2>
          <p className="mt-0.5 text-xs text-ink-soft">Check #{order.checkNumber ?? "—"} · {readyCount}/{order.activeItems.length} items ready</p>
        </div>
        <button type="button" onClick={onRefresh} aria-label="Refresh order status" className="rounded-lg p-2 text-brand-600 hover:bg-brand-100">
          <Icon name="refresh" className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
        </button>
        <Button variant="primary" size="sm" onClick={onPay}>Pay · {formatMoney(order.total)}</Button>
      </div>

      <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-bold text-ink-soft">
        <span>{order.activeItems.length} line{order.activeItems.length === 1 ? "" : "s"} on this check</span>
        <span className="flex items-center gap-1">{expanded ? "Hide" : "View"} items <Icon name="chevronDown" className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} /></span>
      </button>
      {expanded && (
        <div className="border-t border-rule px-4 py-2">
          <ul className="divide-y divide-rule">
            {order.activeItems.map((line) => <GuestOrderLine key={line.id} line={line} />)}
          </ul>
          <dl className="tnum mt-2 space-y-1 border-t border-rule pt-2 text-xs">
            <MoneyLine label="Subtotal" value={order.subtotal} />
            <MoneyLine label="VAT" value={order.vat} />
            {order.serviceCharge > 0 && <MoneyLine label="Service charge" value={order.serviceCharge} />}
          </dl>
        </div>
      )}
    </section>
  );
}

function GuestOrderLine({ line }: { line: OrderLine }) {
  const label = line.kdsStatus === "READY" ? "Ready" : line.kdsStatus === "HOLD" ? "Queued" : "Cooking";
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="tnum text-xs font-black text-ink-faint">{line.quantity}×</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-bold text-ink">{line.name}</p>
        {line.modifiers.length > 0 && <p className="truncate text-[10px] text-ink-faint">{line.modifiers.map((modifier) => modifier.name).join(", ")}</p>}
      </div>
      <Chip tone={line.kdsStatus === "READY" ? "ok" : line.kdsStatus === "HOLD" ? "neutral" : "info"}>{label}</Chip>
      <span className="tnum w-20 text-right text-xs font-bold">{formatMoney(line.lineTotal)}</span>
    </li>
  );
}

interface DueResponse {
  due: number;
  subtotal?: number;
  vat?: number;
  serviceCharge?: number;
  tips: { percent: number; amount: number }[];
}

function PaymentSheet({
  open,
  onClose,
  token,
  order,
  paymentQr,
  tenders,
  demoMode,
  onPaid,
}: {
  open: boolean;
  onClose: () => void;
  token: string;
  order: OrderSnapshot;
  paymentQr: string;
  tenders: { id: TenderMethod; label: string; icon: string }[];
  demoMode: boolean;
  onPaid: (result: PaymentResult) => void;
}) {
  const [method, setMethod] = useState<TenderMethod>("wallet");
  const [tip, setTip] = useState(0);
  const [due, setDue] = useState<DueResponse | null>(null);
  const [busy, setBusy] = useState(false);

  // Load the server's current total every time the sheet opens. The kitchen or
  // cashier may have changed the ticket while the guest was browsing.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setMethod("wallet");
    setTip(0);
    setDue(null);
    void api.get<DueResponse>(`guest/${token}/due`)
      .then((result) => {
        if (live) setDue(result);
      })
      .catch((error) => toast(errorMessage(error), "late"));
    return () => {
      live = false;
    };
  }, [open, token, order.id]);

  return (
    <Modal open={open} onClose={onClose} title="Pay your check" subtitle={`Check #${order.checkNumber ?? "—"}`} width="max-w-xl">
      {!due ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-faint"><Spinner /> Calculating the latest total…</div>
      ) : (
        <>
          <div className="rounded-xl bg-brand-50 p-4 text-center">
            <p className="text-xs font-bold uppercase tracking-wide text-brand-700">Check total</p>
            <p className="tnum mt-1 text-3xl font-black text-brand-700">{formatMoney(due.due)}</p>
          </div>

          <div className="mt-4">
            <p className="label">Add a tip</p>
            <div className="grid grid-cols-4 gap-2">
              {[0, ...due.tips.map((entry) => entry.percent)].map((percent) => {
                const amount = percent === 0 ? 0 : due.tips.find((entry) => entry.percent === percent)?.amount ?? 0;
                return (
                  <button key={percent} type="button" onClick={() => setTip(amount)} className={`btn ${tip === amount ? "btn-primary" : "btn-soft"} !px-2`}>
                    {percent === 0 ? "None" : `${percent}%`}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-4">
            <p className="label">Payment method</p>
            <div className="grid grid-cols-2 gap-2">
              {tenders.map((tender) => (
                <button key={tender.id} type="button" onClick={() => setMethod(tender.id)} className={`btn ${method === tender.id ? "btn-primary" : "btn-soft"}`}>
                  <span aria-hidden="true">{tender.icon}</span>{tender.label}
                </button>
              ))}
            </div>
          </div>

          {paymentQr && ["wallet", "esewa", "khalti"].includes(method) && (
            <div className="mt-4 flex items-center gap-4 rounded-xl border border-rule p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={paymentQr} alt="Wallet payment QR" className="size-28 shrink-0" />
              <div>
                <p className="text-sm font-extrabold text-ink">Scan with your wallet</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-soft">The QR covers {formatMoney(due.due)}. Any tip selected here is recorded separately.</p>
              </div>
            </div>
          )}

          <p className={`mt-4 flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs leading-relaxed ${demoMode ? "bg-warn-soft text-warn" : "bg-info-soft text-info"}`}>
            <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
            {demoMode
              ? "Demo payment: no real money is collected and no bank transaction is verified."
              : "Confirm only after your wallet or card payment has succeeded. This screen does not independently verify the bank transaction."}
          </p>

          <Button
            variant="primary"
            size="lg"
            className="mt-4 w-full"
            disabled={busy || due.due <= 0}
            onClick={() => {
              setBusy(true);
              void api.post<PaymentResult>(`guest/${token}/pay`, { orderId: order.id, method, amount: due.due, tip })
                .then((result) => onPaid(result))
                .catch((error) => toast(errorMessage(error), "late"))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? <Spinner className="size-4" /> : <Icon name="wallet" className="size-5" />}
            {busy ? "Recording…" : `${demoMode ? "Record demo payment" : "Confirm payment"} · ${formatMoney(due.due + tip)}`}
          </Button>
        </>
      )}
    </Modal>
  );
}


function GuestReceipt({ data, result, onDone }: { data: GuestResponse; result: PaymentResult; onDone: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper p-4">
      <div className="card w-full max-w-md overflow-hidden">
        <div className="bg-brand-500 px-6 py-8 text-center text-white">
          <span className="mx-auto flex size-16 items-center justify-center rounded-full bg-white/20"><Icon name="check" className="size-9" /></span>
          <h1 className="mt-4 text-3xl font-black">Thank you</h1>
          <p className="mt-1 text-sm text-white/80">Your payment has been recorded at {data.restaurantName}.</p>
        </div>
        <div className="p-5">
          <div className="mb-4 flex items-center justify-between text-sm">
            <span className="font-bold text-ink">Check #{result.order.checkNumber ?? "—"}</span>
            <Chip tone="ok">Paid</Chip>
          </div>
          <dl className="tnum space-y-2 text-sm">
            {result.receipt.map((row, index) => (
              <div key={`${row.label}-${index}`} className={`flex justify-between gap-4 ${row.emphasis ? "border-t border-rule pt-2 text-base font-black text-ink" : "text-ink-soft"}`}>
                <dt>{row.label}</dt><dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 text-center text-xs leading-relaxed text-ink-faint">{data.settings.receiptFooter}</p>
          <Button variant="primary" size="lg" className="mt-5 w-full" onClick={onDone}>Back to the menu</Button>
        </div>
      </div>
    </main>
  );
}

function MoneyLine({ label, value }: { label: string; value: number }) {
  return <div className="flex justify-between gap-3"><dt className="text-ink-faint">{label}</dt><dd className="font-bold text-ink-soft">{formatMoney(value)}</dd></div>;
}
