"use client";

/**
 * Screen 8 — Expo / Master KDS.
 *
 * The pass is the only place in the kitchen that sees a ticket whole. Each
 * station knows its own items; the expeditor has to answer "can this table eat
 * yet?" So every card here shows the whole order with a completion bar per
 * station, and the bump button only arms when every line is ready.
 *
 * Bumping is destructive to the kitchen's view (the ticket leaves every rail),
 * so a recall sits right beside it for the runner who brings a plate back.
 */
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { api, errorMessage } from "@/lib/api";
import { usePoll, useStore, useTicker } from "@/lib/store";
import { Icon, toast } from "@/components/ui";
import { COURSE_LABEL } from "@/domain/kds";
import type { ExpoStationBreakdown, ExpoTicket, KdsMetrics } from "@/types";

interface ExpoResponse {
  tickets: ExpoTicket[];
  stations: KdsMetrics["byStation"];
  metrics: KdsMetrics;
}

export default function ExpoBoard() {
  const { allowed } = useStore();
  useTicker(10000);

  const canBump = allowed("kds.bump");
  const canReady = allowed("kds.ready");
  const { data } = usePoll<ExpoResponse>("kds-expo/board", { interval: 2000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [showBumped, setShowBumped] = useState(true);

  const tickets = data?.tickets ?? [];
  const metrics = data?.metrics;

  const readyToBump = useMemo(() => tickets.filter((ticket) => ticket.canBump), [tickets]);
  const working = useMemo(() => tickets.filter((ticket) => !ticket.canBump && !ticket.bumped), [tickets]);
  const bumped = useMemo(() => tickets.filter((ticket) => ticket.bumped), [tickets]);

  const act = useCallback(async (orderId: string, path: string, message: string, tone: "ok" | "neutral" = "ok") => {
    setBusy(orderId);
    try {
      await api.post(path, {});
      toast(message, tone);
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-stage text-stage-ink">
      {/* ---------------------------------------------------------------- header */}
      <header className="border-b border-stage-rule bg-stage-raised px-3 py-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-black uppercase tracking-wide">Expo · The Pass</h1>

          <div className="flex flex-wrap items-center gap-2">
            <Counter label="On the pass" value={metrics?.activeTickets ?? 0} />
            <Counter label="Ready to bump" value={metrics?.readyToBump ?? 0} tone="var(--color-ok)" />
            <Counter
              label="Late"
              value={metrics?.lateTickets ?? 0}
              tone={(metrics?.lateTickets ?? 0) > 0 ? "var(--color-late)" : undefined}
            />
            <Counter label="Avg age" value={`${Math.round(metrics?.averageTicketMinutes ?? 0)}m`} />
          </div>

          <label className="ml-auto flex cursor-pointer items-center gap-2 text-[12px] font-bold text-stage-soft">
            <input
              type="checkbox"
              checked={showBumped}
              onChange={(event) => setShowBumped(event.target.checked)}
              className="size-4 accent-[var(--color-ok)]"
            />
            Show bumped
          </label>
        </div>

        {/* Station load strip — where the bottleneck is, at a glance. */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(data?.stations ?? []).map((entry) => {
            const outstanding = entry.pending + entry.hold;
            const blocked = entry.oldestMinutes > 15;
            return (
              <Link
                key={entry.station.id}
                href={`/kds/${entry.station.id}`}
                className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors hover:brightness-125"
                style={{
                  borderColor: entry.station.color,
                  background: blocked
                    ? "color-mix(in srgb, var(--color-late) 18%, var(--color-stage-card))"
                    : "var(--color-stage-card)",
                }}
                title={`Open the ${entry.station.name} board`}
              >
                <span className="size-2.5 rounded-full" style={{ background: entry.station.color }} />
                <span className="text-[11px] font-black uppercase tracking-wide">{entry.station.name}</span>
                <span className="tnum text-[11px] font-bold text-stage-soft">
                  {outstanding} out · {entry.ready} ready
                </span>
                {entry.oldestMinutes > 0 && (
                  <span
                    className="tnum text-[11px] font-black"
                    style={{ color: blocked ? "var(--color-late)" : entry.oldestMinutes > 8 ? "var(--color-warn)" : "var(--color-stage-soft)" }}
                  >
                    {entry.oldestMinutes}m
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </header>

      {/* ------------------------------------------------------------------ rail */}
      <main className="scroll-y flex-1 p-3">
        {tickets.length === 0 && (
          <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center">
            <span className="flex size-20 items-center justify-center rounded-full bg-stage-card text-stage-soft">
              <Icon name="expo" className="size-10" />
            </span>
            <p className="text-2xl font-black uppercase tracking-wide">Nothing on the pass</p>
            <p className="max-w-md text-sm text-stage-soft">
              Every sent ticket is out. New orders land here the moment a server fires them to the kitchen.
            </p>
          </div>
        )}

        {readyToBump.length > 0 && (
          <Section title="Ready to bump" count={readyToBump.length} tone="var(--color-ok)">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {readyToBump.map((ticket) => (
                <ExpoCard
                  key={ticket.orderId}
                  ticket={ticket}
                  canBump={canBump}
                  canReady={canReady}
                  busy={busy === ticket.orderId}
                  onBump={() => void act(ticket.orderId, `kds/orders/${ticket.orderId}/bump`, `Ticket ${ticket.tableLabel} bumped`, "ok")}
                  onRecall={() => void act(ticket.orderId, `kds/orders/${ticket.orderId}/recall`, `Ticket recalled to the rail`, "neutral")}
                  onReadyAll={() =>
                    void act(ticket.orderId, `kds/orders/${ticket.orderId}/ready-all`, `Every item marked ready`, "ok")
                  }
                />
              ))}
            </div>
          </Section>
        )}

        {working.length > 0 && (
          <Section title="In progress" count={working.length}>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {working.map((ticket) => (
                <ExpoCard
                  key={ticket.orderId}
                  ticket={ticket}
                  canBump={canBump}
                  canReady={canReady}
                  busy={busy === ticket.orderId}
                  onBump={() => void act(ticket.orderId, `kds/orders/${ticket.orderId}/bump`, `Ticket ${ticket.tableLabel} bumped`, "ok")}
                  onRecall={() => void act(ticket.orderId, `kds/orders/${ticket.orderId}/recall`, `Ticket recalled to the rail`, "neutral")}
                  onReadyAll={() => void act(ticket.orderId, `kds/orders/${ticket.orderId}/ready-all`, `Every item marked ready`, "ok")}
                />
              ))}
            </div>
          </Section>
        )}

        {showBumped && bumped.length > 0 && (
          <Section title="Bumped — left the pass" count={bumped.length} tone="var(--color-stage-soft)">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {bumped.map((ticket) => (
                <ExpoCard
                  key={ticket.orderId}
                  ticket={ticket}
                  canBump={canBump}
                  canReady={canReady}
                  busy={busy === ticket.orderId}
                  onBump={() => void act(ticket.orderId, `kds/orders/${ticket.orderId}/bump`, `Ticket bumped`, "ok")}
                  onRecall={() => void act(ticket.orderId, `kds/orders/${ticket.orderId}/recall`, `Ticket recalled to the rail`, "neutral")}
                  onReadyAll={() => void act(ticket.orderId, `kds/orders/${ticket.orderId}/ready-all`, `Every item marked ready`, "ok")}
                />
              ))}
            </div>
          </Section>
        )}
      </main>
    </div>
  );
}

function Section({
  title,
  count,
  tone = "var(--color-stage-ink)",
  children,
}: {
  title: string;
  count: number;
  tone?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4">
      <h2 className="mb-2 flex items-center gap-2 text-[13px] font-black uppercase tracking-[0.09em]" style={{ color: tone }}>
        {title}
        <span className="tnum rounded-full bg-stage-card px-2 py-0.5 text-[11px]">{count}</span>
      </h2>
      {children}
    </section>
  );
}

function Counter({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-lg border border-stage-rule bg-stage-card px-2.5 py-1 text-center">
      <p className="tnum text-base font-black leading-none" style={{ color: tone ?? "var(--color-stage-ink)" }}>
        {value}
      </p>
      <p className="text-[9px] font-bold uppercase tracking-[0.08em] text-stage-soft">{label}</p>
    </div>
  );
}

function ExpoCard({
  ticket,
  canBump,
  canReady,
  busy,
  onBump,
  onRecall,
  onReadyAll,
}: {
  ticket: ExpoTicket;
  canBump: boolean;
  canReady: boolean;
  busy: boolean;
  onBump: () => void;
  onRecall: () => void;
  onReadyAll: () => void;
}) {
  const late = ticket.urgency === "late";
  const warn = ticket.urgency === "warn";
  const outstanding = ticket.lines.filter((line) => line.kdsStatus !== "READY");

  return (
    <article
      className={`stage-card urg-${ticket.urgency} flex flex-col overflow-hidden`}
      style={ticket.bumped ? { opacity: 0.62 } : undefined}
    >
      <header className="flex items-start gap-2 border-b border-stage-rule px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xl font-black leading-tight">
            {ticket.tableLabel || ticket.channel.replace("_", " ")}
            <span className="tnum ml-2 text-sm font-bold text-stage-soft">#{ticket.checkNumber ?? "—"}</span>
            {ticket.firedAt && (
              <span className="ml-2 rounded bg-ember-500 px-1.5 py-0.5 text-[10px] font-black uppercase text-white">
                Fired
              </span>
            )}
          </p>
          <p className="truncate text-[11px] font-semibold text-stage-soft">
            {ticket.serverName || "Unassigned"}
            {ticket.guests > 0 && ` · ${ticket.guests} guests`}
            {ticket.seats.length > 0 && ` · seats ${ticket.seats.join(", ")}`}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p
            className="tnum text-2xl font-black leading-none"
            style={{ color: late ? "var(--color-late)" : warn ? "var(--color-warn)" : "var(--color-stage-ink)" }}
          >
            {ticket.minutesElapsed}
            <span className="text-sm">m</span>
          </p>
          {ticket.bumped && <p className="text-[9px] font-black uppercase text-ok">bumped</p>}
        </div>
      </header>

      {ticket.note && (
        <p className="border-b border-stage-rule bg-warn/12 px-3 py-1.5 text-[12px] font-bold italic text-warn">
          “{ticket.note}”
        </p>
      )}

      {/* Per-station completion — the expeditor's core signal. */}
      <div className="flex flex-wrap gap-1.5 border-b border-stage-rule px-3 py-2">
        {ticket.stationBreakdown.map((entry: ExpoStationBreakdown) => (
          <span
            key={entry.station}
            className="flex items-center gap-1.5 rounded-md border px-2 py-1"
            style={{
              borderColor: entry.color,
              background: entry.complete ? "color-mix(in srgb, var(--color-ok) 20%, transparent)" : "transparent",
            }}
            title={`${entry.name}: ${entry.ready} of ${entry.total} ready`}
          >
            <span className="size-2 rounded-full" style={{ background: entry.color }} />
            <span className="text-[10px] font-black uppercase tracking-wide">{entry.name}</span>
            <span className="tnum text-[10px] font-bold text-stage-soft">
              {entry.ready}/{entry.total}
            </span>
            {entry.complete && <Icon name="check" className="size-3 text-ok" />}
          </span>
        ))}
      </div>

      <ul className="flex-1 divide-y divide-stage-rule">
        {ticket.lines.map((line) => (
          <li
            key={line.id}
            className="flex items-start gap-2 px-3 py-1.5"
            style={{
              background:
                line.kdsStatus === "READY" ? "color-mix(in srgb, var(--color-ok) 12%, transparent)" : "transparent",
            }}
          >
            <span
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-black"
              style={{
                background: line.kdsStatus === "READY" ? "var(--color-ok)" : "var(--color-stage-raised)",
                color: line.kdsStatus === "READY" ? "#fff" : "var(--color-stage-soft)",
              }}
            >
              {line.kdsStatus === "READY" ? <Icon name="check" className="size-3" /> : line.quantity}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className="block truncate text-[13px] font-bold leading-tight"
                style={{ textDecoration: line.kdsStatus === "READY" ? "line-through" : undefined }}
              >
                {line.name}
                {line.modifiers.length > 0 && (
                  <span className="ml-1 text-[11px] font-semibold text-warn">
                    {line.modifiers.map((modifier) => modifier.name).join(", ")}
                  </span>
                )}
              </span>
              {line.note && <span className="block truncate text-[11px] italic text-stage-soft">“{line.note}”</span>}
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-[9px] font-black uppercase tracking-wide text-stage-soft">
                {COURSE_LABEL[line.course] ?? line.course}
              </span>
              <span className="tnum block text-[9px] text-stage-soft">{line.minutesElapsed}m</span>
            </span>
          </li>
        ))}
      </ul>

      <footer className="flex items-center gap-2 border-t border-stage-rule bg-stage-raised px-3 py-2">
        {ticket.bumped ? (
          canBump ? (
            <button type="button" onClick={onRecall} disabled={busy} className="stage-btn w-full !py-2.5 !text-[13px] disabled:opacity-50">
              <Icon name="refresh" className="size-4" />
              Recall to the rail
            </button>
          ) : (
            <p className="w-full text-center text-[12px] font-bold uppercase text-stage-soft">Bumped</p>
          )
        ) : ticket.canBump ? (
          canBump ? (
            <button
              type="button"
              onClick={onBump}
              disabled={busy}
              className="stage-btn stage-btn-go w-full !py-3 !text-base disabled:opacity-50"
            >
              <Icon name="check" className="size-5" />
              BUMP — all {ticket.lines.length} ready
            </button>
          ) : (
            <p className="w-full text-center text-[12px] font-black uppercase text-ok">Ready to bump</p>
          )
        ) : (
          <>
            <p className="tnum flex-1 text-[12px] font-bold text-stage-soft">
              {outstanding.length} of {ticket.lines.length} still working
            </p>
            {canReady && outstanding.length > 0 && (
              <button type="button" onClick={onReadyAll} disabled={busy} className="stage-btn !px-3 !py-2 !text-[12px] disabled:opacity-50">
                Mark all ready
              </button>
            )}
          </>
        )}
      </footer>
    </article>
  );
}
