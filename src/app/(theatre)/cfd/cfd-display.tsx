"use client";

/**
 * Customer Facing Display — a read-only, live view of the ticket on the till.
 *
 * The typography is deliberately much larger than the POS: this screen sits
 * across the counter, not in the cashier's hands. There are no order controls
 * here; payment is still confirmed by staff after the guest scans the QR.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePoll } from "@/lib/store";
import { qs } from "@/lib/api";
import { formatMoney } from "@/domain/money";
import { Icon, Spinner } from "@/components/ui";
import type { CfdView, OrderLine } from "@/types";

interface CfdResponse extends CfdView {
  paymentQr: string;
}

const TERMINALS = [
  { id: "term-pos-1", label: "Register 1" },
  { id: "term-pos-2", label: "Register 2" },
];

export function CfdDisplay() {
  const search = useSearchParams();
  const [terminal, setTerminal] = useState(() => search.get("terminal") || "term-pos-1");
  const { data, error, pending } = usePoll<CfdResponse>(`cfd${qs({ terminal })}`, { interval: 1800 });

  if (pending && !data) {
    return (
      <div className="stage flex min-h-screen items-center justify-center gap-3 text-stage-soft">
        <Spinner className="size-7" />
        <span className="text-lg font-bold">Connecting to the till…</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="stage flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <Icon name="display" className="size-14 text-stage-soft" />
        <h1 className="text-3xl font-black">Customer display unavailable</h1>
        <p className="max-w-lg text-stage-soft">{error || "The till did not respond."}</p>
      </div>
    );
  }

  const order = data.order;

  return (
    <div className="stage flex min-h-screen flex-col">
      <header className="flex min-h-[92px] flex-wrap items-center gap-4 border-b border-stage-rule bg-stage-raised px-5 py-3">
        <span className="flex size-14 items-center justify-center overflow-hidden rounded-2xl bg-brand-500 text-xl font-black text-white">
          {data.settings.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={data.settings.logoDataUrl} alt={`${data.restaurantName} logo`} className="size-full bg-white object-contain" />
          ) : data.restaurantName.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-black tracking-tight">{data.restaurantName}</h1>
          <p className="truncate text-sm text-stage-soft">{data.tagline}</p>
        </div>

        <div className="flex items-center gap-2" aria-label="Till terminal">
          {TERMINALS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTerminal(entry.id)}
              className={`rounded-lg border px-3 py-2 text-xs font-bold transition-colors ${
                terminal === entry.id
                  ? "border-brand-400 bg-brand-500 text-white"
                  : "border-stage-rule bg-stage-card text-stage-soft hover:text-stage-ink"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <span className="flex items-center gap-2 rounded-full border border-ok/40 bg-ok/10 px-3 py-1.5 text-xs font-black uppercase tracking-wide text-ok">
          <span className="size-2 animate-pulse rounded-full bg-ok" />
          Live
        </span>
      </header>

      {error && (
        <p className="border-b border-warn/30 bg-warn/10 px-5 py-2 text-center text-sm font-semibold text-warn" role="status">
          {error} — showing the last update.
        </p>
      )}

      {!order ? (
        <Welcome data={data} />
      ) : (
        <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.75fr)]">
          <section className="flex min-w-0 flex-col p-5 lg:p-7">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-sm font-bold uppercase tracking-[0.12em] text-stage-soft">Your order</p>
                <h2 className="mt-1 text-4xl font-black tracking-tight">
                  {order.tableLabel || order.guestName || "Takeout"}
                  <span className="tnum ml-3 text-2xl text-stage-soft">#{order.checkNumber ?? "—"}</span>
                </h2>
              </div>
              <div className="text-right">
                <p className="text-sm text-stage-soft">Served by {data.cashierName}</p>
                <p className="mt-1 text-sm font-bold text-brand-300">
                  {order.status === "open" ? "Being entered" : order.allReady ? "Ready at the pass" : "With the kitchen"}
                </p>
              </div>
            </div>

            <div className="stage-card flex-1 overflow-hidden">
              <ul className="divide-y divide-stage-rule">
                {order.activeItems.length === 0 && (
                  <li className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center text-stage-soft">
                    <Icon name="menu" className="size-12" />
                    <p className="text-xl font-bold">Your items will appear here</p>
                  </li>
                )}
                {order.activeItems.map((line) => (
                  <DisplayLine key={line.id} line={line} />
                ))}
              </ul>
            </div>
            <p className="mt-4 text-center text-sm text-stage-soft">Please check your order. Let your cashier know if anything needs changing.</p>
          </section>

          <aside className="flex flex-col border-t border-stage-rule bg-stage-raised p-5 lg:border-l lg:border-t-0 lg:p-7">
            <div className="stage-card p-5">
              <p className="text-sm font-bold uppercase tracking-[0.12em] text-stage-soft">Amount due</p>
              <p className="tnum mt-2 text-5xl font-black tracking-tight text-brand-300 xl:text-6xl">{formatMoney(order.total)}</p>
              <dl className="tnum mt-5 space-y-2 border-t border-stage-rule pt-4 text-sm">
                <TotalRow label="Subtotal" value={order.subtotal} />
                {order.discount > 0 && <TotalRow label="Discount" value={-order.discount} />}
                <TotalRow label={`VAT ${data.settings.vatRate}%`} value={order.vat} />
                {order.serviceCharge > 0 && <TotalRow label="Service charge" value={order.serviceCharge} />}
                {order.tip > 0 && <TotalRow label="Tip" value={order.tip} />}
              </dl>
            </div>

            {data.paymentQr && (
              <div className="mt-5 flex flex-1 flex-col items-center justify-center rounded-2xl bg-white p-5 text-center text-ink">
                {/* Data URI generated locally by the API; no remote image host is needed. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={data.paymentQr} alt={`Wallet payment QR for ${formatMoney(order.total)}`} className="w-full max-w-[260px]" />
                <p className="mt-3 flex items-center gap-2 text-lg font-black">
                  <Icon name="qr" className="size-6" />
                  Scan to pay
                </p>
                <p className="tnum mt-1 text-2xl font-black text-brand-600">{formatMoney(order.total)}</p>
                <p className="mt-2 max-w-xs text-xs leading-relaxed text-ink-soft">Use your mobile wallet, then ask the cashier to confirm your payment.</p>
              </div>
            )}
          </aside>
        </main>
      )}
    </div>
  );
}

function Welcome({ data }: { data: CfdResponse }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-brand-300">Welcome</p>
      <h2 className="mt-3 max-w-4xl text-5xl font-black tracking-tight md:text-6xl">Good food. Warm Terai hospitality.</h2>
      <p className="mt-4 max-w-xl text-lg text-stage-soft">Your order will appear here as soon as the cashier starts your ticket.</p>

      {data.promotions.length > 0 && (
        <section className="mt-10 w-full max-w-6xl" aria-label="Featured dishes">
          <p className="mb-4 text-left text-sm font-black uppercase tracking-[0.12em] text-stage-soft">From our kitchen</p>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {data.promotions.map((promotion) => (
              <article key={promotion.name} className="stage-card p-5 text-left">
                <span className="text-5xl" aria-hidden="true">{promotion.emoji || "🍽"}</span>
                <h3 className="mt-4 text-xl font-black">{promotion.name}</h3>
                <p className="mt-1 line-clamp-2 min-h-10 text-sm text-stage-soft">{promotion.description}</p>
                <p className="tnum mt-4 text-2xl font-black text-brand-300">{formatMoney(promotion.price)}</p>
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function DisplayLine({ line }: { line: OrderLine }) {
  return (
    <li className="flex items-start gap-4 px-5 py-4">
      <span className="tnum flex size-11 shrink-0 items-center justify-center rounded-xl bg-stage-raised text-xl font-black text-brand-300">
        {line.quantity}×
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xl font-extrabold leading-tight">{line.name}</p>
        {line.modifiers.length > 0 && <p className="mt-1 text-sm text-stage-soft">{line.modifiers.map((modifier) => modifier.name).join(" · ")}</p>}
        {line.note && <p className="mt-1 text-sm font-semibold italic text-warn">“{line.note}”</p>}
      </div>
      <span className="tnum shrink-0 text-xl font-black">{formatMoney(line.lineTotal)}</span>
    </li>
  );
}

function TotalRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-stage-soft">{label}</dt>
      <dd className="font-bold">{value < 0 ? "− " : ""}{formatMoney(Math.abs(value))}</dd>
    </div>
  );
}
