"use client";

import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Button, Chip, Icon, Modal, Spinner, TextInput, toast } from "@/components/ui";
import { formatMoney } from "@/domain/money";
import type { TenderMethod } from "@/domain/checkout";
import type { GuestOrderView, GuestReviewInfo, OrderSnapshot, TableGuest, TableSessionInfo } from "@/types";

export interface GuestPayResult {
  order: OrderSnapshot;
  paidInFull: boolean;
  paidAmount: number;
  remainingDue: number;
  pointsEarned: number;
  emailSent: { recipientEmail: string; status: string } | null;
  receipt: { label: string; value: string; emphasis?: boolean }[];
}

interface DueResponse {
  due: number;
  total: number;
  paidAmount: number;
  subtotal?: number;
  vat?: number;
  serviceCharge?: number;
  tips: { percent: number; amount: number }[];
}

export function GuestPaymentModal({
  open,
  onClose,
  token,
  tableLabel,
  order,
  session,
  currentGuest,
  paymentQr,
  tenders,
  demoMode,
  onPaid,
}: {
  open: boolean;
  onClose: () => void;
  token: string;
  tableLabel: string;
  order: OrderSnapshot;
  session: TableSessionInfo | null;
  currentGuest: TableGuest | null;
  paymentQr: string;
  tenders: { id: TenderMethod; label: string; icon: string }[];
  demoMode: boolean;
  onPaid: (result: GuestPayResult) => void;
}) {
  const [method, setMethod] = useState<TenderMethod>("wallet");
  const [tipPercent, setTipPercent] = useState(0);
  const [splitWays, setSplitWays] = useState(1);
  const [payMode, setPayMode] = useState<"share" | "full">("share");
  const [email, setEmail] = useState("");
  const [due, setDue] = useState<DueResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setMethod("wallet");
    setTipPercent(0);
    const defaultWays = Math.min(4, Math.max(1, session?.guests.length ?? 1));
    setSplitWays(defaultWays);
    setPayMode("share");
    setDue(null);
    void api
      .get<DueResponse>(`guest/${token}/due`)
      .then((result) => {
        if (live) setDue(result);
      })
      .catch((error) => toast(errorMessage(error), "late"));
    return () => {
      live = false;
    };
  }, [open, token, order.id, session?.guests.length]);

  const tipPresets = useMemo(() => [0, 5, 10, 15], []);

  const remainingDue = due?.due ?? 0;
  const totalBill = due?.total ?? order.total;
  const baseShare = splitWays > 1 ? Math.ceil(remainingDue / splitWays) : remainingDue;
  const payBase = payMode === "full" || splitWays === 1 ? remainingDue : Math.min(remainingDue, baseShare);
  const tipAmount = Math.round((payBase * tipPercent) / 100);
  const totalWithTip = payBase + tipAmount;

  const shareCards = useMemo(() => {
    const people = session?.guests ?? [];
    const totalRemainingWithTip = remainingDue + Math.round((remainingDue * tipPercent) / 100);
    return Array.from({ length: splitWays }, (_, idx) => {
      const guest = people[idx];
      const base = Math.floor(totalRemainingWithTip / splitWays);
      const rem = idx === splitWays - 1 ? totalRemainingWithTip - base * splitWays : 0;
      return {
        key: guest?.id ?? `guest-${idx}`,
        initials: guest?.initials ?? `G${idx + 1}`,
        name: guest?.name ?? `Guest ${idx + 1}`,
        color: guest?.color ?? ["#e85a2a", "#3d6ea8", "#0f6f66", "#8a5aa8"][idx % 4],
        share: base + rem,
      };
    });
  }, [session?.guests, splitWays, remainingDue, tipPercent]);

  return (
    <Modal open={open} onClose={onClose} title="Your bill" subtitle={`${tableLabel} · Check #${order.checkNumber ?? "—"}`} width="max-w-xl">
      {!due ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-faint">
          <Spinner /> Calculating the latest bill…
        </div>
      ) : (
        <div className="space-y-4">
          {/* Itemized Bill */}
          <div className="rounded-xl border border-rule bg-paper p-3">
            <ul className="max-h-40 space-y-1.5 overflow-y-auto text-xs">
              {order.activeItems.map((line) => (
                <li key={line.id} className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold text-ink">
                    {line.name} {line.quantity > 1 ? `×${line.quantity}` : ""}
                  </span>
                  <span className="tnum shrink-0 font-bold text-ink">{formatMoney(line.lineTotal)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-2.5 flex items-baseline justify-between border-t border-rule pt-2">
              <span className="text-xs font-bold text-ink-soft">
                {due.paidAmount > 0 ? `Remaining (${formatMoney(due.paidAmount)} already paid)` : "Total"}
              </span>
              <span className="tnum text-xl font-black text-ink">{formatMoney(remainingDue)}</span>
            </div>
          </div>

          {/* Equal Split Selector */}
          <div>
            <p className="label">SPLIT</p>
            <div className="grid grid-cols-4 gap-2">
              {[1, 2, 3, 4].map((ways) => (
                <button
                  key={ways}
                  type="button"
                  onClick={() => setSplitWays(ways)}
                  className={`btn !px-2 !text-xs ${splitWays === ways ? "btn-primary" : "btn-soft"}`}
                >
                  {ways === 1 ? "1" : `${ways} ways`}
                </button>
              ))}
            </div>
            {splitWays > 1 && (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {shareCards.map((card) => (
                  <div key={card.key} className="rounded-xl border border-rule bg-paper-raised p-2.5 text-center">
                    <span
                      className="mx-auto flex size-7 items-center justify-center rounded-full text-[11px] font-black text-white"
                      style={{ background: card.color }}
                    >
                      {card.initials}
                    </span>
                    <p className="mt-1 truncate text-[10px] font-bold uppercase tracking-wider text-ink-faint">{card.name}</p>
                    <p className="tnum text-sm font-black text-ink">{formatMoney(card.share)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {splitWays > 1 && (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setPayMode("share")}
                className={`btn !text-xs ${payMode === "share" ? "btn-primary" : "btn-soft"}`}
              >
                Pay my share ({formatMoney(payBase)})
              </button>
              <button
                type="button"
                onClick={() => setPayMode("full")}
                className={`btn !text-xs ${payMode === "full" ? "btn-primary" : "btn-soft"}`}
              >
                Pay full remaining ({formatMoney(remainingDue)})
              </button>
            </div>
          )}

          {/* Tip Presets */}
          <div>
            <p className="label">Add a tip</p>
            <div className="grid grid-cols-4 gap-2">
              {tipPresets.map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setTipPercent(pct)}
                  className={`btn !px-2 !text-xs ${tipPercent === pct ? "btn-primary" : "btn-soft"}`}
                >
                  {pct === 0 ? "No tip" : `${pct}%`}
                </button>
              ))}
            </div>
          </div>

          {/* Payment Method */}
          <div>
            <p className="label">Payment method</p>
            <div className="grid grid-cols-2 gap-2">
              {tenders.map((tender) => (
                <button
                  key={tender.id}
                  type="button"
                  onClick={() => setMethod(tender.id)}
                  className={`btn ${method === tender.id ? "btn-primary" : "btn-soft"}`}
                >
                  <span aria-hidden="true">{tender.icon}</span>
                  {tender.label}
                </button>
              ))}
            </div>
          </div>

          {paymentQr && ["wallet", "esewa", "khalti"].includes(method) && (
            <div className="flex items-center gap-4 rounded-xl border border-rule p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={paymentQr} alt="Wallet payment QR" className="size-24 shrink-0" />
              <div>
                <p className="text-sm font-extrabold text-ink">Scan with your wallet</p>
                <p className="mt-1 text-xs text-ink-soft">
                  Paying {formatMoney(payBase)}
                  {tipAmount > 0 ? ` + ${formatMoney(tipAmount)} tip` : ""} out of {formatMoney(totalBill)}.
                </p>
              </div>
            </div>
          )}

          {(payMode === "full" || splitWays === 1) && (
            <div>
              <p className="label">Email PAID receipt (optional)</p>
              <TextInput value={email} onChange={setEmail} placeholder="name@example.com" />
            </div>
          )}

          <p className={`flex items-start gap-2 rounded-xl px-3 py-2 text-xs ${demoMode ? "bg-warn-soft text-warn" : "bg-info-soft text-info"}`}>
            <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
            {demoMode
              ? "Demo payment: no real money is collected."
              : "Online payments are not available. Please ask staff to collect and verify payment at the counter."}
          </p>

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={!demoMode || busy || payBase <= 0}
            onClick={() => {
              setBusy(true);
              void api
                .post<GuestPayResult>(`guest/${token}/pay`, {
                  orderId: order.id,
                  method,
                  amount: payBase,
                  tip: tipAmount,
                  label:
                    splitWays > 1 && payMode === "share"
                      ? `${currentGuest?.name || "Guest"} · Split 1/${splitWays}`
                      : `${currentGuest?.name || tableLabel} · QR`,
                  guestId: currentGuest?.id ?? null,
                  guestName: currentGuest?.name ?? "",
                  email: email.trim(),
                })
                .then((result) => onPaid(result))
                .catch((error) => toast(errorMessage(error), "late"))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? <Spinner className="size-4" /> : <Icon name="wallet" className="size-5" />}
            {busy ? "Recording…" : `Pay · ${formatMoney(totalWithTip)}`}
          </Button>
        </div>
      )}
    </Modal>
  );
}

const REVIEW_TAGS = ["Great Food", "Fast Service", "Smooth QR", "Friendly Staff"];

export function GuestReceiptAndReview({
  token,
  data,
  result,
  currentGuest,
  existingReview,
  onDone,
}: {
  token: string;
  data: GuestOrderView;
  result: GuestPayResult;
  currentGuest: TableGuest | null;
  existingReview: GuestReviewInfo | null;
  onDone: () => void;
}) {
  const [email, setEmail] = useState(result.emailSent?.recipientEmail ?? "");
  const [emailSentTo, setEmailSentTo] = useState<string | null>(result.emailSent?.recipientEmail ?? null);
  const [sendingEmail, setSendingEmail] = useState(false);

  const [rating, setRating] = useState<number>(existingReview?.rating ?? 0);
  const [tags, setTags] = useState<string[]>(existingReview?.tags ?? []);
  const [comment, setComment] = useState(existingReview?.comment ?? "");
  const [reviewSaved, setReviewSaved] = useState(Boolean(existingReview));
  const [savingReview, setSavingReview] = useState(false);

  async function sendEmail() {
    if (!email.trim() || sendingEmail) return;
    setSendingEmail(true);
    try {
      const res = await api.post<{ recipientEmail: string }>(`guest/${token}/receipt-email`, {
        orderId: result.order.id,
        email: email.trim(),
      });
      setEmailSentTo(res.recipientEmail);
      toast(`Digital receipt sent to ${res.recipientEmail}`, "ok");
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setSendingEmail(false);
    }
  }

  async function submitRating(stars: number) {
    setRating(stars);
    setSavingReview(true);
    try {
      await api.post(`guest/${token}/review`, {
        orderId: result.order.id,
        rating: stars,
        tags,
        comment,
        guestName: currentGuest?.name ?? "",
      });
      setReviewSaved(true);
      toast(`Thank you for the ${stars}-star rating!`, "ok");
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setSavingReview(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper p-4">
      <div className="card w-full max-w-md overflow-hidden">
        <div className="bg-brand-500 px-6 py-7 text-center text-white">
          <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-white/20">
            <Icon name="check" className="size-8" />
          </span>
          <h1 className="mt-3 text-2xl font-black">
            {result.paidInFull ? "Thank you · PAID" : "Share paid"}
          </h1>
          <p className="mt-1 text-xs text-white/85">
            {result.paidInFull
              ? `Your digital receipt at ${data.restaurantName}`
              : `${formatMoney(result.remainingDue)} remaining on table check`}
          </p>
          {result.pointsEarned > 0 && (
            <span className="mt-2 inline-block rounded-full bg-white/20 px-3 py-1 text-xs font-extrabold">
              +{result.pointsEarned} loyalty points earned
            </span>
          )}
        </div>

        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-bold text-ink">Check #{result.order.checkNumber ?? "—"}</span>
            <Chip tone={result.paidInFull ? "ok" : "warn"}>{result.paidInFull ? "PAID" : "PARTIAL"}</Chip>
          </div>

          <dl className="tnum space-y-1.5 text-xs">
            {result.receipt.map((row, index) => (
              <div
                key={`${row.label}-${index}`}
                className={`flex justify-between gap-4 ${row.emphasis ? "border-t border-rule pt-2 text-sm font-black text-ink" : "text-ink-soft"}`}
              >
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>

          {/* Email digital receipt */}
          <div className="rounded-xl border border-rule bg-paper p-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Digital receipt via email</p>
            {emailSentTo ? (
              <p className="mt-1 text-xs font-bold text-ok">Sent to {emailSentTo} ✓</p>
            ) : (
              <div className="mt-2 flex gap-2">
                <TextInput value={email} onChange={setEmail} placeholder="you@example.com" className="flex-1" />
                <Button variant="soft" size="sm" disabled={sendingEmail || !email.trim()} onClick={() => void sendEmail()}>
                  {sendingEmail ? "Sending…" : "Email"}
                </Button>
              </div>
            )}
          </div>

          {/* 1-Tap 5-Star Rating */}
          {result.paidInFull && (
            <div className="rounded-xl border border-ember-200 bg-ember-50/50 p-4 text-center">
              <p className="text-sm font-black text-ink">How was your meal?</p>
              <p className="mt-0.5 text-xs text-ink-soft">Tap a star to rate your experience</p>

              <div className="mt-3 flex justify-center gap-2">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    disabled={savingReview}
                    aria-label={`${star} star${star === 1 ? "" : "s"}`}
                    onClick={() => void submitRating(star)}
                    className={`flex size-10 items-center justify-center rounded-xl text-xl transition-transform hover:scale-110 ${
                      star <= rating ? "bg-ember-500 text-white shadow-sm" : "border border-rule bg-paper-raised text-ink-faint"
                    }`}
                  >
                    ★
                  </button>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {REVIEW_TAGS.map((tag) => {
                  const active = tags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() =>
                        setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
                      }
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                        active ? "border-ember-500 bg-ember-500 text-white" : "border-rule bg-paper-raised text-ink-soft"
                      }`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>

              {rating > 0 && (
                <div className="mt-2.5 flex gap-2">
                  <TextInput value={comment} onChange={setComment} placeholder="Add a quick note (optional)" className="flex-1" />
                  <Button variant="soft" size="sm" disabled={savingReview} onClick={() => void submitRating(rating)}>
                    {reviewSaved ? "Update" : "Save"}
                  </Button>
                </div>
              )}
              {reviewSaved && <p className="mt-2 text-[11px] font-bold text-ok">Feedback recorded — thank you!</p>}
            </div>
          )}

          <Button variant="primary" size="lg" className="w-full" onClick={onDone}>
            Back to the menu
          </Button>
        </div>
      </div>
    </main>
  );
}
