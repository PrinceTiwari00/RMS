"use client";

/**
 * Screen 5 — Payment & Checkout.
 *
 * The till has to answer three questions at a glance: what is owed, what has
 * been taken, and what goes back to the guest. Everything else on this screen
 * supports those three numbers, so the tender stack is the primary surface and
 * the line list is context beside it.
 *
 * Split payment is modelled as a list of tenders rather than a special mode —
 * a guest paying half card, half eSewa is just two entries. Tips attach to a
 * tender, which is what makes card tip-adjust and the nightly payout possible.
 * Cash may over-tender (that is change); a card or wallet may not.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage, qs } from "@/lib/api";
import { usePoll, useStore } from "@/lib/store";
import { Button, Card, Chip, Empty, Icon, Modal, TextInput, toast } from "@/components/ui";
import { formatMoney, toPaisa, toRupees } from "@/domain/money";
import { summarizeTenders, TENDER_METHODS, type TenderMethod } from "@/domain/checkout";
import type { OrderSnapshot, OrderLine } from "@/types";

interface OrderResponse {
  order: OrderSnapshot;
  cashSuggestions: { label: string; amount: number }[];
  tipSuggestions: { percent: number; amount: number }[];
  tenders: { id: TenderMethod; label: string; icon: string }[];
}

interface SplitBucket {
  key: string;
  label: string;
  lines: { id: string; name: string; quantity: number; seat: number; amount: number }[];
  subtotal: number;
  vat: number;
  serviceCharge: number;
  discount: number;
  total: number;
}

interface Exposure {
  held: number;
  limit: number;
  available: number;
}

interface CloseResult {
  orderId: string;
  checkNumber: number | null;
  tableLabel: string;
  subtotal: number;
  discount: number;
  vat: number;
  serviceCharge: number;
  tip: number;
  total: number;
  grandTotal: number;
  changeDue: number;
  tenders: { id: string; method: string; amount: number; tip: number; label: string }[];
  stockMovements: number;
  closedAt: string;
  receipt: { label: string; value: string; emphasis?: boolean }[];
}

/** A tender being composed, before it is committed to the server. */
interface DraftTender {
  key: number;
  method: TenderMethod;
  /** rupees as typed, so the field stays editable mid-keystroke */
  amount: string;
  tip: string;
  label: string;
  authCode: string;
  last4: string;
}

const SPLIT_MODES = [
  { id: "none", label: "Single check", icon: "receipt" },
  { id: "even", label: "Split evenly", icon: "users" },
  { id: "seat", label: "By seat", icon: "table" },
  { id: "item", label: "By item", icon: "menu" },
] as const;

let draftSequence = 0;

export function CheckoutView({ orderId }: { orderId: string }) {
  const { allowed } = useStore();
  const router = useRouter();
  const canPay = allowed("pos.checkout");

  const { data } = usePoll<OrderResponse>(`orders/${orderId}`, { interval: 4000 });
  const [drafts, setDrafts] = useState<DraftTender[]>([]);
  const [splitMode, setSplitMode] = useState<(typeof SPLIT_MODES)[number]["id"]>("none");
  const [buckets, setBuckets] = useState<SplitBucket[]>([]);
  const [exposure, setExposure] = useState<Exposure | null>(null);
  const [qr, setQr] = useState<{ payload: string; dataUrl: string; due: number } | null>(null);
  const [closed, setClosed] = useState<CloseResult | null>(null);
  const [busy, setBusy] = useState(false);

  const order = data?.order;

  // The till's store-and-forward headroom, so an offline card auth can be warned about.
  useEffect(() => {
    if (!canPay) return;
    void api
      .get<Exposure>("payments/exposure")
      .then(setExposure)
      .catch(() => setExposure(null));
  }, [canPay]);

  // Live split preview — nothing is written, it just shows who owes what.
  useEffect(() => {
    if (splitMode === "none") {
      setBuckets([]);
      return;
    }
    let live = true;
    void api
      .get<{ buckets: SplitBucket[] }>(`orders/${orderId}/split?${qs({ mode: splitMode })}`)
      .then((response) => {
        if (live) setBuckets(response.buckets);
      })
      .catch(() => {
        if (live) setBuckets([]);
      });
    return () => {
      live = false;
    };
  }, [orderId, splitMode]);

  const due = order?.total ?? 0;

  /** Drafts converted to the paisa-denominated tenders the API expects. */
  const tenders = useMemo(
    () =>
      drafts
        .map((draft) => ({
          method: draft.method,
          amount: toPaisa(Number(draft.amount) || 0),
          tip: toPaisa(Number(draft.tip) || 0),
          label: draft.label.trim(),
          authCode: draft.authCode.trim() || undefined,
          last4: draft.last4.trim() || undefined,
        }))
        .filter((tender) => tender.amount > 0 || tender.method === "comp"),
    [drafts],
  );

  const summary = useMemo(() => summarizeTenders(due, tenders), [due, tenders]);
  const remaining = Math.max(0, summary.remaining);

  const addDraft = useCallback(
    (method: TenderMethod) => {
      setDrafts((current) => [
        ...current,
        {
          key: ++draftSequence,
          method,
          // Pre-fill whatever is still outstanding — the common case is one tender.
          amount: method === "comp" ? "0" : toRupees(remaining).toFixed(2),
          tip: "0",
          label: "",
          authCode: "",
          last4: "",
        },
      ]);
    },
    [remaining],
  );

  const patchDraft = useCallback((key: number, patch: Partial<DraftTender>) => {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  }, []);

  const removeDraft = useCallback((key: number) => {
    setDrafts((current) => current.filter((draft) => draft.key !== key));
  }, []);

  const loadQr = useCallback(async () => {
    try {
      setQr(await api.get<{ payload: string; dataUrl: string; due: number }>(`orders/${orderId}/payment-qr`));
    } catch (error) {
      toast(errorMessage(error), "late");
    }
  }, [orderId]);

  const close = useCallback(
    async (force: boolean) => {
      if (!order) return;
      setBusy(true);
      try {
        const result = await api.post<CloseResult>(`orders/${orderId}/close`, { tenders, force, note: "" });
        setClosed(result);
        toast(`Check closed · change ${formatMoney(result.changeDue)}`, "ok");
      } catch (error) {
        toast(errorMessage(error), "late");
      } finally {
        setBusy(false);
      }
    },
    [order, orderId, tenders],
  );

  if (closed) return <Receipt result={closed} onDone={() => router.push("/pos")} onFloor={() => router.push("/floor")} />;

  if (!data || !order) {
    return (
      <div className="p-6">
        <Empty title="Loading the check…" icon="cash" />
      </div>
    );
  }

  const needsForce = order.sentAt !== null && !order.allReady;
  const shortTender = summary.remaining > 0;
  const overNonCash =
    summary.overTendered && !tenders.some((tender) => tender.method === "cash") && tenders.length > 0;

  return (
    <div className="grid min-h-[calc(100vh-49px)] grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_440px]">
      {/* ------------------------------------------------------------- check side */}
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => router.push("/pos")}>
            <Icon name="chevronLeft" className="size-4" />
            Back to POS
          </Button>
          <h1 className="text-[17px] font-extrabold text-ink">
            {order.tableLabel ? `Table ${order.tableLabel}` : order.guestName || "Ticket"}
          </h1>
          <Chip tone="neutral">Check #{order.checkNumber ?? "—"}</Chip>
          <Chip tone={order.status === "closed" ? "ok" : order.allReady ? "info" : "warn"}>
            {order.status === "sent" ? (order.allReady ? "All ready" : "In the kitchen") : order.status}
          </Chip>
          {order.guests > 0 && <Chip tone="neutral">{order.guests} guests</Chip>}
        </div>

        {needsForce && (
          <div className="flex items-start gap-2 rounded-xl border border-late/35 bg-late-soft px-3 py-2.5 text-[12px] text-late">
            <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>Not every item is ready.</strong> Closing now needs a manager override, and the kitchen will keep
              cooking anything still on the rail.
            </span>
          </div>
        )}

        <Card title="Items on this check" icon="menu" className="flex-1">
          <div className="divide-y divide-rule">
            {order.activeItems.length === 0 && <Empty title="No items on this ticket" icon="menu" />}
            {order.activeItems.map((line) => (
              <LineRow key={line.id} line={line} />
            ))}
          </div>

          {order.discounts.length > 0 && (
            <div className="mt-3 border-t border-rule pt-2">
              {order.discounts.map((discount) => (
                <p key={discount.id} className="flex justify-between text-[12px] text-ink-soft">
                  <span>
                    Discount · {discount.reason} · {discount.approvedBy}
                  </span>
                  <span className="tnum font-bold text-late">− {formatMoney(discount.amount)}</span>
                </p>
              ))}
            </div>
          )}
        </Card>

        {/* Split preview */}
        {canPay && allowed("pos.split") && (
          <Card title="Split the check" icon="users">
            <div className="mb-3 flex flex-wrap gap-1.5">
              {SPLIT_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setSplitMode(mode.id)}
                  className={`btn !py-1.5 !text-xs ${splitMode === mode.id ? "btn-primary" : "btn-ghost"}`}
                >
                  <Icon name={mode.icon} className="size-3.5" />
                  {mode.label}
                </button>
              ))}
            </div>

            {buckets.length === 0 ? (
              <p className="text-[12px] text-ink-faint">
                One payment for the whole table. Choose a split to see what each guest owes — VAT and service charge are
                shared out proportionally, never duplicated.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {buckets.map((bucket, index) => (
                  <div key={bucket.key} className="rounded-xl border border-rule bg-paper px-3 py-2">
                    <p className="flex items-baseline justify-between gap-2 text-[13px] font-extrabold text-ink">
                      <span>{bucket.label || `Guest ${index + 1}`}</span>
                      <span className="tnum">{formatMoney(bucket.total)}</span>
                    </p>
                    <p className="tnum text-[11px] text-ink-faint">
                      {bucket.lines.length} item{bucket.lines.length === 1 ? "" : "s"} · VAT{" "}
                      {formatMoney(bucket.vat)}
                      {bucket.serviceCharge > 0 && ` · SC ${formatMoney(bucket.serviceCharge)}`}
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {bucket.lines.slice(0, 4).map((line) => (
                        <li key={line.id} className="flex justify-between gap-2 text-[11px] text-ink-soft">
                          <span className="truncate">
                            {line.quantity > 1 ? `${line.quantity}× ` : ""}
                            {line.name}
                          </span>
                          <span className="tnum shrink-0">{formatMoney(line.amount)}</span>
                        </li>
                      ))}
                      {bucket.lines.length > 4 && (
                        <li className="text-[11px] text-ink-faint">+ {bucket.lines.length - 4} more</li>
                      )}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>

      {/* ------------------------------------------------------------ tender side */}
      <div className="flex flex-col gap-3">
        <Card title="Amount due" icon="cash" accent="var(--color-brand-500)">
          <p className="tnum text-4xl font-black tracking-tight text-ink">{formatMoney(due)}</p>
          <dl className="mt-2 space-y-1 text-[12px]">
            <MoneyRow label="Subtotal" value={order.subtotal} />
            {order.discount > 0 && <MoneyRow label="Discount" value={-order.discount} tone="var(--color-late)" />}
            <MoneyRow label="VAT" value={order.vat} />
            {order.serviceCharge > 0 && <MoneyRow label="Service charge" value={order.serviceCharge} />}
            {order.tip > 0 && <MoneyRow label="Tip already recorded" value={order.tip} tone="var(--color-ok)" />}
            <div className="!mt-2 border-t border-rule pt-1.5">
              <MoneyRow label="Total" value={order.total} strong />
            </div>
          </dl>
        </Card>

        {!canPay && (
          <Card>
            <Empty title="You cannot take payment" hint="Ask a cashier or manager to close this check." icon="lock" />
          </Card>
        )}

        {canPay && (
          <>
            <Card title="Tenders" icon="cash" action={<span className="tnum text-xs text-ink-faint">{tenders.length} entered</span>}>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {TENDER_METHODS.map((method) => (
                  <button key={method.id} type="button" onClick={() => addDraft(method.id)} className="btn btn-soft !py-1.5 !text-xs">
                    <span aria-hidden="true">{method.icon}</span>
                    {method.label}
                  </button>
                ))}
              </div>

              {drafts.length === 0 ? (
                <p className="rounded-lg border border-dashed border-rule px-3 py-4 text-center text-[12px] text-ink-faint">
                  Pick a payment method to begin. Split payment is just more than one tender.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {drafts.map((draft) => (
                    <TenderCard
                      key={draft.key}
                      draft={draft}
                      suggestions={draft.method === "cash" ? (data.cashSuggestions ?? []) : []}
                      tips={data.tipSuggestions ?? []}
                      remaining={remaining}
                      exposure={exposure}
                      onPatch={(patch) => patchDraft(draft.key, patch)}
                      onRemove={() => removeDraft(draft.key)}
                    />
                  ))}
                </div>
              )}
            </Card>

            {/* Running totals for the tender stack */}
            <Card>
              <dl className="space-y-1.5 text-[13px]">
                <div className="flex justify-between">
                  <dt className="text-ink-soft">Applied</dt>
                  <dd className="tnum font-extrabold text-ink">{formatMoney(summary.applied)}</dd>
                </div>
                {summary.tips > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-ink-soft">Tips</dt>
                    <dd className="tnum font-bold text-ok">{formatMoney(summary.tips)}</dd>
                  </div>
                )}
                {remaining > 0 && (
                  <div className="flex justify-between">
                    <dt className="font-bold text-late">Still owed</dt>
                    <dd className="tnum font-black text-late">{formatMoney(remaining)}</dd>
                  </div>
                )}
                {summary.changeDue > 0 && (
                  <div className="flex justify-between rounded-lg bg-ok-soft px-2 py-1.5">
                    <dt className="font-extrabold text-ok">Change to guest</dt>
                    <dd className="tnum text-lg font-black text-ok">{formatMoney(summary.changeDue)}</dd>
                  </div>
                )}
                {remaining === 0 && summary.changeDue === 0 && tenders.length > 0 && (
                  <div className="flex items-center gap-2 rounded-lg bg-ok-soft px-2.5 py-2 text-[13px] font-extrabold text-ok">
                    <Icon name="check" className="size-4" />
                    Paid exactly
                  </div>
                )}
              </dl>

              {overNonCash && (
                <p className="mt-2 flex items-start gap-2 rounded-lg bg-late-soft px-2.5 py-2 text-[11px] font-semibold text-late">
                  <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
                  A card or wallet tender cannot exceed the amount due. Only cash gives change.
                </p>
              )}
              {shortTender && tenders.length > 0 && (
                <p className="mt-2 text-[11px] text-ink-faint">
                  Short by {formatMoney(remaining)} — add another tender to finish the split.
                </p>
              )}

              <div className="mt-3 flex flex-col gap-2">
                <Button
                  variant="primary"
                  size="lg"
                  className="w-full"
                  disabled={busy || shortTender || overNonCash || tenders.length === 0}
                  onClick={() => void close(false)}
                >
                  <Icon name="cash" className="size-4" />
                  {summary.changeDue > 0
                    ? `Close & give ${formatMoney(summary.changeDue)} change`
                    : `Close check · ${formatMoney(summary.applied)}`}
                </Button>

                {needsForce && (
                  <Button
                    variant="danger"
                    className="w-full"
                    disabled={busy || shortTender || overNonCash || tenders.length === 0}
                    onClick={() => void close(true)}
                  >
                    <Icon name="alert" className="size-4" />
                    Force close (manager override)
                  </Button>
                )}

                <Button variant="soft" className="w-full" onClick={() => void loadQr()}>
                  <Icon name="qr" className="size-4" />
                  Show wallet QR for the balance
                </Button>
              </div>

              {exposure && exposure.held > 0 && (
                <p className="mt-2 text-[11px] text-ink-faint">
                  Store-and-forward: {formatMoney(exposure.held)} held of a {formatMoney(exposure.limit)} cap ·{" "}
                  {formatMoney(exposure.available)} available.
                </p>
              )}
            </Card>
          </>
        )}
      </div>

      <Modal open={Boolean(qr)} onClose={() => setQr(null)} title="Scan to pay" width="max-w-sm">
        {qr && (
          <div className="flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr.dataUrl} alt="EMV payment QR code" className="size-64 rounded-xl border border-rule" />
            <p className="tnum text-2xl font-black text-ink">{formatMoney(qr.due)}</p>
            <p className="text-center text-[12px] text-ink-faint">
              Dynamic EMVCo merchant-presented code for the outstanding balance. Any compliant wallet or banking app in
              Nepal can read it.
            </p>
            <code className="max-h-16 w-full overflow-auto rounded-lg bg-paper-sunken p-2 text-[10px] break-all text-ink-soft">
              {qr.payload}
            </code>
            <Button variant="primary" className="w-full" onClick={() => addDraft("wallet")}>
              Record as a wallet tender
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}

function LineRow({ line }: { line: OrderLine }) {
  return (
    <div className="flex items-start gap-3 py-2">
      {line.seat > 0 && (
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-paper-sunken text-[11px] font-black text-ink-soft">
          {line.seat}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-bold text-ink">
          {line.quantity > 1 && <span className="tnum text-ink-faint">{line.quantity}× </span>}
          {line.name}
        </p>
        {line.modifiers.map((modifier) => (
          <p key={modifier.id} className="truncate text-[11px] text-ink-faint">
            {modifier.groupName}: {modifier.name}
          </p>
        ))}
        {line.note && <p className="truncate text-[11px] italic text-ink-faint">“{line.note}”</p>}
      </div>
      <span className="tnum shrink-0 text-[13px] font-extrabold text-ink">{formatMoney(line.lineTotal)}</span>
    </div>
  );
}

function MoneyRow({ label, value, tone, strong }: { label: string; value: number; tone?: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className={strong ? "font-extrabold text-ink" : "text-ink-soft"}>{label}</dt>
      <dd
        className={`tnum ${strong ? "text-base font-black text-ink" : "font-semibold"}`}
        style={{ color: tone ?? "var(--color-ink-soft)" }}
      >
        {value < 0 ? "− " : ""}
        {formatMoney(Math.abs(value))}
      </dd>
    </div>
  );
}

function TenderCard({
  draft,
  suggestions,
  tips,
  remaining,
  exposure,
  onPatch,
  onRemove,
}: {
  draft: DraftTender;
  suggestions: { label: string; amount: number }[];
  tips: { percent: number; amount: number }[];
  remaining: number;
  exposure: Exposure | null;
  onPatch: (patch: Partial<DraftTender>) => void;
  onRemove: () => void;
}) {
  const method = TENDER_METHODS.find((entry) => entry.id === draft.method);
  const amountPaisa = toPaisa(Number(draft.amount) || 0);
  const isCash = draft.method === "cash";
  const isCard = draft.method === "card";
  const isWallet = draft.method === "wallet" || draft.method === "esewa" || draft.method === "khalti";
  const exceedsAvailable = isCard && exposure !== null && amountPaisa > exposure.available;

  return (
    <div className="rounded-xl border border-rule bg-paper px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[15px]" aria-hidden="true">
          {method?.icon}
        </span>
        <span className="text-[13px] font-extrabold text-ink">{method?.label ?? draft.method}</span>
        <span className="tnum ml-auto text-[13px] font-black text-ink">{formatMoney(amountPaisa)}</span>
        <button type="button" onClick={onRemove} className="text-ink-faint transition-colors hover:text-late" title="Remove tender">
          <Icon name="trash" className="size-4" />
        </button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="label">Amount (Rs)</span>
          <TextInput
            type="number"
            step="0.01"
            min="0"
            value={draft.amount}
            onChange={(value) => onPatch({ amount: value })}
            className="tnum"
          />
        </label>
        <label className="block">
          <span className="label">Tip (Rs)</span>
          <TextInput
            type="number"
            step="1"
            min="0"
            value={draft.tip}
            onChange={(value) => onPatch({ tip: value })}
            className="tnum"
            placeholder="0"
          />
        </label>
      </div>

      {isCash && suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.amount}
              type="button"
              onClick={() => onPatch({ amount: toRupees(suggestion.amount).toFixed(2) })}
              className="btn btn-soft !px-2 !py-1 !text-[11px]"
            >
              {suggestion.label}
            </button>
          ))}
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => onPatch({ amount: toRupees(remaining).toFixed(2) })}
              className="btn btn-ghost !px-2 !py-1 !text-[11px]"
            >
              Balance {formatMoney(remaining)}
            </button>
          )}
        </div>
      )}

      {tips.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">Tip</span>
          {tips.map((tip) => (
            <button
              key={tip.percent}
              type="button"
              onClick={() => onPatch({ tip: toRupees(tip.amount).toFixed(0) })}
              className={`btn !px-2 !py-1 !text-[11px] ${toPaisa(Number(draft.tip) || 0) === tip.amount ? "btn-primary" : "btn-ghost"}`}
            >
              {tip.percent}% · {formatMoney(tip.amount)}
            </button>
          ))}
        </div>
      )}

      {(isCard || isWallet) && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="label">{isWallet ? "Wallet / txn ref" : "Auth code"}</span>
            <TextInput
              value={draft.authCode}
              onChange={(value) => onPatch({ authCode: value })}
              placeholder={isWallet ? "e.g. ES12345" : "6 digits"}
              className="tnum"
            />
          </label>
          {isCard && (
            <label className="block">
              <span className="label">Card last 4</span>
              <TextInput
                value={draft.last4}
                onChange={(value) => onPatch({ last4: value.replace(/\D/g, "").slice(0, 4) })}
                placeholder="4242"
                className="tnum"
                inputMode="numeric"
              />
            </label>
          )}
        </div>
      )}

      {draft.method === "comp" && (
        <label className="mt-2 block">
          <span className="label">Reason (audited)</span>
          <TextInput value={draft.label} onChange={(value) => onPatch({ label: value })} placeholder="Manager comp — wrong order" />
        </label>
      )}

      {exceedsAvailable && (
        <p className="mt-2 flex items-start gap-2 rounded-lg bg-warn-soft px-2 py-1.5 text-[11px] font-semibold text-warn">
          <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
          Exceeds the store-and-forward cap of {formatMoney(exposure?.available ?? 0)}. Take cash or split it.
        </p>
      )}
    </div>
  );
}

/** The closed-check confirmation: what was taken, the change, and the receipt. */
function Receipt({ result, onDone, onFloor }: { result: CloseResult; onDone: () => void; onFloor: () => void }) {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-49px)] w-full max-w-md flex-col gap-3 p-4">
      <div className="card flex flex-col items-center gap-2 py-6 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-ok-soft text-ok">
          <Icon name="check" className="size-7" />
        </span>
        <h1 className="text-xl font-extrabold text-ink">Check closed</h1>
        <p className="text-[13px] text-ink-soft">
          {result.tableLabel ? `Table ${result.tableLabel}` : "Ticket"} · Check #{result.checkNumber ?? "—"}
        </p>

        {result.changeDue > 0 && (
          <div className="mt-2 w-full rounded-xl bg-ok-soft px-4 py-3">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ok">Give change</p>
            <p className="tnum text-3xl font-black text-ok">{formatMoney(result.changeDue)}</p>
          </div>
        )}

        <dl className="mt-2 w-full space-y-1 text-left text-[12px]">
          <div className="flex justify-between">
            <dt className="text-ink-soft">Subtotal</dt>
            <dd className="tnum font-semibold">{formatMoney(result.subtotal)}</dd>
          </div>
          {result.discount > 0 && (
            <div className="flex justify-between">
              <dt className="text-ink-soft">Discount</dt>
              <dd className="tnum font-semibold text-late">− {formatMoney(result.discount)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-ink-soft">VAT</dt>
            <dd className="tnum font-semibold">{formatMoney(result.vat)}</dd>
          </div>
          {result.serviceCharge > 0 && (
            <div className="flex justify-between">
              <dt className="text-ink-soft">Service charge</dt>
              <dd className="tnum font-semibold">{formatMoney(result.serviceCharge)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t border-rule pt-1">
            <dt className="font-extrabold text-ink">Total</dt>
            <dd className="tnum text-base font-black text-ink">{formatMoney(result.total)}</dd>
          </div>
          {result.tip > 0 && (
            <div className="flex justify-between">
              <dt className="text-ink-soft">Tip</dt>
              <dd className="tnum font-bold text-ok">{formatMoney(result.tip)}</dd>
            </div>
          )}
          {result.grandTotal !== result.total && (
            <div className="flex justify-between">
              <dt className="font-extrabold text-ink">Grand total</dt>
              <dd className="tnum font-black text-ink">{formatMoney(result.grandTotal)}</dd>
            </div>
          )}
        </dl>

        <div className="mt-2 w-full space-y-1 border-t border-rule pt-2 text-left">
          {result.tenders.map((tender) => (
            <p key={tender.id} className="flex justify-between text-[12px]">
              <span className="text-ink-soft">
                {tender.method}
                {tender.label ? ` · ${tender.label}` : ""}
                {tender.tip ? ` (+${formatMoney(tender.tip)} tip)` : ""}
              </span>
              <span className="tnum font-bold text-ink">{formatMoney(tender.amount)}</span>
            </p>
          ))}
        </div>

        <p className="mt-2 text-[11px] text-ink-faint">
          {result.stockMovements} stock movement{result.stockMovements === 1 ? "" : "s"} posted to the inventory ledger.
        </p>
      </div>

      <Card title="Receipt" icon="receipt" className="scroll-y max-h-[320px]">
        <div className="font-mono text-[11px] leading-relaxed text-ink-soft">
          {result.receipt.map((line, index) => (
            <p
              key={`${line.label}-${index}`}
              className={`flex justify-between gap-3 ${line.emphasis ? "font-bold text-ink" : ""}`}
            >
              <span className="whitespace-pre-wrap">{line.label}</span>
              <span className="tnum shrink-0">{line.value}</span>
            </p>
          ))}
        </div>
      </Card>

      <div className="flex gap-2">
        <Button variant="primary" size="lg" className="flex-1" onClick={onDone}>
          <Icon name="pos" className="size-4" />
          New ticket
        </Button>
        <Button variant="soft" size="lg" onClick={onFloor}>
          <Icon name="floor" className="size-4" />
          Floor
        </Button>
      </div>
    </div>
  );
}
