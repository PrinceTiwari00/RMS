"use client";

import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Button, Chip, Icon, Modal, Spinner, TextInput, toast } from "@/components/ui";
import { formatMoney } from "@/domain/money";
import type {
  LoyaltyAccountInfo,
  OrderLine,
  OrderSnapshot,
  QuizMatchView,
  Settings,
  TableGuest,
  TableSessionInfo,
} from "@/types";

export function WaitEngagementHub({
  token,
  tableLabel,
  order,
  stage,
  settings,
  session,
  currentGuest,
  estimatedRemainingSeconds,
  estimatedTotalSeconds,
  paidAmount,
  remainingDue,
  onPay,
  onRefresh,
  refreshing,
  quizRefreshNonce,
}: {
  token: string;
  tableLabel: string;
  order: OrderSnapshot;
  stage: string;
  settings: Settings;
  session: TableSessionInfo | null;
  currentGuest: TableGuest | null;
  estimatedRemainingSeconds: number;
  estimatedTotalSeconds: number;
  paidAmount: number;
  remainingDue: number;
  onPay: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  quizRefreshNonce: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(estimatedRemainingSeconds);
  const [wifiOpen, setWifiOpen] = useState(false);
  const [rewardsOpen, setRewardsOpen] = useState(false);
  const [gamesOpen, setGamesOpen] = useState(false);

  useEffect(() => {
    setSecondsLeft(estimatedRemainingSeconds);
  }, [estimatedRemainingSeconds, order.id, order.status, order.approvalStatus]);

  useEffect(() => {
    if (order.status !== "sent" || order.allReady) return;
    const timer = window.setInterval(() => {
      setSecondsLeft((prev) => (prev > 1 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [order.status, order.allReady]);

  const isPendingStaff = order.approvalStatus === "pending_staff" && order.status === "open";
  const isReady = order.allReady && order.activeItems.length > 0;
  const readyCount = order.activeItems.filter((line) => line.kdsStatus === "READY").length;

  const progressRatio = useMemo(() => {
    if (isReady) return 1;
    if (!estimatedTotalSeconds || isPendingStaff) return 0.12;
    return Math.min(0.95, Math.max(0.15, 1 - secondsLeft / estimatedTotalSeconds));
  }, [isReady, isPendingStaff, secondsLeft, estimatedTotalSeconds]);

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  const circumference = 2 * Math.PI * 44;
  const dashOffset = circumference * (1 - progressRatio);

  const potentialPoints = Math.max(5, Math.floor((order.total / 10000) * settings.loyaltyPointsPer100));

  return (
    <section className="card mb-5 overflow-hidden border-brand-200 bg-paper-raised">
      {/* Top Ticket & Countdown Strip */}
      <div className="border-b border-rule bg-gradient-to-br from-ember-50/80 via-paper-raised to-brand-50/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-ink px-2.5 py-1 text-xs font-black tracking-wide text-white">
              {tableLabel} · #{order.checkNumber ?? "—"}
            </span>
            {isPendingStaff ? (
              <Chip tone="ok" dot>Sent to staff ✓</Chip>
            ) : isReady ? (
              <Chip tone="ok" dot>Ready at the pass</Chip>
            ) : (
              <Chip tone="ember" dot>Cooking</Chip>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              aria-label="Refresh order status"
              className="rounded-lg p-1.5 text-ink-soft hover:bg-paper-sunken"
            >
              <Icon name="refresh" className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
            <Button variant="primary" size="sm" onClick={onPay}>
              Pay · {formatMoney(remainingDue || order.total)}
            </Button>
          </div>
        </div>

        {/* Center Countdown & Stepper */}
        <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="relative flex size-24 shrink-0 items-center justify-center">
              <svg viewBox="0 0 100 100" className="size-full -rotate-90">
                <circle cx="50" cy="50" r="44" fill="none" stroke="var(--color-rule)" strokeWidth="7" />
                <circle
                  cx="50"
                  cy="50"
                  r="44"
                  fill="none"
                  stroke={isReady ? "var(--color-ok)" : "var(--color-ember-500)"}
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-all duration-700"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                {isReady ? (
                  <Icon name="check" className="size-7 text-ok" />
                ) : isPendingStaff ? (
                  <>
                    <Icon name="clock" className="size-5 text-brand-600" />
                    <span className="mt-0.5 text-[9px] font-black uppercase text-ink-faint">Queued</span>
                  </>
                ) : (
                  <>
                    <span className="tnum text-xl font-black leading-none text-ink">{mm}:{ss}</span>
                    <span className="mt-0.5 text-[9px] font-bold uppercase tracking-wider text-ink-faint">MIN LEFT</span>
                  </>
                )}
              </div>
            </div>

            <div>
              <h2 className="text-lg font-black leading-tight text-ink">
                {isPendingStaff
                  ? "Order placed · waiting for staff"
                  : isReady
                    ? "Your food is ready!"
                    : "Your food is cooking"}
              </h2>
              <p className="mt-1 text-xs text-ink-soft">
                {isPendingStaff
                  ? `${order.itemCount} items · ${formatMoney(order.total)} · Staff will fire to kitchen shortly`
                  : `${readyCount}/${order.activeItems.length} dishes ready · ${paidAmount > 0 ? `${formatMoney(paidAmount)} paid · ` : ""}${formatMoney(remainingDue)} due`}
              </p>

              {/* 3-step stepper */}
              <div className="mt-2.5 flex items-center gap-3 text-[11px] font-bold">
                <StepDot active label="Ordered" done={!isPendingStaff} />
                <span className="h-px w-4 bg-rule" />
                <StepDot active={stage === "cooking" || isReady} label="Cooking" done={isReady} />
                <span className="h-px w-4 bg-rule" />
                <StepDot active={isReady} label="Ready" done={isReady} />
              </div>
            </div>
          </div>
        </div>

        {/* 3 Retention Tools: WiFi · Rewards · Games */}
        <div className="mt-4 grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setWifiOpen(true)}
            className="flex flex-col items-center gap-1 rounded-xl border border-rule bg-paper-raised px-2 py-2.5 text-center transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-sm"
          >
            <span className="text-lg" aria-hidden="true">📶</span>
            <span className="text-xs font-extrabold text-ink">WiFi</span>
            <span className="truncate text-[10px] text-ink-faint">1-tap copy</span>
          </button>

          <button
            type="button"
            onClick={() => setRewardsOpen(true)}
            className="flex flex-col items-center gap-1 rounded-xl border border-rule bg-paper-raised px-2 py-2.5 text-center transition-all hover:-translate-y-0.5 hover:border-ember-300 hover:shadow-sm"
          >
            <span className="text-lg" aria-hidden="true">🎁</span>
            <span className="text-xs font-extrabold text-ink">Rewards</span>
            <span className="text-[10px] font-bold text-ember-600">+{potentialPoints} pts</span>
          </button>

          <button
            type="button"
            onClick={() => setGamesOpen(true)}
            className="flex flex-col items-center gap-1 rounded-xl border border-rule bg-paper-raised px-2 py-2.5 text-center transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-sm"
          >
            <span className="text-lg" aria-hidden="true">🎮</span>
            <span className="text-xs font-extrabold text-ink">Games</span>
            <span className="text-[10px] text-ink-faint">Spice Quiz</span>
          </button>
        </div>
      </div>

      {/* Expandable itemized check */}
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-bold text-ink-soft hover:bg-paper"
      >
        <span>
          {order.activeItems.length} item{order.activeItems.length === 1 ? "" : "s"} on this table check · {formatMoney(order.total)}
        </span>
        <span className="flex items-center gap-1">
          {expanded ? "Hide" : "View"} bill <Icon name="chevronDown" className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </span>
      </button>
      {expanded && (
        <div className="border-t border-rule px-4 py-2">
          <ul className="divide-y divide-rule">
            {order.activeItems.map((line) => (
              <GuestOrderLine key={line.id} line={line} pendingStaff={isPendingStaff} />
            ))}
          </ul>
          <dl className="tnum mt-2 space-y-1 border-t border-rule pt-2 text-xs">
            <div className="flex justify-between"><dt className="text-ink-faint">Subtotal</dt><dd className="font-bold">{formatMoney(order.subtotal)}</dd></div>
            {order.discount > 0 && <div className="flex justify-between text-ok"><dt>Pairing / Discount</dt><dd className="font-bold">− {formatMoney(order.discount)}</dd></div>}
            <div className="flex justify-between"><dt className="text-ink-faint">VAT</dt><dd className="font-bold">{formatMoney(order.vat)}</dd></div>
            {order.serviceCharge > 0 && <div className="flex justify-between"><dt className="text-ink-faint">Service charge</dt><dd className="font-bold">{formatMoney(order.serviceCharge)}</dd></div>}
          </dl>
        </div>
      )}

      <WifiModal open={wifiOpen} onClose={() => setWifiOpen(false)} ssid={settings.wifiSsid} password={settings.wifiPassword} />
      <RewardsModal
        open={rewardsOpen}
        onClose={() => setRewardsOpen(false)}
        token={token}
        settings={settings}
        currentGuest={currentGuest}
        potentialPoints={potentialPoints}
      />
      <SpiceQuizModal
        open={gamesOpen}
        onClose={() => setGamesOpen(false)}
        token={token}
        tableLabel={tableLabel}
        session={session}
        currentGuest={currentGuest}
        refreshNonce={quizRefreshNonce}
      />
    </section>
  );
}

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <span className={`flex items-center gap-1.5 ${done ? "text-ok" : active ? "text-ember-600" : "text-ink-faint"}`}>
      <span
        className={`size-2 rounded-full ${
          done ? "bg-ok" : active ? "animate-pulse bg-ember-500" : "bg-rule"
        }`}
      />
      {label}
    </span>
  );
}

function GuestOrderLine({ line, pendingStaff }: { line: OrderLine; pendingStaff: boolean }) {
  const label = pendingStaff
    ? "With staff"
    : line.kdsStatus === "READY"
      ? "Ready"
      : line.kdsStatus === "HOLD"
        ? "Queued"
        : "Cooking";
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="tnum text-xs font-black text-ink-faint">{line.quantity}×</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-bold text-ink">{line.name}</p>
        {line.modifiers.length > 0 && (
          <p className="truncate text-[10px] text-ink-faint">{line.modifiers.map((m) => m.name).join(", ")}</p>
        )}
      </div>
      <Chip tone={line.kdsStatus === "READY" ? "ok" : pendingStaff ? "neutral" : "info"}>{label}</Chip>
      <span className="tnum w-20 text-right text-xs font-bold">{formatMoney(line.lineTotal)}</span>
    </li>
  );
}

// ------------------------------------------------------------------ Wi-Fi Modal
function WifiModal({ open, onClose, ssid, password }: { open: boolean; onClose: () => void; ssid: string; password: string }) {
  const [copied, setCopied] = useState(false);

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(password);
    } catch {
      /* fallback below */
    }
    setCopied(true);
    toast("Wi-Fi password copied", "ok");
    window.setTimeout(() => setCopied(false), 2500);
  }

  return (
    <Modal open={open} onClose={onClose} title="Guest Wi-Fi" subtitle="Connect while you dine" width="max-w-sm">
      <div className="rounded-2xl border border-rule bg-paper p-5 text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-ember-50 text-2xl">📶</span>
        <p className="mt-3 text-[11px] font-bold uppercase tracking-widest text-ink-faint">FREE WIFI</p>
        <p className="mt-1 text-xl font-black text-ink">{ssid || "Guest_WiFi"}</p>

        <div className="mt-4 flex items-center justify-between rounded-xl border border-rule bg-paper-raised px-3.5 py-2.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">PASSWORD</span>
          <span className="font-mono text-sm font-black text-ink">{password || "welcome"}</span>
        </div>

        <Button
          variant={copied ? "primary" : "soft"}
          size="lg"
          className={`mt-4 w-full ${copied ? "!bg-ok !text-white" : ""}`}
          onClick={() => void copyPassword()}
        >
          {copied ? "Copied ✓" : "Copy password"}
        </Button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ Rewards Modal
function RewardsModal({
  open,
  onClose,
  token,
  settings,
  currentGuest,
  potentialPoints,
}: {
  open: boolean;
  onClose: () => void;
  token: string;
  settings: Settings;
  currentGuest: TableGuest | null;
  potentialPoints: number;
}) {
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [account, setAccount] = useState<LoyaltyAccountInfo | null>(null);
  const [busy, setBusy] = useState(false);

  async function linkAccount() {
    if ((!phone.trim() && !email.trim()) || busy) return;
    setBusy(true);
    try {
      const res = await api.post<LoyaltyAccountInfo>(`guest/${token}/loyalty`, {
        phone: phone.trim(),
        email: email.trim(),
        name: currentGuest?.name ?? "",
        guestId: currentGuest?.id ?? null,
      });
      setAccount(res);
      toast("Rewards linked to your table!", "ok");
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }

  async function redeem() {
    if (!account || busy) return;
    setBusy(true);
    try {
      const updated = await api.post<LoyaltyAccountInfo>(`guest/${token}/loyalty/redeem`, { accountId: account.id });
      setAccount(updated);
      toast(`Redeemed ${updated.rewardName}! Show your server.`, "ok");
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }

  const pts = account?.points ?? 0;
  const target = settings.loyaltyRewardPoints;
  const ratio = Math.min(1, (pts + potentialPoints) / target);
  const circ = 2 * Math.PI * 44;

  return (
    <Modal open={open} onClose={onClose} title={`${settings.restaurantName} Rewards`} subtitle="Every meal earns points" width="max-w-md">
      <div className="rounded-2xl bg-stage p-5 text-center text-stage-ink">
        <div className="relative mx-auto flex size-28 items-center justify-center">
          <svg viewBox="0 0 100 100" className="size-full -rotate-90">
            <circle cx="50" cy="50" r="44" fill="none" stroke="var(--color-stage-rule)" strokeWidth="8" />
            <circle
              cx="50"
              cy="50"
              r="44"
              fill="none"
              stroke="var(--color-ember-500)"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={circ * (1 - ratio)}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="tnum text-2xl font-black">{pts}</span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-stage-soft">POINTS</span>
          </div>
          <span className="absolute -right-1 top-1 rounded-full bg-ember-500 px-2 py-0.5 text-[11px] font-black text-white">
            +{potentialPoints}
          </span>
        </div>

        <div className="mt-4 rounded-xl border border-stage-rule bg-stage-card px-3.5 py-2.5 text-left">
          <p className="text-sm font-extrabold">{settings.loyaltyRewardName}</p>
          <p className="text-[11px] font-bold uppercase tracking-wider text-stage-soft">
            AT {target} POINTS · +{potentialPoints} PENDING THIS MEAL
          </p>
        </div>

        {account && account.points >= target && (
          <Button variant="primary" size="md" className="mt-3 w-full" disabled={busy} onClick={() => void redeem()}>
            Redeem {settings.loyaltyRewardName}
          </Button>
        )}
      </div>

      <div className="mt-4 space-y-2.5">
        <p className="text-xs font-bold text-ink-soft">
          {account ? `Linked as ${account.name || account.phone || account.email}` : "Enter phone or email to collect +points when you pay:"}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <TextInput value={phone} onChange={setPhone} placeholder="Phone number" />
          <TextInput value={email} onChange={setEmail} placeholder="Email address" />
        </div>
        <Button variant="primary" size="md" className="w-full" disabled={busy || (!phone.trim() && !email.trim())} onClick={() => void linkAccount()}>
          {busy ? <Spinner className="size-4" /> : null}
          {account ? "Update rewards profile" : "Link & collect points"}
        </Button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ Spice Quiz Modal
function SpiceQuizModal({
  open,
  onClose,
  token,
  tableLabel,
  session,
  currentGuest,
  refreshNonce,
}: {
  open: boolean;
  onClose: () => void;
  token: string;
  tableLabel: string;
  session: TableSessionInfo | null;
  currentGuest: TableGuest | null;
  refreshNonce: number;
}) {
  const [mode, setMode] = useState<"in_table" | "table_vs_table">("in_table");
  const [match, setMatch] = useState<QuizMatchView | null>(null);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadQuiz() {
    try {
      const qs = match?.id ? `?matchId=${match.id}${participantId ? `&participantId=${participantId}` : ""}` : "";
      const res = await api.get<{ match: QuizMatchView | null }>(`guest/${token}/quiz${qs}`);
      if (res.match) setMatch(res.match);
    } catch {
      /* ignore transient */
    }
  }

  useEffect(() => {
    if (!open) return;
    void loadQuiz();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, quizRefreshNonceOr(refreshNonce)]);

  function quizRefreshNonceOr(n: number) {
    return n;
  }

  async function join(nextMode: "in_table" | "table_vs_table", forceNew = false) {
    setBusy(true);
    setMode(nextMode);
    try {
      const res = await api.post<{ match: QuizMatchView; participantId: string }>(`guest/${token}/quiz/join`, {
        mode: nextMode,
        guestId: currentGuest?.id ?? null,
        displayName: currentGuest?.name || session?.guests[0]?.name || `${tableLabel} Player`,
        avatarColor: currentGuest?.color ?? "#e85a2a",
        forceNew,
      });
      setMatch(res.match);
      setParticipantId(res.participantId);
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }

  async function answer(index: number) {
    if (!match || !participantId || busy) return;
    setBusy(true);
    try {
      const res = await api.post<{ match: QuizMatchView; isCorrect: boolean }>(`guest/${token}/quiz/answer`, {
        matchId: match.id,
        participantId,
        roundNumber: match.currentRound,
        selectedIndex: index,
      });
      setMatch(res.match);
      toast(res.isCorrect ? "Spot on! +1 point" : "Nice try!", res.isCorrect ? "ok" : "neutral");
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }

  async function nextRound() {
    if (!match || busy) return;
    setBusy(true);
    try {
      const res = await api.post<{ match: QuizMatchView }>(`guest/${token}/quiz/next`, {
        matchId: match.id,
        participantId,
      });
      setMatch(res.match);
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }

  const me = match?.participants.find((p) => p.id === participantId);

  return (
    <Modal open={open} onClose={onClose} title="Spice Quiz" subtitle="Play while your food cooks" width="max-w-md">
      <div className="rounded-2xl bg-stage p-4 text-stage-ink">
        {/* Mode Switcher */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void join("in_table", true)}
            className={`rounded-xl px-3 py-2 text-xs font-extrabold transition-colors ${
              mode === "in_table" ? "bg-ember-500 text-white" : "border border-stage-rule bg-stage-card text-stage-soft"
            }`}
          >
            In-Table ({tableLabel})
          </button>
          <button
            type="button"
            onClick={() => void join("table_vs_table", true)}
            className={`rounded-xl px-3 py-2 text-xs font-extrabold transition-colors ${
              mode === "table_vs_table" ? "bg-ember-500 text-white" : "border border-stage-rule bg-stage-card text-stage-soft"
            }`}
          >
            Table vs Table · LIVE
          </button>
        </div>

        {!match || !participantId ? (
          <div className="py-8 text-center">
            <p className="text-sm font-bold text-stage-soft">Challenge your tablemates or nearby tables in 5 quick rounds!</p>
            <Button variant="primary" size="lg" className="mt-4" disabled={busy} onClick={() => void join(mode)}>
              {busy ? <Spinner className="size-4" /> : null}
              Start / Join Match
            </Button>
          </div>
        ) : (
          <div className="mt-4">
            <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-stage-soft">
              <span>
                {match.mode === "table_vs_table" ? "TABLE vs TABLE · LIVE" : `${tableLabel} · ROUND ${match.currentRound}/${match.totalRounds}`}
              </span>
              {match.status === "finished" && <Chip tone="ok">Finished</Chip>}
            </div>

            {/* Scoreboard */}
            {match.mode === "table_vs_table" ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {match.tableScores.slice(0, 2).map((ts, idx) => (
                  <div
                    key={ts.tableId}
                    className={`rounded-xl border p-3 text-center ${
                      idx === 0 ? "border-ember-500 bg-stage-card" : "border-stage-rule bg-stage-raised"
                    }`}
                  >
                    <p className="text-xs font-bold text-stage-soft">{ts.tableLabel}</p>
                    <p className="tnum mt-1 text-2xl font-black">{ts.score}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {match.participants.map((p) => (
                  <div key={p.id} className="rounded-xl border border-stage-rule bg-stage-card p-3 text-center">
                    <span
                      className="mx-auto flex size-8 items-center justify-center rounded-full text-xs font-black text-white"
                      style={{ background: p.avatarColor }}
                    >
                      {p.displayName.slice(0, 1).toUpperCase()}
                    </span>
                    <p className="mt-1 truncate text-xs font-bold">{p.displayName}</p>
                    <p className="tnum mt-0.5 text-2xl font-black">{p.score}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Active Question */}
            {match.question && (
              <div className="mt-4 rounded-xl border border-stage-rule bg-stage-card p-3.5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-ember-400">{match.question.category}</p>
                <p className="mt-1 text-sm font-extrabold leading-snug">{match.question.question}</p>
                <div className="mt-3 grid gap-2">
                  {match.question.options.map((opt, idx) => {
                    const revealed = match.question?.correctIndex !== undefined;
                    const isRight = match.question?.correctIndex === idx;
                    return (
                      <button
                        key={opt}
                        type="button"
                        disabled={busy || Boolean(me?.answeredCurrentRound)}
                        onClick={() => void answer(idx)}
                        className={`rounded-xl border px-3 py-2 text-left text-xs font-bold transition-colors ${
                          revealed && isRight
                            ? "border-ok bg-ok/20 text-white"
                            : "border-stage-rule bg-stage-raised text-stage-ink hover:border-ember-400"
                        }`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
                {me?.answeredCurrentRound && (
                  <Button variant="primary" size="sm" className="mt-3 w-full" disabled={busy} onClick={() => void nextRound()}>
                    {match.currentRound >= match.totalRounds ? "Finish quiz" : "Next round →"}
                  </Button>
                )}
              </div>
            )}

            {match.status === "finished" && (
              <div className="mt-4 text-center">
                <p className="text-sm font-black text-white">Game complete!</p>
                <Button variant="primary" size="sm" className="mt-3" onClick={() => void join(mode, true)}>
                  Play again
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
